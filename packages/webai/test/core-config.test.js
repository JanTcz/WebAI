import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startBridge } from '../src/bridge.js';
import { CONFIG_FILE, consoleLogger, loadConfig } from '../src/config.js';
import { BRIDGE_TOKEN_FILE } from '../src/server.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-cfg-')));
const collect = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
};

test('config: no file gives {}, a missing explicit config throws', async () => {
  const root = tmp();
  const log = collect();
  assert.deepEqual(await loadConfig(root, undefined, log), {});
  assert.deepEqual(log.lines, []);
  await assert.rejects(loadConfig(root, path.join(root, 'nope.mjs'), log), /does not exist/);
});

test('config: loads the default export from the project or an explicit path', async () => {
  const root = tmp();
  const log = collect();
  fs.writeFileSync(path.join(root, CONFIG_FILE), 'export default { stateDir: ".x" };');
  assert.deepEqual(await loadConfig(root, undefined, log), { stateDir: '.x' });
  assert.match(log.lines[0], /^Config: .*webai\.config\.mjs$/);

  const other = path.join(root, 'other.mjs');
  fs.writeFileSync(other, 'export const named = 1;');
  assert.deepEqual(await loadConfig(root, other, log), {}); // no default export
});

test('config: consoleLogger prefixes messages', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  consoleLogger.info('a');
  consoleLogger.warn('b');
  consoleLogger.error('c');
  assert.deepEqual(log.mock.calls[0].arguments, ['[webai] a']);
  assert.deepEqual(warn.mock.calls[0].arguments, ['[webai] b']);
  assert.deepEqual(error.mock.calls[0].arguments, ['[webai] c']);
});

function request(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path: url, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('bridge: starts with the config, writes a private token, serves health and the API, cleans up', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, CONFIG_FILE), 'export default { stateDir: ".st", custom: { command: "echo hi" }, claude: {} };');
  const log = collect();
  const bridge = await startBridge({ root, port: 0, logger: log });
  const port = bridge.server.address().port;
  const tokenFile = path.join(root, '.st', BRIDGE_TOKEN_FILE);
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.equal(token.length, 48);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    assert.ok(log.lines.some((l) => l.startsWith(`Bridge for ${root} on http://127.0.0.1:${bridge.server.address().port}. Agents:`)));
    assert.equal(bridge.session.agents.custom.settings.command.readonly, true);
    assert.equal(bridge.session.agents.claude.settings != null, true);

    assert.equal((await request(port, '/__webai/health')).status, 200);
    assert.equal((await request(port, '/__webai/state')).status, 403);
    assert.equal((await request(port, '/__webai/state', { 'x-webai-token': token })).status, 200);
  } finally {
    bridge.close();
  }
  assert.equal(fs.existsSync(tokenFile), false);
});

test('bridge: a second bridge on the same port fails without touching the first token; close keeps a foreign token', async () => {
  const root = tmp();
  const first = await startBridge({ root, port: 0, logger: collect() });
  const port = first.server.address().port;
  const tokenFile = path.join(root, '.webai', BRIDGE_TOKEN_FILE);
  try {
    const before = fs.readFileSync(tokenFile, 'utf8');
    await assert.rejects(startBridge({ root, port, logger: collect() }), /EADDRINUSE/);
    assert.equal(fs.readFileSync(tokenFile, 'utf8'), before);
    fs.writeFileSync(tokenFile, 'someone-else\n'); // another bridge took over
  } finally {
    first.close();
  }
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'someone-else\n');
  // token file gone already: close() must not throw
  const again = await startBridge({ root, port: 0, logger: collect() });
  fs.rmSync(tokenFile);
  again.close();
});

test('bridge: defaults for port, host and logger', async (t) => {
  t.mock.method(console, 'log', () => {});
  const root = tmp();
  let bridge;
  try {
    bridge = await startBridge({ root }); // default port 4400 may be taken on this machine
    assert.equal(bridge.server.address().port, 4400);
  } catch (err) {
    assert.equal(err.code, 'EADDRINUSE');
  } finally {
    bridge?.close();
  }
});
