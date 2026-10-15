import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotate } from './editor.js';

test('editor: annotating plain HTML matches line and column, skips script/style/comments', () => {
  const html = '<html><body>\n  <h1 class="x">Hello</h1>\n<!-- <p>no</p> --><style>p{}</style>\n<script>if (a<b) x()</script><p>ü <b>bold</b></p>\n</body></html>';
  const out = annotate(html);
  assert.match(out, /<body data-webai-src="index\.html:1:7">/);
  assert.match(out, /<h1 data-webai-src="index\.html:2:3" class="x">/);
  assert.match(out, /<!-- <p>no<\/p> -->/);
  assert.match(out, /<script>if \(a<b\) x\(\)<\/script><p data-webai-src="index\.html:4:30">ü <b data-webai-src="index\.html:4:35">/);
  assert.doesNotMatch(out, /<(html|style|script) data-webai/);
  assert.equal(out.split('\n').length, html.split('\n').length);
});

test('editor: an edit matches even with extra indentation, new_text is adjusted the same way', async () => {
  const { matchEdit } = await import('./editor.js');
  const css = '.btn {\n  color: red;\n}\n';
  assert.deepEqual(matchEdit(css, '  .btn {\n    color: red;', '  .btn {\n    color: green;'), { count: 1, old: '.btn {\n  color: red;', new: '.btn {\n  color: green;' });
  assert.equal(matchEdit(css, 'color: blue;', 'x').count, 0);
  assert.equal(matchEdit('a\na\n', 'a', 'b').count, 2);
});

test('editor: an edit matches despite a wrongly indented first line and straight quotes', async () => {
  const { matchEdit } = await import('./editor.js');
  const html = '<ol>\n  <li>\n    <p>See “Source”.</p>\n  </li>\n</ol>\n';
  const edit = matchEdit(html, '      <li>\n    <p>See "Source".</p>\n  </li>\n</ol>', '      <li>\n    <p>See "Source".</p>\n  </li>\n  <li>New</li>\n</ol>');
  assert.equal(edit.count, 1);
  assert.equal(html.replace(edit.old, () => edit.new), '<ol>\n  <li>\n    <p>See “Source”.</p>\n  </li>\n  <li>New</li>\n</ol>\n');
});

test('editor: ZIP round trip, including non-ASCII names and binary data', async () => {
  const { createZip, readZip } = await import('./zip.js');
  const bytes = new Uint8Array(5000).map((_, i) => (i * 7919) % 251);
  const zip = await createZip([['index.html', '<h1>Hello</h1>'.repeat(40)], ['画像/logo.png', bytes]]);
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => e.path), ['index.html', '画像/logo.png']);
  assert.equal(new TextDecoder().decode(back[0].data), '<h1>Hello</h1>'.repeat(40));
  assert.deepEqual(back[1].data, bytes);
});

test('editor: paths stay inside the site, no escaping and no hidden files', async () => {
  const { cleanPath } = await import('./editor.js');
  assert.equal(cleanPath('./img/a.png'), 'img/a.png');
  assert.equal(cleanPath('/index.html'), 'index.html');
  for (const bad of ['../x.html', 'a//b', 'a/../b', '.git/config', 'img/.DS_Store', '', 'a\\b', null]) assert.equal(cleanPath(bad), null, bad);
});

test('editor: an uploaded ZIP with a site folder replaces the site, single files are added', async () => {
  const { prepareUpload } = await import('./editor.js');
  const { createZip } = await import('./zip.js');
  const zip = await createZip([['my-site/index.html', '<h1>x</h1>'], ['my-site/img/a.png', new Uint8Array([1, 2])], ['__MACOSX/my-site/._a.png', 'x']]);
  const site = await prepareUpload([{ path: 'my-site.zip', blob: zip }]);
  assert.equal(site.replace, true);
  assert.deepEqual(Object.keys(site.files).sort(), ['img/a.png', 'index.html']);
  assert.equal(site.files['index.html'], '<h1>x</h1>');
  assert.ok(site.files['img/a.png'] instanceof Blob);
  const nested = await prepareUpload([{ path: 'site.zip', blob: await createZip([['proj/README.md', 'x'], ['proj/dist/index.html', '<p>'], ['proj/dist/css/a.css', 'p{}']]) }]);
  assert.equal(nested.replace, true);
  assert.deepEqual(Object.keys(nested.files).sort(), ['css/a.css', 'index.html']);
  assert.deepEqual(nested.skipped, ['proj/README.md']);
  const add = await prepareUpload([{ path: 'img/b.svg', blob: new Blob(['<svg/>']) }]);
  assert.deepEqual(add, { files: { 'img/b.svg': '<svg/>' }, replace: false, total: 6, skipped: [] });
});

test('editor: models ranked for the select, tool-capable only, free first', async () => {
  const { rankModels } = await import('./editor.js');
  const m = (id, name, prompt, completion, tools = true) => ({ id, name, pricing: { prompt, completion }, supported_parameters: tools ? ['tools'] : [] });
  const ranked = rankModels([
    m('cheap/x', 'Cheap', '0.0000001', '0.0000002'),
    m('big/y-550b:free', 'Big (free)', '0', '0'),
    m('small/z-8b:free', 'Small (free)', '0', '0'),
    m('poolside/laguna-s-2.1:free', 'Laguna (free)', '0', '0'),
    m('notools/n:free', 'No tools', '0', '0', false),
    m('pricey/p', 'Pricey', '0.000005', '0.000025'),
  ]);
  assert.deepEqual(ranked.map((c) => c.value), ['poolside/laguna-s-2.1:free', 'big/y-550b:free', 'small/z-8b:free', 'pricey/p', 'cheap/x']);
  assert.equal(ranked[0].label, 'Laguna');
  assert.equal(ranked[3].label, 'Pricey · $5/$25 per M tokens');
});

test('editor: an added image comes with a credit caption when its license needs one', async () => {
  const { imageSnippet } = await import('./editor.js');
  const by = imageSnippet('img/lake.jpg', { title: 'Lake <dawn>', creator: 'Ann', license: 'CC BY 2.0', page: 'https://flickr.com/p/1', attribution: '…' });
  assert.match(by, /<img src="img\/lake.jpg" alt="Lake &lt;dawn&gt;">/);
  assert.match(by, /<figcaption class="credit">Photo: <a href="https:\/\/flickr.com\/p\/1">Lake &lt;dawn&gt;<\/a> by Ann, CC BY 2.0<\/figcaption>/);
  assert.doesNotMatch(imageSnippet('a.jpg', { title: 't', license: 'CC0 1.0', attribution: null }), /figcaption/);
});
