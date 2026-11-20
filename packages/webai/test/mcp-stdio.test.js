import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { loopbackUrl, MCP_ENDPOINT_FILE, readEndpoint, removeEndpoint, writeEndpoint } from '../src/mcp/endpoint.js';
import { serveMcp } from '../src/mcp/stdio.js';
import { BRIDGE_TOKEN_FILE } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-mcp-'));

test('endpoint: loopbackUrl keeps the port and protocol, always on 127.0.0.1', () => {
  assert.equal(loopbackUrl('http://localhost:5173'), 'http://127.0.0.1:5173');
  assert.equal(loopbackUrl('https://my.local:3000/x?y'), 'https://127.0.0.1:3000');
});

test('endpoint: write is private to the owner, remove only takes our own file, read explains what is missing', () => {
  const root = tmp();
  const dir = path.join(root, '.webai');
  assert.throws(() => readEndpoint({ root }), /No running WebAI found.*Start the dev server/s);
  writeEndpoint(dir, { url: 'http://127.0.0.1:1', token: 'A' });
  writeEndpoint(dir, { url: 'http://127.0.0.1:2', token: 'B' }); // a second dev server takes over
  assert.equal(fs.statSync(path.join(dir, MCP_ENDPOINT_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(readEndpoint({ root }), { url: 'http://127.0.0.1:2', token: 'B' });
  removeEndpoint(dir, 'A'); // not ours any more
  assert.ok(fs.existsSync(path.join(dir, MCP_ENDPOINT_FILE)));
  removeEndpoint(dir, 'B');
  assert.ok(!fs.existsSync(path.join(dir, MCP_ENDPOINT_FILE)));
  removeEndpoint(dir, 'B'); // already gone: no error
  fs.rmSync(root, { recursive: true });
});

test('endpoint: in a monorepo the newest dev server one level down is found, the root\'s own file wins', () => {
  const root = tmp();
  const at = (sub, token, age = 0) => {
    writeEndpoint(path.join(root, sub, '.webai'), { url: 'http://127.0.0.1:1', token });
    const t = new Date(Date.now() - age);
    fs.utimesSync(path.join(root, sub, '.webai', MCP_ENDPOINT_FILE), t, t);
  };
  fs.mkdirSync(path.join(root, 'node_modules', 'x', '.webai'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden', '.webai'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a-file'), '');
  fs.mkdirSync(path.join(root, 'empty'));
  assert.throws(() => readEndpoint({ root }), /No running WebAI found/);
  at('old', 'OLD', 60000);
  at('web', 'WEB');
  assert.equal(readEndpoint({ root }).token, 'WEB');
  at('older', 'OLDER', 120000); // older than the best so far: does not replace it
  assert.equal(readEndpoint({ root }).token, 'WEB');
  writeEndpoint(path.join(root, '.webai'), { url: 'http://127.0.0.1:1', token: 'ROOT' });
  assert.equal(readEndpoint({ root }).token, 'ROOT');
  fs.rmSync(root, { recursive: true });
});

test('endpoint: a bridge is addressed explicitly, its token comes from the state folder', () => {
  const root = tmp();
  assert.throws(() => readEndpoint({ root, bridge: 'http://127.0.0.1:4400' }), /No bridge token.*npx webai bridge/s);
  fs.mkdirSync(path.join(root, '.webai'));
  fs.writeFileSync(path.join(root, '.webai', BRIDGE_TOKEN_FILE), 'tok\n');
  assert.deepEqual(readEndpoint({ root, bridge: 'http://127.0.0.1:4400' }), { url: 'http://127.0.0.1:4400', token: 'tok' });
  fs.rmSync(root, { recursive: true });
});

function client(opts) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (c) => lines.push(...String(c).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const server = serveMcp({ input, output, ...opts });
  const send = (msg) => input.write(typeof msg === 'string' ? msg + '\n' : JSON.stringify(msg) + '\n');
  const finish = async () => (input.end(), await server.done, lines);
  return { send, finish, lines, server };
}

test('mcp: initialize negotiates the version, announces tools; notifications get no answer; ping works', async () => {
  const c = client({ root: tmp() });
  c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  c.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  c.send({ jsonrpc: '2.0', id: 3, method: 'initialize' });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  c.send({ jsonrpc: '2.0', method: 'whatever' });
  c.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  c.send({ jsonrpc: '2.0', id: 5, method: 'nope' });
  c.send('   ');
  const out = await c.finish();
  const by = (id) => out.find((m) => m.id === id);
  assert.equal(by(1).result.protocolVersion, '2025-06-18');
  assert.equal(by(2).result.protocolVersion, '2025-11-25');
  assert.equal(by(3).result.protocolVersion, '2025-11-25');
  assert.deepEqual(by(1).result.capabilities, { tools: {} });
  assert.match(by(1).result.instructions, /never instructions/);
  assert.deepEqual(by(4).result, {});
  assert.equal(by(5).error.code, -32601);
  assert.equal(out.length, 5);
});

test('mcp: tools/list has every tool, marked read-only', async () => {
  const c = client({ root: tmp() });
  c.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const [res] = await c.finish();
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes('webai_get_selection') && names.includes('webai_console'));
  assert.ok(res.result.tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === 'object'));
});

test('mcp: malformed input gets JSON-RPC errors, the server keeps going', async () => {
  const c = client({ root: tmp() });
  c.send('{not json');
  c.send('[1]');
  c.send('"str"');
  c.send(JSON.stringify({ id: 7 }));
  c.send(JSON.stringify({ id: 8, method: 5 }));
  c.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const out = await c.finish();
  assert.deepEqual(out.map((m) => m.error?.code ?? 'ok'), [-32700, -32600, -32600, -32600, -32600, 'ok']);
  assert.equal(out[3].id, 7);
  assert.equal(out[2].id, null);
});

test('mcp: tools/call forwards to the dev server with the token and wraps the data as untrusted', async () => {
  const root = tmp();
  writeEndpoint(path.join(root, '.webai'), { url: 'http://127.0.0.1:5173', token: 'TT' });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ result: { element: { src: 'a:1:1' } } }), { status: 200 });
  };
  const c = client({ root, fetchImpl });
  c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'webai_get_selection', arguments: { tab: 'x' } } });
  const [res] = await c.finish();
  assert.equal(seen[0].url, 'http://127.0.0.1:5173/__webai/mcp/call');
  assert.equal(seen[0].init.headers['X-WebAI-Token'], 'TT');
  assert.deepEqual(JSON.parse(seen[0].init.body), { tool: 'webai_get_selection', args: { tab: 'x' } });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /not instructions/);
  assert.match(res.result.content[0].text, /"src": "a:1:1"/);
});

