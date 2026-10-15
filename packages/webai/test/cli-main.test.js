import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chain, DEFAULT_PORT, HELP, main, run } from '../src/cli.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-cli-'));
const quiet = () => {
  const lines = [];
  return { lines, logger: { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) } };
};
const get = (url, headers) =>
  new Promise((resolve, reject) => {
    http.get(url, { headers: { accept: 'text/html', ...headers }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });

test('--help prints the help and returns null', async () => {
  const printed = [];
  assert.equal(await main(['--help'], { print: (s) => printed.push(s) }), null);
  assert.equal(printed[0], HELP);
  assert.equal((await main(['-h'], { print() {} })), null);
  assert.equal(DEFAULT_PORT, 4300);
});

test('static folder mode: serves files with the overlay injected', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Hi</h1></body></html>');
  const { logger, lines } = quiet();
  const running = await main([dir, '--port', '0'], { logger });
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await get(running.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /__webai\/boot\.js/);
    const boot = await get(`${running.url}__webai/boot.js`);
    assert.equal(boot.status, 200);
    assert.ok(lines.some(([, m]) => m.includes(`${dir} on ${running.url}`)));
  } finally {
    running.close();
  }
});

test('static mode defaults to the current folder; config file and 0.0.0.0 host', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>x</p>');
  fs.writeFileSync(path.join(dir, 'webai.config.mjs'), 'export default { allowRemote: true };');
  const cwd = process.cwd();
  process.chdir(dir);
  let running;
  try {
    running = await main(['--port', '0', '--host', '0.0.0.0', '--allow-remote'], { logger: quiet().logger });
  } finally {
    process.chdir(cwd);
  }
  try {
    assert.match(running.url, /^http:\/\/localhost:\d+\/$/);
    assert.equal((await get(running.url)).status, 200);
  } finally {
    running.close();
  }
  // explicit --config without --allow-remote
  const cfg = path.join(tmp(), 'c.mjs');
  fs.writeFileSync(cfg, 'export default {};');
  const r2 = await main([dir, '--port', '0', '--config', cfg, '--root', dir], { logger: quiet().logger });
  r2.close();
});

test('errors: not a folder, missing config, port in use', async () => {
  const { logger } = quiet();
  await assert.rejects(main([path.join(tmp(), 'nope'), '--port', '0'], { logger }), /is not a folder/);
  const file = path.join(tmp(), 'f.txt');
  fs.writeFileSync(file, '');
  await assert.rejects(main([file], { logger }), /is not a folder/);
  await assert.rejects(main([tmp(), '--config', '/nonexistent/c.mjs'], { logger }), /does not exist/);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(main([tmp(), '--port', String(blocker.address().port)], { logger }), (e) => e.code === 'EADDRINUSE');
  } finally {
    blocker.close();
  }
});

test('--target proxy mode forwards requests and websocket upgrades', async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><body>upstream ${req.url}</body></html>`);
  });
  upstream.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const running = await main(['--target', target, '--port', '0', '--root', tmp()], { logger: quiet().logger });
  try {
    const page = await get(`${running.url}some/page`);
    assert.match(page.body, /upstream \/some\/page/);
    assert.match(page.body, /__webai\/boot\.js/);
    const port = running.server.address().port;
    const sock = net.connect(port, '127.0.0.1');
    sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    const head = await new Promise((resolve) => sock.once('data', (d) => resolve(String(d))));
    assert.match(head, /101/);
    sock.destroy();
  } finally {
    running.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('--open starts the platform opener (a dummy one from PATH)', async () => {
  const bin = tmp();
  const marker = path.join(bin, 'marker.txt');
  for (const name of ['open', 'xdg-open', 'explorer']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $1" >> "${marker}"\n`, { mode: 0o755 });
  }
  const oldPath = process.env.PATH;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  process.env.PATH = bin;
  try {
    for (const p of ['darwin', 'linux', 'win32']) {
      Object.defineProperty(process, 'platform', { value: p });
      const running = await main([tmp(), '--port', '0', '--open'], { logger: quiet().logger });
      running.close();
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env.PATH = oldPath;
  }
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
  // win32 'explorer' may not be spawnable as a shell script on every OS; the error is swallowed
  assert.ok(fs.existsSync(marker) || process.platform === 'win32');
});

