// The whole path: a fake browser (HTTP + SSE like the overlay), the real middleware, and `webai mcp` over stdio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createWebai } from '../src/core.js';
import { MCP_ENDPOINT_FILE } from '../src/mcp/endpoint.js';
import { serveMcp } from '../src/mcp/stdio.js';

const quiet = { info() {}, warn() {}, error() {} };

async function boot(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-e2e-'));
  const core = createWebai({ root, logger: quiet, ...options });
  const server = http.createServer((req, res) => core.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const host = `localhost:${port}`;
  const request = (method, url, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method, path: url, headers: { host, ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  // What the overlay does: same origin, the page token.
  const page = (url, body) =>
    request('POST', `/__webai/${url}`, { headers: { origin: `http://${host}`, 'x-webai-token': core.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const stream = (tab) => {
    const events = [];
    const req = http.get({ port, host: '127.0.0.1', path: `/__webai/events?token=${core.token}&tab=${tab}`, headers: { host } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) events.push(p);
      });
    });
    const wait = async (re) => {
      for (let i = 0; i < 200; i++) {
        const hit = events.find((e) => re.test(e));
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no event ${re}`);
    };
    return { events, wait, close: () => req.destroy() };
  };
  const close = () => (core.dispose(), server.closeAllConnections(), server.close());
  return { root, core, port, host, request, page, stream, close };
}

function mcp(root) {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = [];
  output.on('data', (c) => out.push(...String(c).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const server = serveMcp({ root, input, output });
  let id = 0;
  const call = async (name, args) => {
    const mine = ++id;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 300; i++) {
      const hit = out.find((m) => m.id === mine);
      if (hit) return hit.result;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no answer');
  };
  return { call, end: () => (input.end(), server.done) };
}

test('e2e: the first page that reports in makes the endpoint file; tools read what the page sent', async () => {
  const b = await boot();
  const c = mcp(b.root);
  const stream = b.stream('tab1');
  try {
    const file = path.join(b.root, '.webai', MCP_ENDPOINT_FILE);
    assert.ok(!fs.existsSync(file));
    assert.match((await c.call('webai_console', {})).content[0].text, /No running WebAI found/);

    await b.page('page/hello', { tab: 'tab1', url: `http://${b.host}/`, title: 'Home', nav: 1, origin: `http://${b.host}`, viewport: { width: 1200, height: 800 }, visible: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).url, `http://127.0.0.1:${b.port}`);
    await stream.wait(/event: ready/);

    await b.page('page/selection', { tab: 'tab1', element: { src: 'src/Hero.astro:12:3', selector: 'h1.title', text: 'Hello', html: '<h1>Hello</h1>' }, page: { url: '/', title: 'Home' } });
    const sel = await c.call('webai_get_selection', {});
    assert.equal(sel.isError, false);
    assert.match(sel.content[0].text, /src\/Hero\.astro:12:3/);

    await b.page('page/log', { tab: 'tab1', entries: [{ level: 'error', kind: 'error', text: 'TypeError: x is undefined (app.js:3:1)', stack: 'at f' }, { level: 'error', kind: 'network', text: 'GET /api → 500' }] });
    const logs = await c.call('webai_console', { level: 'error' });
    assert.match(logs.content[0].text, /TypeError: x is undefined/);
    assert.match(logs.content[0].text, /GET \/api → 500/);

    // A command: the tool waits while the page (here: this test) answers over POST.
    const pending = c.call('webai_query_dom', { selector: 'h1' });
    const cmd = JSON.parse((await stream.wait(/event: command/)).split('data: ')[1]);
    assert.equal(cmd.cmd, 'query');
    assert.equal(cmd.args.selector, 'h1');
    assert.equal(JSON.parse((await b.page('page/result', { tab: 'tab1', id: cmd.id, ok: true, data: { count: 1, elements: [{ text: 'Hello' }] } })).body).ok, true);
    assert.match((await pending).content[0].text, /"count": 1/);

    const hist = await c.call('webai_history', {});
    assert.equal(hist.isError, false);

    b.close();
    assert.ok(!fs.existsSync(file), 'the endpoint file goes away with the dev server');
  } finally {
    stream.close();
    await c.end();
    b.close();
  }
});

test('e2e: tool routes are for the local MCP process only', async () => {
  const b = await boot();
  try {
    await b.page('page/hello', { tab: 't', origin: `http://${b.host}` });
    const mcpToken = JSON.parse(fs.readFileSync(path.join(b.root, '.webai', MCP_ENDPOINT_FILE), 'utf8')).token;
    const body = JSON.stringify({ tool: 'webai_history' });
    const hit = (headers) => b.request('POST', '/__webai/mcp/call', { headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await hit({ 'x-webai-token': mcpToken })).status, 200);
    assert.equal((await hit({})).status, 403); // no token
    assert.equal((await hit({ 'x-webai-token': 'wrong' })).status, 403);
    assert.equal((await hit({ 'x-webai-token': b.core.token })).status, 403); // the page's token is not the tools' token
    assert.equal((await hit({ 'x-webai-token': mcpToken, origin: `http://${b.host}` })).status, 403); // a web page
    assert.equal((await hit({ 'x-webai-token': mcpToken, 'sec-fetch-site': 'cross-site' })).status, 403);
    // and the tools' token does not open the page's routes
    const state = await b.request('GET', '/__webai/state', { headers: { 'x-webai-token': mcpToken } });
    assert.equal(state.status, 403);
    // unknown tool and bad arguments are reported with their status
    const bad = await b.request('POST', '/__webai/mcp/call', { headers: { 'x-webai-token': mcpToken, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'nope' }) });
    assert.equal(bad.status, 404);
    const args = await b.request('POST', '/__webai/mcp/call', { headers: { 'x-webai-token': mcpToken, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'webai_console', args: { limit: 0 } }) });
    assert.equal(args.status, 400);
  } finally {
    b.close();
  }
});

test('e2e: the page routes validate what the page sends', async () => {
  const b = await boot();
  try {
    assert.equal((await b.page('page/hello', { tab: 'bad id!' })).status, 400);
    assert.equal((await b.page('page/log', { tab: 't', entries: 'x' })).status, 400);
    assert.equal((await b.page('page/focus', { tab: 't' })).status, 200);
    assert.equal((await b.page('page/selection', { tab: 't', element: null })).status, 200);
    assert.equal(JSON.parse((await b.page('page/result', { tab: 't', id: 'zz', ok: true })).body).ok, false);
    assert.equal((await b.page('page/unknown', { tab: 't' })).status, 404);
    // the stream with an invalid tab id is an ordinary event stream, just without commands
    const s = b.stream('bad%20id');
    await s.wait(/event: ready/);
    assert.equal(b.core.session.pages.tabs.has('bad id'), false);
    s.close();
  } finally {
    b.close();
  }
});

test('e2e: mcp: false writes no endpoint and refuses the tool route', async () => {
  const b = await boot({ mcp: false });
  try {
    await b.page('page/hello', { tab: 't', origin: `http://${b.host}` });
    assert.ok(!fs.existsSync(path.join(b.root, '.webai', MCP_ENDPOINT_FILE)));
    const res = await b.request('POST', '/__webai/mcp/call', { headers: { 'x-webai-token': '', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  } finally {
    b.close();
  }
});

test('e2e: an unwritable state folder is a warning, not a crash', async () => {
  const warned = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-e2e-'));
  fs.writeFileSync(path.join(root, '.webai'), 'a file where the folder should be');
  const core = createWebai({ root, logger: { info() {}, warn: (m) => warned.push(m), error() {} } });
  core.session.pages.hello({ tab: 't', origin: 'http://localhost:1' });
  assert.match(warned[0], /MCP endpoint not written/);
  core.dispose();
});

test('e2e: a bridge keeps the page API but not the tools (its own token is for them)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-e2e-'));
  const core = createWebai({ root, logger: quiet, bridge: 'http://127.0.0.1:1' });
  assert.equal(core.session, null);
  core.dispose();
  assert.ok(!fs.existsSync(path.join(root, '.webai', MCP_ENDPOINT_FILE)));
});
