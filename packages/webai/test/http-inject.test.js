import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { annotateHtml, injectHtml, SRC_ATTR } from '../src/html.js';
import { htmlTransformer } from '../src/inject.js';
import { mimeType, staticFiles } from '../src/static.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-inj-')));

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => (server.closeAllConnections(), server.close()) };
}

function get(port, url, { method = 'GET', headers = { accept: 'text/html' } } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: url, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, raw: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Server whose handler runs behind htmlTransformer; the transform wraps the page in [[ ]]. */
async function transformed(handler, transform = (html) => `[[${html}]]`) {
  const mw = htmlTransformer(transform);
  return listen((req, res) => mw(req, res, () => handler(req, res)));
}

test('html: annotateHtml adds positions, skips head-ish tags, comments and script bodies', () => {
  const html = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n  <!-- <p>c</p> -->\n  <DIV class="a">x<br><span>y</span></DIV>\n<script>if (a<b) {}</script><style>p{}</style>\n</body></html>';
  const out = annotateHtml(html, 'page.html');
  assert.ok(out.includes(`<DIV ${SRC_ATTR}="page.html:5:3" class="a">`));
  assert.ok(out.includes(`<span ${SRC_ATTR}="page.html:5:`));
  assert.ok(out.includes(`<body ${SRC_ATTR}`) === true);
  assert.ok(!out.includes(`<html ${SRC_ATTR}`) && !out.includes(`<br ${SRC_ATTR}`) && !out.includes(`<script ${SRC_ATTR}`));
  assert.ok(out.includes('<!-- <p>c</p> -->') && out.includes('<script>if (a<b) {}</script>'));
  assert.equal(out.split('\n').length, html.split('\n').length);
  assert.match(annotateHtml('<p>x</p>'), /data-webai-src="index\.html:1:1"/);
  assert.equal(annotateHtml('plain text'), 'plain text');
});

test('html: injectHtml puts the snippet before the last </body> or at the end', () => {
  assert.equal(injectHtml('<body>a</BODY>', 'S'), '<body>aS</BODY>');
  assert.equal(injectHtml('<body></body><p></body>', 'S'), '<body></body><p>S</body>');
  assert.equal(injectHtml('<p>a</p>', 'S'), '<p>a</p>S');
});

test('inject: only GET requests that accept HTML are looked at', async () => {
  const s = await transformed((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('page');
  });
  try {
    assert.equal((await get(s.port, '/')).body, '[[page]]');
    assert.equal((await get(s.port, '/', { headers: {} })).body, 'page');
    assert.equal((await get(s.port, '/', { headers: { accept: 'application/json' } })).body, 'page');
    assert.equal((await get(s.port, '/', { method: 'POST' })).body, 'page');
  } finally {
    s.close();
  }
});

test('inject: writeHead variants (object, reason, flat list, pairs, no headers)', async () => {
  const s = await transformed((req, res) => {
    const html = 'text/html; charset=utf-8';
    switch (req.url) {
      case '/obj': res.writeHead(201, { 'Content-Type': html, 'X-A': 'a' }); break;
      case '/reason': res.writeHead(202, 'Fine', { 'content-type': html }); break;
      case '/flat': res.writeHead(203, ['content-type', html, 'x-flat', 'f']); break;
      case '/pairs': res.writeHead(204 + 1, [['content-type', html], ['x-pairs', 'p']]); break;
      case '/bare': res.setHeader('content-type', html); res.writeHead(206); break;
      case '/reason-only': res.setHeader('content-type', html); res.writeHead(207, 'Multi'); break;
    }
    res.end('x');
  });
  try {
    let r = await get(s.port, '/obj');
    assert.deepEqual([r.status, r.body, r.headers['x-a'], r.headers['content-length']], [201, '[[x]]', 'a', '5']);
    r = await get(s.port, '/reason');
    assert.deepEqual([r.status, r.statusMessage, r.body], [202, 'Fine', '[[x]]']);
    r = await get(s.port, '/flat');
    assert.deepEqual([r.status, r.body, r.headers['x-flat']], [203, '[[x]]', 'f']);
    r = await get(s.port, '/pairs');
    assert.deepEqual([r.status, r.body, r.headers['x-pairs']], [205, '[[x]]', 'p']);
    r = await get(s.port, '/bare');
    assert.deepEqual([r.status, r.body], [206, '[[x]]']);
    r = await get(s.port, '/reason-only');
    assert.deepEqual([r.status, r.statusMessage, r.body], [207, 'Multi', '[[x]]']);
  } finally {
    s.close();
  }
});

test('inject: write()/end() argument variants are buffered and callbacks are called', async () => {
  const calls = [];
  const s = await transformed((req, res) => {
    res.setHeader('content-type', 'text/html');
    switch (req.url) {
      case '/a':
        res.write('a');
        res.write(Buffer.from('b'));
        res.write('c', () => calls.push('cb3'));
        res.write('d', 'utf8', () => calls.push('cb4'));
        res.write('e', 'latin1');
        res.end(() => calls.push('endcb'));
        break;
      case '/b': res.end('x', () => calls.push('end-chunk-cb')); break;
      case '/c': res.end('x', 'utf8', () => calls.push('end-enc-cb')); break;
      case '/d': res.end(Buffer.from('buf')); break;
      case '/e': res.end(); break;
    }
  });
  try {
    assert.equal((await get(s.port, '/a')).body, '[[abcde]]');
    assert.equal((await get(s.port, '/b')).body, '[[x]]');
    assert.equal((await get(s.port, '/c')).body, '[[x]]');
    assert.equal((await get(s.port, '/d')).body, '[[buf]]');
    assert.equal((await get(s.port, '/e')).body, '[[]]');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.sort(), ['cb3', 'cb4', 'end-chunk-cb', 'end-enc-cb', 'endcb'].sort());
  } finally {
    s.close();
  }
});

