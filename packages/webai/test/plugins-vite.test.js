import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import webai from '../src/vite.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-vite-')));
const fakeLogger = () => {
  const calls = [];
  return { calls, info: (m, o) => calls.push(['info', m, o]), warn: (m, o) => calls.push(['warn', m, o]), error: (m, o) => calls.push(['error', m, o]) };
};

test('vite plugin: serve only, wires the overlay before Vite middlewares', async () => {
  const root = tmp();
  const plugin = webai({ allowRemote: true });
  assert.equal(plugin.name, '@jantcz/webai');
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.api.webai, null);
  const logger = fakeLogger();
  plugin.configResolved({ root, logger });
  const w = plugin.api.webai;
  assert.equal(w.root, root);

  // The session logs through Vite's logger, prefixed.
  w.session.logger.info('a');
  w.session.logger.warn('b');
  w.session.logger.error('c');
  assert.deepEqual(logger.calls, [
    ['info', '[webai] a', { timestamp: true }],
    ['warn', '[webai] b', { timestamp: true }],
    ['error', '[webai] c', { timestamp: true }],
  ]);

  const used = [];
  let onClose;
  const serverLogger = fakeLogger();
  plugin.configureServer({
    middlewares: { use: (m) => used.push(m) },
    config: { logger: serverLogger },
    httpServer: { once: (ev, fn) => ((onClose = fn), assert.equal(ev, 'close')) },
  });
  assert.deepEqual(used, [w.middleware, w.injector]);
  for (let i = 0; i < 200 && !serverLogger.calls.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.match(serverLogger.calls[0][1], /^\[webai\] AI overlay active: shift-click/);
  onClose();
  fs.rmSync(root, { recursive: true, force: true });
});

test('vite plugin: explicit root wins; no httpServer (middleware mode) is fine', () => {
  const [explicit, other] = [tmp(), tmp()];
  const plugin = webai({ root: explicit });
  plugin.configResolved({ root: other, logger: fakeLogger() });
  assert.equal(plugin.api.webai.root, explicit);
  plugin.configureServer({ middlewares: { use() {} }, config: { logger: fakeLogger() } });
  plugin.api.webai.dispose();
  const noArgs = webai();
  noArgs.configResolved({ root: other, logger: fakeLogger() });
  assert.equal(noArgs.api.webai.root, other);
  noArgs.api.webai.dispose();
  for (const d of [explicit, other]) fs.rmSync(d, { recursive: true, force: true });
});
