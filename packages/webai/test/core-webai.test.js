import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BOOT_TAG, createWebai } from '../src/core.js';
import { createBridgeHandler } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-core-'));
const quiet = { info() {}, warn() {}, error() {} };

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => (server.closeAllConnections(), server.close()) };
}

function get(port, url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: url, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('core: serves client.js and boot.js, API behind the token, the rest goes to next', async () => {
  const core = createWebai({ root: tmp() });
  const s = await listen((req, res) => core.middleware(req, res, () => res.writeHead(404, { 'x-next': '1' }).end()));
  try {
    const client = await get(s.port, '/__webai/client.js');
    assert.equal(client.status, 200);
    assert.match(client.headers['content-type'], /javascript/);
    assert.equal(client.headers['cache-control'], 'no-store');
    assert.ok(client.body.length > 100);

    const boot = await get(s.port, '/__webai/boot.js');
    assert.equal(boot.status, 200);
    assert.ok(boot.body.includes(core.token) && boot.body.includes("/__webai/client.js"));
    assert.deepEqual(core.client.triggers, ['shift-click']);
    assert.equal(core.client.fab, true);
    assert.equal(core.client.reload, false);

    assert.equal((await get(s.port, '/__webai/boot.js', { host: 'evil.example' })).status, 403);
    assert.equal((await get(s.port, '/__webai/state')).status, 403);
    assert.equal((await get(s.port, '/__webai/state', { 'x-webai-token': core.token })).status, 200);
    assert.equal((await get(s.port, '/page')).headers['x-next'], '1');
    // not a GET: falls through to the API (and its token check)
    assert.equal((await get(s.port, '/__webai/boot.js', {}, 'POST')).status, 403);
  } finally {
    s.close();
    core.dispose();
  }
});

test('core: boot.js honours trustProxy and options end up in the client config', async () => {
  const core = createWebai({ root: tmp(), trustProxy: true, triggers: ['click'], fab: false, reload: true, stateDir: '.st', logger: quiet });
  const s = await listen((req, res) => core.middleware(req, res, () => res.end()));
  try {
    assert.deepEqual([core.client.triggers, core.client.fab, core.client.reload], [['click'], false, true]);
    const r = await get(s.port, '/__webai/boot.js', { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '127.0.0.1' });
    assert.equal(r.status, 200);
  } finally {
    s.close();
    core.dispose();
  }
});

test('core: injector adds the boot tag to HTML pages', async () => {
  const core = createWebai({ root: tmp(), logger: quiet });
  const s = await listen((req, res) => core.injector(req, res, () => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>hi</body></html>');
  }));
  try {
    const r = await get(s.port, '/', { accept: 'text/html' });
    assert.equal(r.body, `<html><body>hi${BOOT_TAG}</body></html>`);
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
  } finally {
    s.close();
    core.dispose();
  }
});

test('core: allowRemote makes "Other" read-only; logger can be swapped, error falls back to warn', () => {
  const core = createWebai({ root: tmp(), allowRemote: true, custom: { editable: true, command: 'echo' } });
  try {
    assert.equal(core.session.agents.custom.settings.command.readonly, true);
    const seen = [];
    core.setLogger({ info: (m) => seen.push(['info', m]), warn: (m) => seen.push(['warn', m]) });
    const log = core.session.logger;
    log.info('a');
    log.warn('b');
    log.error('c');
    assert.deepEqual(seen, [['info', 'a'], ['warn', 'b'], ['warn', 'c']]);
    core.setLogger({ info() {}, warn() {}, error: (m) => seen.push(['error', m]) });
    log.error('d');
    assert.deepEqual(seen.at(-1), ['error', 'd']);
  } finally {
    core.dispose();
  }
});

test('core: ready() detects agents (no bridge)', async () => {
  const core = createWebai({ root: tmp(), logger: quiet, triggers: ['shift-click', 'alt-click'] });
  try {
    const line = await core.ready();
    assert.match(line, /^AI overlay active: shift-click \/ alt-click on a page element\. Agents: /);
  } finally {
    core.dispose();
  }
});

test('core: bridge mode (option and WEBAI_BRIDGE), ready() with a running and a missing bridge', async (t) => {
  const bridgeServer = await listen(createBridgeHandler({}, 'tok', () => 'claude 1.0, codex 2.0'));
  const url = `http://127.0.0.1:${bridgeServer.port}`;
  const root = tmp();
  const core = createWebai({ root, bridge: url, logger: quiet });
  const prev = process.env.WEBAI_BRIDGE;
  try {
    assert.equal(core.session, null);
    assert.equal(await core.ready(), `AI overlay active: shift-click on a page element. Agents via bridge ${url}: claude 1.0, codex 2.0.`);
    // the API goes through the proxy middleware: no bridge token file yet, so 502
    const s = await listen((req, res) => core.middleware(req, res, () => res.end()));
    const r = await get(s.port, '/__webai/state', { 'x-webai-token': core.token });
    s.close();
    assert.equal(r.status, 502);

    bridgeServer.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.match(await core.ready(), /which is not running yet/);

    process.env.WEBAI_BRIDGE = url;
    const viaEnv = createWebai({ root, logger: quiet });
    assert.equal(viaEnv.session, null);
    viaEnv.dispose(); // no session: nothing to dispose
  } finally {
    if (prev === undefined) delete process.env.WEBAI_BRIDGE;
    else process.env.WEBAI_BRIDGE = prev;
    core.dispose();
  }
});

test('core: options default to {} and root to the current directory', () => {
  const cwd = process.cwd();
  const dir = fs.realpathSync(tmp());
  process.chdir(dir);
  let core;
  try {
    core = createWebai();
    assert.equal(core.root, dir);
  } finally {
    process.chdir(cwd);
    core?.dispose();
  }
});
