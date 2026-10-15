import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import webai from '../src/astro/index.js';
import { annotatePlugin } from '../src/astro/annotate.js';

const astroRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/astro');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-astro-')));
const logger = () => {
  const calls = [];
  return { calls, info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]) };
};

test('astro integration: nothing happens outside dev', async () => {
  const integration = webai();
  assert.equal(integration.name, '@jantcz/webai');
  const hooks = integration.hooks;
  let touched = false;
  const spy = () => (touched = true);
  hooks['astro:config:setup']({ command: 'build', config: { root: pathToFileURL(tmp() + '/') }, updateConfig: spy, injectScript: spy });
  const log = logger();
  await hooks['astro:server:setup']({ server: { middlewares: { use: spy } }, logger: log });
  hooks['astro:server:done']();
  assert.equal(touched, false);
  assert.deepEqual(log.calls, []);
});

test('astro integration: dev wires annotate plugin, client script, middleware, and disposes', async () => {
  const integration = webai({ allowRemote: false });
  const hooks = integration.hooks;
  const root = tmp();
  let update;
  const injected = [];
  hooks['astro:config:setup']({
    command: 'dev',
    config: { root: pathToFileURL(root + '/') },
    updateConfig: (u) => (update = u),
    injectScript: (stage, code) => injected.push([stage, code]),
  });
  assert.equal(update.vite.plugins[0].name, 'webai:astro-annotate');
  assert.equal(injected[0][0], 'page');
  assert.match(injected[0][1], /^import \{ start \} from '@jantcz\/webai\/client'; start\(\{.*\}\);$/);

  const used = [];
  const log = logger();
  await hooks['astro:server:setup']({ server: { middlewares: { use: (m) => used.push(m) } }, logger: log });
  assert.equal(used.length, 1);
  assert.equal(typeof used[0], 'function');
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][0], 'info');

  hooks['astro:server:done']();
  // after a restart (no new setup) nothing is left to set up or dispose
  const log2 = logger();
  await hooks['astro:server:setup']({ server: { middlewares: { use() { throw new Error('no'); } } }, logger: log2 });
  assert.deepEqual(log2.calls, []);
  hooks['astro:server:done']();
});

test('annotatePlugin: transform skips what is not a project .astro file', async () => {
  const plugin = annotatePlugin({ root: astroRoot });
  assert.equal(plugin.name, 'webai:astro-annotate');
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(plugin.transform.order, 'pre');
  const t = (code, id) => plugin.transform.handler.call({ warn() { throw new Error('unexpected'); } }, code, id);
  const dir = path.join(astroRoot, 'src/pages');
  assert.equal(await t('<p>x</p>', path.join(dir, 'a.astro?astro&type=style')), undefined);
  assert.equal(await t('<p>x</p>', path.join(dir, 'a.ts')), undefined);
  assert.equal(await t('<p>x</p>', '/p/node_modules/lib/a.astro'), undefined);
});

test('annotatePlugin: annotates, relative to root; nothing to annotate and parser errors leave the code alone', async () => {
  const plugin = annotatePlugin({ root: astroRoot });
  const t = (code, id) => plugin.transform.handler.call({ warn() { throw new Error('unexpected'); } }, code, id);
  const id = path.join(astroRoot, 'src/pages/x.astro');
  const out = await t('<main>\n  <h1>x</h1>\n</main>\n', id);
  assert.equal(out.map, null);
  assert.match(out.code, /<main data-webai-src="src\/pages\/x\.astro:1:1">/);
  assert.equal(await t('just text', id), undefined); // annotate() returns null
  assert.equal(await t(undefined, id), undefined); // the parser throws on a non-string
});

test('annotatePlugin: without Astro 7 compiler the plugin warns once and turns itself off', async () => {
  const plugin = annotatePlugin({ root: tmp() });
  const warnings = [];
  const ctx = { warn: (m) => warnings.push(m) };
  const id = '/x/src/a.astro';
  assert.equal(await plugin.transform.handler.call(ctx, '<p>x</p>', id), undefined);
  assert.equal(await plugin.transform.handler.call(ctx, '<p>x</p>', id), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /annotations disabled, cannot load parser/);
});
