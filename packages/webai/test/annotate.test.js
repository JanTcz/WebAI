import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { annotate, loadParser } from '../src/astro/annotate.js';
import { buildPrompt } from '../src/session.js';

// The parser is an Astro dependency, taken from the example site.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/astro');
const parse = await loadParser(root);

test('annotates HTML elements with line and column, not components', async () => {
  const src = '---\nimport Foo from "./Foo.astro";\n---\n<section class="a">\n  <h1>Hello</h1>\n  <Foo />\n</section>\n';
  const out = await annotate(parse, src, 'src/X.astro');
  assert.match(out, /<section data-webai-src="src\/X\.astro:4:1" class="a">/);
  assert.match(out, /<h1 data-webai-src="src\/X\.astro:5:3">Hello<\/h1>/);
  assert.match(out, /<Foo \/>/);
});

test('offsets are correct after diacritics', async () => {
  const src = '---\nconst t = "žluťoučký kůň";\n---\n<p>úpěl ďábelské ódy</p><span>x</span>\n';
  const out = await annotate(parse, src, 'a.astro');
  assert.match(out, /<p data-webai-src="a\.astro:4:1">úpěl ďábelské ódy<\/p><span data-webai-src="a\.astro:4:25">x<\/span>/);
});

test('skips head, script, style and keeps elements in expressions annotated', async () => {
  const src = '<html><head><title>t</title><style>p{}</style></head><body>{[1].map(() => <li>x</li>)}<script>1</script></body></html>';
  const out = await annotate(parse, src, 'b.astro');
  assert.doesNotMatch(out, /<(html|head|title|style|script) data-webai/);
  assert.match(out, /<body data-webai-src=/);
  assert.match(out, /<li data-webai-src=/);
});

test('prompt carries the source, selector and request', () => {
  const p = buildPrompt({
    message: 'Make the heading bigger',
    page: { url: '/', title: 'Demo' },
    element: { src: 'src/components/Hero.astro:12:5', chain: ['src/pages/index.astro:9:3'], tag: '<h1 class="hero__title">', selector: 'main > h1', text: 'Hello' },
  });
  assert.match(p, /source: src\/components\/Hero\.astro:12:5/);
  assert.match(p, /inside: src\/pages\/index\.astro:9:3/);
  assert.match(p, /\[Request\]\nMake the heading bigger$/);
});

test('offsets are correct after emoji and after a tag with the same prefix', async () => {
  const src = '<p>🐄 ř</p>\n<pre>x</pre><p>y</p>\n';
  const out = await annotate(parse, src, 'e.astro');
  assert.equal(out, '<p data-webai-src="e.astro:1:1">🐄 ř</p>\n<pre data-webai-src="e.astro:2:1">x</pre><p data-webai-src="e.astro:2:13">y</p>\n');
});

test('leaves a broken template alone, Astro reports the error', async () => {
  assert.equal(await annotate(parse, '---\nconst a = 1;\n---\n<div><p>x</div>\n', 'x.astro'), null);
});

// ---- branches the real parser does not produce: fabricated ASTs

const el = (name, start, attributes = [], type = 'JSXIdentifier') => ({ type: 'JSXElement', openingElement: { start, name: { type, name }, attributes } });
const fakeParse = (body, diagnostics) => async () => ({ ast: { body }, diagnostics });

test('annotate: diagnostics errors leave the template alone; warnings do not', async () => {
  assert.equal(await annotate(fakeParse([el('p', 0)], [{ severity: 'error' }]), '<p>x</p>', 'a.astro'), null);
  assert.equal(await annotate(fakeParse([el('p', 0)], [{ severity: 'warning' }]), '<p>x</p>', 'a.astro'), '<p data-webai-src="a.astro:1:1">x</p>');
});

test('annotate: namespaced names, components, skipped tags, existing attributes, spreads', async () => {
  const src = '<p>x</p>';
  const body = [
    el('Foo', 0, [], 'JSXMemberExpression'),
    el('p', 0, [{}, { name: { name: 'data-webai-src' } }]),
    el('p', 0, [{ name: { name: 'is:raw' } }]),
    el('Comp', 0),
    el('script', 0),
    { type: 'JSXElement' }, // no openingElement
  ];
  assert.equal(await annotate(fakeParse(body), src, 'a.astro'), null);
  assert.equal(await annotate(fakeParse([...body, el('p', 0, [{ type: 'JSXSpreadAttribute' }])]), src, 'a.astro'), '<p data-webai-src="a.astro:1:1">x</p>');
});

test('annotate: positions that cannot be verified are skipped; tag-name prefixes are not matched', async () => {
  const src = '<pre>x</pre>';
  assert.equal(await annotate(fakeParse([el('p', 0)]), src, 'a.astro'), null); // <pre is not <p
  assert.equal(await annotate(fakeParse([el('p', 3)]), src, 'a.astro'), null); // not a tag start
  assert.equal(await annotate(fakeParse([el('p', 999)]), src, 'a.astro'), null); // outside the file
});

test('annotate: byte offsets (older compiler) after non-ASCII text, nodes that are not objects', async () => {
  const src = 'é<p>x</p>\n<b>y</b>';
  // UTF-8 byte offsets: é is 2 bytes
  const out = await annotate(fakeParse([null, 'text', 5, [el('p', 2), { type: 'Text', children: [undefined, el('b', 11)] }]]), src, 'a.astro');
  assert.equal(out, 'é<p data-webai-src="a.astro:1:2">x</p>\n<b data-webai-src="a.astro:2:1">y</b>');
  // UTF-16 offsets
  const out16 = await annotate(fakeParse([el('p', 1), el('b', 10)]), src, 'a.astro');
  assert.equal(out16, out);
});