test('inject: non-HTML and compressed responses pass through untouched', async () => {
  const s = await transformed((req, res) => {
    switch (req.url) {
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"a"', () => {});
        res.end(':1}');
        break;
      case '/json-end':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        break;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'identity-test' });
        res.end('<p>raw</p>');
        break;
      case '/notype':
        res.end('nothing');
        break;
      case '/empty-end':
        res.setHeader('content-type', 'text/plain');
        res.end();
        break;
      case '/xhtml':
        res.setHeader('content-type', 'text/htmlx');
        res.end('x');
        break;
    }
  });
  try {
    assert.equal((await get(s.port, '/json')).body, '{"a":1}');
    assert.equal((await get(s.port, '/json-end')).body, '{}');
    const gz = await get(s.port, '/gzip');
    assert.deepEqual([gz.body, gz.headers['content-encoding']], ['<p>raw</p>', 'identity-test']);
    assert.equal((await get(s.port, '/notype')).body, 'nothing');
    assert.equal((await get(s.port, '/empty-end')).body, '');
    assert.equal((await get(s.port, '/xhtml')).body, 'x');
  } finally {
    s.close();
  }
});

test('inject: the transform gets the request', async () => {
  const seen = [];
  const s = await transformed(
    (req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('page');
    },
    (html, req) => {
      seen.push(req.url);
      return html.toUpperCase();
    },
  );
  try {
    assert.equal((await get(s.port, '/p?q=1')).body, 'PAGE');
    assert.deepEqual(seen, ['/p?q=1']);
  } finally {
    s.close();
  }
});

test('inject: headers already sent by the transform are left alone', async () => {
  let flush;
  const mw = htmlTransformer((html) => {
    flush();
    return html;
  });
  const s = await listen((req, res) => {
    flush = () => res.flushHeaders();
    mw(req, res, () => {
      res.setHeader('content-type', 'text/html');
      res.end('page');
    });
  });
  try {
    const r = await get(s.port, '/');
    assert.equal(r.body, 'page');
    assert.equal(r.headers['content-length'], undefined);
  } finally {
    s.close();
  }
});

test('static: serves files, annotates HTML, clean URLs, directories, HEAD', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'ünï cöde'));
  fs.writeFileSync(path.join(dir, 'ünï cöde', 'index.html'), '<p>u</p>');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>\n<h1>Hi</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'about.html'), '<p>about</p>');
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<p>sub</p>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'p{}');
  fs.writeFileSync(path.join(dir, 'data.unknown'), 'bin');
  const s = await listen(staticFiles(dir));
  try {
    const home = await get(s.port, '/');
    assert.equal(home.status, 200);
    assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(home.headers['cache-control'], 'no-store');
    assert.ok(home.body.includes(`<h1 ${SRC_ATTR}="index.html:2:1">Hi</h1>`));

    assert.match((await get(s.port, '/style.css')).headers['content-type'], /^text\/css/);
    assert.equal((await get(s.port, '/style.css')).body, 'p{}');
    assert.equal((await get(s.port, '/data.unknown')).headers['content-type'], 'application/octet-stream');
    assert.ok((await get(s.port, '/about')).body.includes('about.html:1:1'));
    assert.ok((await get(s.port, '/sub/')).body.includes('sub/index.html:1:1'));

    const redirect = await get(s.port, '/sub');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/sub/');
    assert.equal((await get(s.port, '/%C3%BCn%C3%AF%20c%C3%B6de')).headers.location, '/%C3%BCn%C3%AF%20c%C3%B6de/');

    const head = await get(s.port, '/style.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    assert.equal((await get(s.port, '/empty/')).status, 404);
    assert.equal((await get(s.port, '/missing')).status, 404);
    assert.equal((await get(s.port, '/missing.html')).status, 404);
    const esc = await get(s.port, '/%3Cb%3E%26');
    assert.equal(esc.status, 404);
    assert.ok(esc.body.includes('&#60;b&#62;&#38;') && !esc.body.includes('<b>'));
  } finally {
    s.close();
  }
});

test('static: 405, 400, dotfiles and symlinks out of the folder', async () => {
  const outer = tmp();
  const dir = path.join(outer, 'site');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET');
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(outer, 'secret.txt'), 'outside');
  fs.symlinkSync(path.join(outer, 'secret.txt'), path.join(dir, 'link.txt'));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
  fs.symlinkSync(path.join(dir, 'ok.txt'), path.join(dir, 'inner.txt'));
  const s = await listen(staticFiles(dir));
  try {
    assert.equal((await get(s.port, '/ok.txt', { method: 'POST' })).status, 405);
    assert.equal((await get(s.port, '/%E0%A4%A')).status, 400);
    assert.equal((await get(s.port, '/.env')).status, 404);
    assert.equal((await get(s.port, '/.git/config')).status, 404);
    assert.equal((await get(s.port, '/..%2Fsecret.txt')).status, 404);
    assert.equal((await get(s.port, '/link.txt')).status, 403);
    assert.equal((await get(s.port, '/inner.txt')).body, 'fine');
  } finally {
    s.close();
  }
});

test('static: mimeType', () => {
  assert.equal(mimeType('a.PNG'), 'image/png');
  assert.equal(mimeType('noext'), 'application/octet-stream');
});