test('bridge subcommand starts the bridge on the given port', async () => {
  const root = tmp();
  const { logger, lines } = quiet();
  const running = await main(['bridge', root, '--port', '0'], { logger });
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/); // the real port, not the requested 0
    assert.ok(fs.existsSync(path.join(root, '.webai', 'bridge-token')));
    assert.ok(lines.some(([, m]) => m.startsWith('Bridge for')));
  } finally {
    await running.close();
  }
  const root2 = tmp();
  const r2 = await main(['bridge', '--root', root2, '--port', '0'], { logger });
  await r2.close();
});

test('run(): signals close the server, errors are reported without a stack', async () => {
  const handlers = {};
  let exitCode;
  const { logger, lines } = quiet();
  const exit = (c) => { exitCode = c; };
  const running = await run([tmp(), '--port', '0'], { exit, onSignal: (s, f) => (handlers[s] = f), logger });
  assert.deepEqual(Object.keys(handlers), ['SIGINT', 'SIGTERM']);
  handlers.SIGINT();
  assert.equal(exitCode, 0);
  assert.ok(running.server);

  // --help: no server, the signal handler tolerates it
  const h2 = {};
  const none = await run(['--help'], { exit, onSignal: (s, f) => (h2[s] = f), logger });
  assert.equal(none, null);
  h2.SIGTERM();

  const bad = await run([path.join(tmp(), 'missing')], { exit, onSignal() {}, logger });
  assert.equal(bad, null);
  assert.equal(exitCode, 1);
  assert.match(lines.at(-1)[1], /is not a folder/);

  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    await run([tmp(), '--port', String(port)], { exit, onSignal() {}, logger });
    assert.equal(lines.at(-1)[1], `Port ${port} is in use. Choose another with --port.`);
  } finally {
    blocker.close();
  }
});

test('run() defaults: real process.exit/on are not touched until used', async () => {
  const before = process.listenerCount('SIGINT');
  const { logger } = quiet();
  const running = await run([tmp(), '--port', '0'], { logger });
  try {
    assert.equal(process.listenerCount('SIGINT'), before + 1);
  } finally {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    running.close();
  }
});

test('chain(): runs middlewares in order, then done; a middleware can stop it', () => {
  const order = [];
  chain([(q, s, next) => (order.push('a'), next()), (q, s, next) => (order.push('b'), next())], 1, 2, () => order.push('done'));
  assert.deepEqual(order, ['a', 'b', 'done']);
  const stopped = [];
  chain([(q, s) => stopped.push('only')], 1, 2, () => stopped.push('done'));
  assert.deepEqual(stopped, ['only']);
  chain([], 1, 2, () => stopped.push('empty'));
  assert.equal(stopped.at(-1), 'empty');
});

test('--open: a missing opener is not an error', async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = tmp();
  try {
    const running = await main([tmp(), '--port', '0', '--open'], { logger: quiet().logger });
    await new Promise((r) => setTimeout(r, 50));
    running.close();
  } finally {
    process.env.PATH = oldPath;
  }
});

test('defaults: current folder as root and the default ports (a taken port is fine here)', async () => {
  const cwd = process.cwd();
  const dir = tmp();
  process.chdir(dir);
  const { logger } = quiet();
  try {
    const upstream = await main(['--target', 'http://127.0.0.1:9', '--port', '0'], { logger });
    assert.ok(fs.existsSync(dir));
    upstream.close();
    for (const argv of [[]]) {
      try {
        const running = await main(argv, { logger });
        await running.close();
      } catch (err) {
        assert.equal(err.code, 'EADDRINUSE');
      }
    }
  } finally {
    process.chdir(cwd);
  }
});
