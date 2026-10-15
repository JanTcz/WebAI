import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { DEFAULT_PORT, startSidecar, withWebai } from '../src/next/index.js';

const KEY = Symbol.for('@jantcz/webai/next');
const DEV = 'phase-development-server';

let opened = [];
afterEach(async () => {
  mock.restoreAll();
  const cached = globalThis[KEY];
  delete globalThis[KEY];
  const v = cached ? await cached.catch(() => null) : null;
  if (v) {
    v.webai.dispose();
    v.server.closeAllConnections();
    v.server.close();
  }
  opened = [];
});

const log = () => mock.method(console, 'log', () => {});
const request = (port, url) =>
  new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path: url, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });

test('outside next dev the config passes through untouched (object and function forms)', async () => {
  const cfg = { reactStrictMode: true };
  assert.equal(await withWebai(cfg)('phase-production-build', {}), cfg);
  assert.equal(await withWebai(async (phase, ctx) => ({ phase, ctx }))('phase-production-server', 7).then((c) => c.ctx), 7);
  assert.deepEqual(await withWebai()('phase-export', {}), {});
  assert.equal(globalThis[KEY], undefined);
  assert.equal(DEFAULT_PORT, 4399);
});

test('next dev: sidecar serves /__webai, anything else is 404; rewrites sent to it', async () => {
  log();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-next-'));
  const out = await withWebai({ a: 1 }, { port: 0, root })(DEV, {});
  assert.equal(out.a, 1);
  const { server } = await globalThis[KEY];
  const port = server.address().port;
  assert.equal(await request(port, '/other'), 404);
  assert.equal(await request(port, '/__webai/boot.js'), 200);
  assert.equal(console.log.mock.calls.length, 1);
  assert.match(console.log.mock.calls[0].arguments[0], /^\[webai\] /);

  const rewrites = await out.rewrites();
  assert.deepEqual(rewrites, [{ source: '/__webai/:path*', destination: 'http://127.0.0.1:0/__webai/:path*' }]);
  // the second call reuses the sidecar
  const again = await startSidecar(port + 1, {});
  assert.equal(again.server, server);
});

test('rewrites merge: array form, object form with and without beforeFiles, function config', async () => {
  log();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-next-'));
  const mine = [{ source: '/__webai/:path*', destination: 'http://127.0.0.1:0/__webai/:path*' }];
  const arr = await withWebai({ rewrites: async () => [{ source: '/a', destination: '/b' }] }, { port: 0, root })(DEV, {});
  assert.deepEqual(await arr.rewrites(), [...mine, { source: '/a', destination: '/b' }]);
  const objBefore = await withWebai(() => ({ rewrites: () => ({ beforeFiles: [{ source: '/x', destination: '/y' }], afterFiles: [1] }) }), { port: 0 })(DEV, {});
  assert.deepEqual(await objBefore.rewrites(), { beforeFiles: [...mine, { source: '/x', destination: '/y' }], afterFiles: [1] });
  const objNone = await withWebai({ rewrites: async () => ({ fallback: [2] }) }, { port: 0 })(DEV, {});
  assert.deepEqual(await objNone.rewrites(), { fallback: [2], beforeFiles: mine });
  const nullish = await withWebai({ rewrites: () => undefined }, { port: 0 })(DEV, {});
  assert.deepEqual(await nullish.rewrites(), mine);
});

test('sidecar: port already taken by another process leaves the overlay to it', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await startSidecar(blocker.address().port, {}), null);
    assert.equal(await globalThis[KEY], null);
  } finally {
    blocker.close();
  }
});

test('sidecar: other server errors reject', async () => {
  mock.method(http, 'createServer', () => {
    const s = new EventEmitter();
    s.listen = () => setImmediate(() => s.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })));
    return s;
  });
  await assert.rejects(startSidecar(1, {}), /denied/);
});

test('default sidecar port is 4399 (server faked, nothing is bound)', async () => {
  log();
  const listened = [];
  mock.method(http, 'createServer', () => ({
    once() {},
    unref() {},
    closeAllConnections() {},
    close() {},
    listen(port, host, cb) {
      listened.push([port, host]);
      setImmediate(cb);
    },
  }));
  const out = await withWebai({}, { root: fs.mkdtempSync(path.join(os.tmpdir(), 'webai-next-')) })(DEV, {});
  assert.deepEqual(listened, [[4399, '127.0.0.1']]);
  assert.match((await out.rewrites())[0].destination, /^http:\/\/127\.0\.0\.1:4399\/__webai\//);
});