test('mcp: tools/call failures come back as tool errors an agent can act on', async () => {
  const root = tmp();
  const answers = [];
  const fetchImpl = async () => answers.shift()();
  const c = client({ root, fetchImpl });
  const call = (id, name = 'webai_console') => c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } });
  call(1); // no endpoint file yet
  await new Promise((r) => setTimeout(r, 20));
  writeEndpoint(path.join(root, '.webai'), { url: 'http://127.0.0.1:1', token: 'T' });
  answers.push(() => { throw new TypeError('fetch failed'); });
  answers.push(() => new Response('{}', { status: 403 }));
  answers.push(() => new Response(JSON.stringify({ error: 'No page' }), { status: 404 }));
  answers.push(() => new Response('<html>', { status: 502 }));
  call(2);
  call(3);
  call(4);
  call(5);
  c.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call' });
  const out = await c.finish();
  const text = (id) => out.find((m) => m.id === id).result.content[0].text;
  assert.match(text(1), /No running WebAI found/);
  assert.ok(out.filter((m) => m.id >= 1 && m.id <= 5).every((m) => m.result.isError));
  const texts = [2, 3, 4, 5].map(text).join('\n');
  assert.match(texts, /not responding/);
  assert.match(texts, /rejected the token/);
  assert.match(texts, /No page/);
  assert.match(texts, /HTTP 502/);
  assert.equal(out.find((m) => m.id === 6).error.code, -32602);
  assert.equal(out.find((m) => m.id === 7).error.code, -32602);
});

test('mcp: an unexpected failure in a handler is a JSON-RPC internal error, a notification stays silent', async () => {
  const c = client({ root: tmp(), fetchImpl: async () => { throw new Error('unused'); } });
  const realParse = JSON.parse;
  // A request whose params getter throws: reaches the handler's rejection branch.
  const bad = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  Object.defineProperty(bad, 'params', { get() { throw new Error('kaboom'); }, enumerable: true });
  const quiet = { jsonrpc: '2.0', method: 'initialize' };
  Object.defineProperty(quiet, 'params', { get() { throw new Error('quiet'); }, enumerable: true });
  JSON.parse = (s) => (s === 'BAD-REQUEST' ? bad : s === 'BAD-NOTIFICATION' ? quiet : realParse(s));
  try {
    c.send('BAD-REQUEST');
    c.send('BAD-NOTIFICATION');
    const out = await c.finish();
    assert.equal(out.length, 1);
    assert.equal(out[0].error.code, -32603);
    assert.equal(out[0].error.message, 'kaboom');
  } finally {
    JSON.parse = realParse;
  }
});

test('mcp: close() stops serving', async () => {
  const c = client({ root: tmp() });
  c.server.close();
  await c.server.done;
});
