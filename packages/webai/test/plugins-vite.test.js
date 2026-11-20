import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import webai, { jsxRuntimeModule, leadingOffset } from '../src/vite.js';

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

test('vite plugin: React is pre-bundled up front only in a project that has it', () => {
  const plain = tmp();
  assert.equal(webai({ root: plain }).config({}), undefined);
  assert.equal(webai().config({ root: plain }), undefined);
  const cwd = process.cwd();
  try {
    process.chdir(plain);
    assert.equal(webai().config({}), undefined, 'no root given: the working directory');
  } finally {
    process.chdir(cwd);
  }

  const react = tmp();
  const dir = path.join(react, 'node_modules', 'react');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'react', exports: { './jsx-dev-runtime': './rt.js' } }));
  fs.writeFileSync(path.join(dir, 'rt.js'), 'module.exports = {};');
  assert.deepEqual(webai({ root: react }).config({}), { optimizeDeps: { include: ['react/jsx-dev-runtime'] } });
  assert.deepEqual(webai().config({ root: react }), { optimizeDeps: { include: ['react/jsx-dev-runtime'] } });
});

test('vite plugin: React\'s dev runtime is replaced, except for the replacement\'s own import', () => {
  const root = tmp();
  const plugin = webai({ root });
  assert.equal(plugin.enforce, 'pre');
  plugin.configResolved({ root, logger: fakeLogger() });
  const id = plugin.resolveId('react/jsx-dev-runtime', '/p/src/App.tsx');
  assert.equal(id, '\0webai-jsx-dev-runtime');
  assert.equal(plugin.resolveId('react/jsx-dev-runtime', id), undefined);
  assert.equal(plugin.resolveId('react', '/p/src/App.tsx'), undefined);
  assert.equal(plugin.load('/other'), undefined);
  assert.match(plugin.load(id), new RegExp(`const ROOT = ${JSON.stringify(root + '/').replace(/\//g, '\\/')}`));
  plugin.api.webai.dispose();
});

test('jsx runtime stand-in: host elements get data-webai-src, nothing else changes', async () => {
  const calls = [];
  globalThis.__realJsx = { Fragment: 'F', jsx: 'J', jsxs: 'JS', jsxDEV: (...a) => (calls.push(a), 'el') };
  const code = jsxRuntimeModule('/proj/web', 'data-x').replace("import * as real from 'react/jsx-dev-runtime';", 'const real = globalThis.__realJsx;');
  const m = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const at = (file, line = 4, col = 7) => ({ fileName: file, lineNumber: line, columnNumber: col });

  assert.deepEqual([m.Fragment, m.jsx, m.jsxs], ['F', 'J', 'JS']);
  assert.equal(m.jsxDEV('h1', { className: 'a' }, 'k', true, at('/proj/web/src/App.tsx'), 'self'), 'el');
  assert.deepEqual(calls[0], ['h1', { className: 'a', 'data-x': 'src/App.tsx:4:7' }, 'k', true, at('/proj/web/src/App.tsx'), 'self']);
  // outside the project (a monorepo sibling): the full path
  m.jsxDEV('p', {}, undefined, false, at('/proj/shared/ui.tsx', 1, 2));
  assert.equal(calls[1][1]['data-x'], '/proj/shared/ui.tsx:1:2');
  // Windows paths
  m.jsxDEV('p', {}, undefined, false, at('/proj/web\\src\\W.tsx'));
  assert.equal(calls[2][1]['data-x'], 'src/W.tsx:4:7');
  // left alone: components, libraries, no source, an attribute already there, no props
  const props = { children: 'x' };
  m.jsxDEV(() => null, props, undefined, false, at('/proj/web/src/C.tsx'));
  m.jsxDEV('div', props, undefined, false, at('/proj/web/node_modules/lib/index.js'));
  m.jsxDEV('div', props, undefined, false, undefined);
  m.jsxDEV('div', props, undefined, false, {});
  m.jsxDEV('div', { 'data-x': 'mine' }, undefined, false, at('/proj/web/src/D.tsx'));
  m.jsxDEV('div', null, undefined, false, at('/proj/web/src/E.tsx'));
  assert.deepEqual(calls.slice(3).map((c) => c[1]), [props, props, props, props, { 'data-x': 'mine' }, null]);
  assert.equal(calls[3][1], props, 'the same object, not a copy');
  // a root given with a trailing slash or Windows separators gives the same base
  assert.match(jsxRuntimeModule('C:\\proj\\web\\'), /ROOT = "C:\/proj\/web\/"/);
  delete globalThis.__realJsx;
});

test('leadingOffset: how many lines something put in front of the file, from the source map', () => {
  assert.equal(leadingOffset(undefined), 0);
  assert.equal(leadingOffset(''), 0);
  assert.equal(leadingOffset('AAAA;AACA'), 0, 'the first line is already the file\'s own');
  assert.equal(leadingOffset(';;;;AAAA'), 4);
  assert.equal(leadingOffset(';;;;AAEA'), 2, 'its first mapped line is source line 3 (index 2)');
  assert.equal(leadingOffset(';;;;AAEA,CAAC;AACA'), 2, 'only the first segment counts');
  assert.equal(leadingOffset(';;;;A'), 0, 'a segment without a source position');
  assert.equal(leadingOffset(';AAHA'), 0, 'a broken map (negative source line) says nothing');
  assert.equal(leadingOffset(';;;AAAA'), 3);
  // multi-digit VLQ: 19 leading lines, source line 0
  assert.equal(leadingOffset(`${';'.repeat(19)}AAAA`), 19);
  assert.equal(leadingOffset(`${';'.repeat(40)}AAgBA`), 40 - 16, 'continuation digits: gB = 16');
});

test('vite plugin: tells the runtime how far the lines were pushed, only for JSX files with something in front', () => {
  const plugin = webai({ root: tmp() });
  const ctx = (mappings) => ({ getCombinedSourcemap: () => ({ mappings }) });
  const run = (id, mappings, code = 'const a = 1;') => plugin.transform.call(ctx(mappings), code, id);

  const out = run('/p/web/src/a.tsx?t=17', `${';'.repeat(19)}AAAA`);
  assert.equal(out.map, null);
  assert.ok(out.code.endsWith('const a = 1;'));
  assert.ok(!out.code.slice(0, out.code.length - 'const a = 1;'.length).includes('\n'), 'one line, in front of the first');
  const globals = {};
  new Function('globalThis', out.code)(globals);
  assert.deepEqual(globals.__webaiLineOffsets, { '/p/web/src/a.tsx': 19 });
  new Function('globalThis', out.code)(globals); // a second file adds to it, a module re-run replaces its own
  assert.deepEqual(Object.keys(globals.__webaiLineOffsets), ['/p/web/src/a.tsx']);

  assert.equal(run('/p/web/src/a.tsx', 'AAAA'), undefined, 'nothing in front: nothing to say');
  assert.equal(run('/p/web/src/a.ts', `${';'.repeat(3)}AAAA`), undefined, 'not JSX');
  assert.equal(run('/p/web/node_modules/lib/a.jsx', `${';'.repeat(3)}AAAA`), undefined, 'a library');
  assert.equal(plugin.transform.call({ getCombinedSourcemap: () => null }, 'x', '/p/a.tsx'), undefined, 'no map at all');
  assert.equal(plugin.transform.call({ getCombinedSourcemap() { throw new Error('no maps here'); } }, 'x', '/p/a.tsx'), undefined);
});

test('jsx runtime stand-in: subtracts the offset the transform recorded; without a usable line only the file', async () => {
  const calls = [];
  globalThis.__realJsx = { jsxDEV: (...a) => (calls.push(a), 'el') };
  const code = jsxRuntimeModule('/proj/web').replace("import * as real from 'react/jsx-dev-runtime';", 'const real = globalThis.__realJsx;');
  const m = await import(`data:text/javascript,${encodeURIComponent(code + '\n//offsets')}`);
  const src = (line) => ({ fileName: '/proj/web/src/App.tsx', lineNumber: line, columnNumber: 3 });
  globalThis.__webaiLineOffsets = { '/proj/web/src/App.tsx': 19 };
  m.jsxDEV('p', {}, undefined, false, src(30));
  m.jsxDEV('p', {}, undefined, false, src(19));
  m.jsxDEV('p', {}, undefined, false, src(20));
  assert.deepEqual(calls.map((c) => c[1]['data-webai-src']), ['src/App.tsx:11:3', 'src/App.tsx', 'src/App.tsx:1:3']);
  delete globalThis.__webaiLineOffsets;
  delete globalThis.__realJsx;
});

test('vite plugin: warns when it comes before plugin-react (the offset would be measured too early)', () => {
  const warn = (names) => {
    const logger = fakeLogger();
    const root = tmp();
    const plugin = webai({ root });
    plugin.configResolved({ root, logger, plugins: names.map((name) => ({ name })) });
    plugin.api.webai.dispose();
    return logger.calls.filter(([level]) => level === 'warn');
  };
  assert.equal(warn(['vite:react-babel', '@jantcz/webai']).length, 0);
  assert.equal(warn(['@jantcz/webai']).length, 0, 'no React');
  assert.equal(warn(['vite:react-babel']).length, 0, 'webai not in the list (tests, other hosts)');
  const w = warn(['@jantcz/webai', 'vite:react-babel']);
  assert.equal(w.length, 1);
  assert.match(w[0][1], /List webai\(\) after react\(\)/);
});
