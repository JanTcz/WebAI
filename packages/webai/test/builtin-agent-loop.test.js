import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../bin/webai-agent.js';

const AGENT = fileURLToPath(new URL('../bin/webai-agent.js', import.meta.url));

// A fake OpenAI-compatible server: scripted replies in order, the last one repeats.
let script = [];
let requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url;
    if (url.startsWith('/img/')) {
      if (url === '/img/big.jpg') return res.end(Buffer.alloc(10 * 1024 * 1024 + 1));
      if (url === '/img/ok.jpg') return res.end(Buffer.alloc(2048, 1));
      res.writeHead(404);
      return res.end();
    }
    requests.push({ url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const next = script.length > 1 ? script.shift() : script[0];
    res.writeHead(next.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(next.raw ?? JSON.stringify(next.body));
  });
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const reply = (content, tool_calls, extra = {}) => ({ body: { choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) } }], ...extra } });
const call = (name, args, id = `c-${name}-${Math.random()}`) => ({ id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webai-agent-'));
}

async function run(args, { cwd = tmp(), prompt = 'do it', env = {}, steps } = {}) {
  script = steps;
  requests = [];
  const lines = [];
  const code = await runAgent(args, { cwd, env, readPrompt: () => prompt, write: (s) => lines.push(JSON.parse(s)) });
  return { code, events: lines, cwd };
}
const std = (extra = []) => ['--session', 'sess 1!', '--base-url', `${base}/`, '--model', 'm1', ...extra];

async function withFakeOpenverse(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => (String(url).startsWith('https://api.openverse.org/') ? handler(String(url)) : real(url, ...rest));
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('all tools in one turn, with errors reported to the model', async () => {
  const cwd = tmp();
  const w = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
    fs.writeFileSync(path.join(cwd, p), c);
  };
  w('src/a.astro', 'one\n  <p class="x">hi</p>\ntwo\n');
  w('src/dup.txt', 'x\nx\n');
  w('src/hits.txt', Array.from({ length: 120 }, () => 'needle').join('\n'));
  w('big.txt', 'a'.repeat(200_001));
  w('logo.png', 'png');
  w('del.txt', 'bye');
  w('node_modules/skip/x.js', 'needle');
  fs.mkdirSync(path.join(cwd, 'emptydir'));
  const hit = (id, extra = {}) => ({ id, title: `T "${id}" <b>`, creator: extra.creator, license: extra.license ?? 'by', license_version: extra.v, width: extra.w, height: extra.h, url: `${base}/img/${extra.file ?? 'ok'}.jpg`, thumbnail: `${base}/img/${extra.thumb ?? 'ok'}.jpg`, foreign_landing_url: extra.page });
  const results = [hit('i1', { creator: 'Ann', v: '4.0', w: 10, h: 20, page: 'http://p' }), hit('i2', { license: 'cc0' }), hit('i3', { license: 'pdm', file: 'big' }), hit('i4', { file: 'missing', thumb: 'missing' }), { id: 'i5', license: 'by-sa', url: `${base}/img/ok.jpg`, thumbnail: `${base}/img/ok.jpg` }];
  const calls = [
    call('list_files', {}),
    call('list_files', { dir: 'src' }),
    call('list_files', { dir: '../x' }),
    call('list_files', { dir: 'emptydir' }),
    call('search_files', { pattern: 'NEEDLE' }),
    call('search_files', { pattern: 'two', dir: 'src' }),
    call('search_files', { pattern: 'zzzz-none' }),
    call('search_files', { pattern: 'x', dir: '../x' }),
    call('search_files', { pattern: '(' }),
    call('read_file', { path: 'src/a.astro' }),
    call('read_file', { path: 'nope.txt' }),
    call('read_file', { path: 'logo.png' }),
    call('read_file', { path: 'big.txt' }),
    call('read_file', { path: '../secret' }),
    call('edit_file', { path: 'src/a.astro', old_text: '<p class="x">hi</p>', new_text: '<p class="x">yo</p>' }),
    call('edit_file', { path: 'src/a.astro', old_text: 'two', new_text: undefined }),
    call('edit_file', { path: 'src/dup.txt', old_text: 'x', new_text: 'y' }),
    call('edit_file', { path: 'src/dup.txt', old_text: 'q', new_text: 'y' }),
    call('edit_file', { path: 'src/dup.txt', old_text: '' }),
    call('edit_file', { path: 'missing.txt', old_text: 'a' }),
    call('write_file', { path: 'new/dir/f.css', content: 'p{}' }),
    call('write_file', { path: 'new/empty.txt' }),
    call('write_file', { path: 'bin.exe', content: 'x' }),
    call('delete_file', { path: 'del.txt' }),
    call('delete_file', { path: 'del.txt' }),
    call('search_images', { query: 'cat' }),
    call('search_images', {}),
    call('add_image', { id: 'nope', path: 'public/a.jpg' }),
    call('add_image', { id: 'i1', path: 'public/a.txt' }),
    call('add_image', { id: 'i1', path: 'public/images/a.jpg' }),
    call('add_image', { id: 'i2', path: 'src/assets/b.png' }),
    call('add_image', { id: 'i3', path: 'c.webp' }),
    call('add_image', { id: 'i4', path: 'd.gif' }),
    call('add_image', { id: 'i5', path: 'e.avif' }),
    call('mystery', {}),
    call('read_file', '{not json'),
    call('read_file', undefined),
    { id: 'no-fn' },
  ];
  calls[calls.length - 2] = { id: 'noargs', function: { name: 'list_files' } };
  const steps = [reply('', calls), reply('  all done  ')];
  let ovCalls = 0;
  const r = await withFakeOpenverse(
    async () => {
      ovCalls++;
      return ovCalls === 1 ? new Response(JSON.stringify({ results })) : new Response('{}');
    },
    () => run(std(), { cwd, steps }),
  );
  assert.equal(r.code, 0);
  assert.equal(ovCalls, 2);
  const last = r.events.at(-1);
  assert.deepEqual([last.type, last.ok, last.costUsd], ['done', true, 0]);
  assert.ok(r.events.some((e) => e.type === 'text' && e.text === 'all done'));
  const errors = r.events.filter((e) => e.type === 'tool-error').map((e) => e.text);
  for (const m of [/Not a project folder: \.\.\/x/, /No such file: nope\.txt/, /too large/, /Not a project path: \.\.\/secret/, /occurs 2 times/, /not found/, /old_text is empty/, /Only text files/, /Unknown id/, /Use a path like/, /could not be downloaded/, /Unknown tool: mystery/, /not valid JSON/, /Invalid regular|Unterminated/i]) {
    assert.ok(errors.some((e) => m.test(e)), String(m));
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'src/a.astro'), 'utf8'), 'one\n  <p class="x">yo</p>\n\n');
  assert.ok(!fs.existsSync(path.join(cwd, 'del.txt')));
  assert.ok(fs.existsSync(path.join(cwd, 'public/images/a.jpg')));
  assert.ok(fs.existsSync(path.join(cwd, 'src/assets/b.png')));
  assert.ok(fs.existsSync(path.join(cwd, 'c.webp')));
  const toolMsgs = requests[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(toolMsgs.some((c) => c.includes('<img src="/images/a.jpg" alt="T &quot;i1&quot; &lt;b&gt;">') && c.includes('by Ann') && c.includes('<a href="http://p">')));
  assert.ok(toolMsgs.some((c) => c.includes('src="src/assets/b.png"') && !c.includes('figcaption')));
  assert.ok(toolMsgs.some((c) => c.includes('<img src="e.avif" alt="">') && c.includes('<a href="' + base + '/img/ok.jpg"></a>, CC BY-SA')));
  assert.ok(toolMsgs.some((c) => c.includes('No images found')));
  assert.ok(toolMsgs.some((c) => c.includes('Binary or non-text')));
  assert.ok(toolMsgs.some((c) => c.includes('(empty)')));
  // the session is stored under a sanitized name
  assert.ok(fs.existsSync(path.join(cwd, '.webai/agent/sess1.json')));
});

test('Openverse errors: 429 and other statuses; missing url fetch failures', async () => {
  for (const [status, re] of [[429, /limit reached/], [500, /failed \(500\)/]]) {
    const r = await withFakeOpenverse(async () => new Response('', { status }), () => run(std(), { steps: [reply('', [call('search_images', { query: 'x' })]), reply('ok')] }));
    assert.match(r.events.find((e) => e.type === 'tool-error').text, re);
  }
  // fetch itself throwing for an image url is tolerated, then "could not be downloaded"
  const results = [{ id: 'z', title: 't', license: 'by', license_version: '2', url: 'http://127.0.0.1:1/x.jpg', thumbnail: 'http://127.0.0.1:1/y.jpg' }];
  const r = await withFakeOpenverse(async () => new Response(JSON.stringify({ results })), () =>
    run(std(), { steps: [reply('', [call('search_images', { query: 'x' })]), reply('', [call('add_image', { id: 'z', path: 'a.jpg' })]), reply('ok')] }));
  assert.match(r.events.find((e) => e.type === 'tool-error').text, /could not be downloaded/);
});

test('request shape: key, openrouter usage and cost, system prompt', async () => {
  const r = await run(['--session', 's', '--base-url', `${base}/openrouter.ai`, '--model', 'm', '--system', 'SYS'], {
    env: { OPENROUTER_API_KEY: 'k-or' },
    steps: [reply('hi', undefined, { usage: { cost: 0.25 } })],
  });
  assert.equal(requests[0].headers.authorization, 'Bearer k-or');
  assert.deepEqual(requests[0].body.usage, { include: true });
  assert.match(requests[0].body.messages[0].content, /^SYS\n\nYou work on a website/);
  assert.equal(r.events.at(-1).costUsd, 0.25);

  await run(std(), { env: { WEBAI_API_KEY: 'k1', OPENROUTER_API_KEY: 'no' }, steps: [{ body: { choices: [{ message: {} }] } }] });
  assert.equal(requests[0].headers.authorization, 'Bearer k1');
  assert.equal(requests[0].body.usage, undefined);
  assert.equal(requests[0].body.messages[0].content.startsWith('You work'), true);

  await run(std(), { steps: [reply('x')] });
  assert.equal(requests[0].headers.authorization, undefined);
  // openrouter url without any key
  await run(['--session', 's', '--base-url', `${base}/openrouter.ai`, '--model', 'm'], { steps: [reply('x')] });
  assert.equal(requests[0].headers.authorization, undefined);
});

test('usage error without base-url, model or session', async () => {
  const r = await run(['--model', 'm'], { steps: [reply('x')] });
  assert.equal(r.code, 1);
  assert.match(r.events[0].error, /usage: webai-agent/);
  assert.equal(r.events[0].ok, false);
});

test('fallbacks on busy models, errors otherwise', async () => {
  let r = await run(std(['--fallbacks', 'm1, m2 ,m3']), {
    steps: [{ status: 503, body: {} }, { status: 429, body: { error: { message: 'upstream busy' } } }, reply('from m3')],
  });
  assert.deepEqual(r.events.filter((e) => e.type === 'status').map((e) => e.text), ['m1 is busy, switching to m2…', 'm2 is busy, switching to m3…']);
  assert.equal(requests.at(-1).body.model, 'm3');

  // 200 without choices on a non-last candidate moves on, on the last one it fails
  r = await run(std(['--fallbacks', 'm2']), { steps: [{ body: {} }, { body: { choices: [] } }] });
  assert.match(r.events.at(-1).error, /returned no response/);

  r = await run(std(['--fallbacks', 'm2']), { steps: [{ status: 502, raw: 'not json' }, { status: 500, body: { message: 'boom' } }] });
  assert.match(r.events.at(-1).error, /API error 500: boom/);

  r = await run(std(), { steps: [{ status: 401, body: { error: { message: 'bad key' } } }] });
  assert.match(r.events.at(-1).error, /rejected the key \(401\).*bad key/);
  r = await run(std(), { steps: [{ status: 429, body: { error: { message: 'slow' } } }] });
  assert.match(r.events.at(-1).error, /rate limiting requests \(429\).*slow/);
  r = await run(std(), { steps: [{ status: 401, raw: '' }] });
  assert.match(r.events.at(-1).error, /\(401\)\. Set WEBAI_API_KEY[^]*runs\.$/);
  r = await run(std(), { steps: [{ status: 400, body: { error: { message: { a: 'x'.repeat(700) } } } }] });
  assert.ok(r.events.at(-1).error.length <= 600);
  r = await run(std(), { steps: [{ status: 400, raw: '' }] });
  assert.equal(r.events.at(-1).error, 'API error 400: ');
  // a busy 429 that is the only model: error shown
  r = await run(std(), { steps: [{ status: 429, body: { error: { message: 'overloaded' } } }] });
  assert.match(r.events.at(-1).error, /429/);
});

test('--resume repairs an interrupted tool call and continues the stored conversation', async () => {
  const cwd = tmp();
  const store = path.join(cwd, '.webai/agent/s.json');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify([
    { role: 'user', content: 'before' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'list_files', arguments: '{}' } }, { id: 'b', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'x' },
  ]));
  await run(['--session', 's', '--resume', '--base-url', base, '--model', 'm'], { cwd, prompt: 'again', steps: [reply('ok')] });
  const sent = requests[0].body.messages;
  assert.equal(sent.find((m) => m.tool_call_id === 'b').content, 'Error: interrupted.');
  assert.equal(sent.at(-1).content, 'again');
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).length, 6);
  // --resume without a stored file starts fresh
  await run(['--session', 'other', '--resume', '--base-url', base, '--model', 'm'], { cwd, steps: [reply('ok')] });
  assert.equal(requests[0].body.messages.length, 2);
  // without --resume the stored conversation is ignored
  await run(['--session', 's', '--base-url', base, '--model', 'm'], { cwd, steps: [reply('ok')] });
  assert.equal(requests[0].body.messages.length, 2);
});

test('gives up after 25 steps', async () => {
  const r = await run(std(), { steps: [reply('', [call('list_files', {})])] });
  assert.equal(requests.length, 25);
  assert.equal(r.events.at(-1).ok, false);
  assert.match(r.events.at(-1).error, /25 steps/);
});

test('runs as a script: prompt on stdin, JSON lines on stdout', async () => {
  script = [reply('hello from child')];
  requests = [];
  const cwd = tmp();
  const child = spawn(process.execPath, [AGENT, '--session', 'c', '--base-url', base, '--model', 'm'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stdin.end('prompt');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  const events = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['text', 'done']);
  assert.equal(requests[0].body.messages.at(-1).content, 'prompt');

  const bad = spawn(process.execPath, [AGENT], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  let o2 = '';
  bad.stdout.on('data', (c) => (o2 += c));
  bad.stdin.end();
  assert.equal(await new Promise((r) => bad.on('close', r)), 1);
  assert.equal(JSON.parse(o2).ok, false);
});

test('runAgent defaults to the real process (stdin/stdout/cwd/env)', async () => {
  script = [reply('real')];
  requests = [];
  const cwd = tmp();
  const before = process.cwd();
  const written = [];
  const origWrite = process.stdout.write;
  const origRead = fs.readFileSync;
  process.chdir(cwd);
  process.stdout.write = (s) => (written.push(String(s)), true);
  fs.readFileSync = (f, ...rest) => (f === 0 ? 'stdin prompt' : origRead(f, ...rest));
  try {
    assert.equal(await runAgent(['--session', 'd', '--base-url', base, '--model', 'm']), 0);
    assert.equal(await runAgent([]), 1);
  } finally {
    process.stdout.write = origWrite;
    fs.readFileSync = origRead;
    process.chdir(before);
  }
  assert.equal(requests[0].body.messages.at(-1).content, 'stdin prompt');
  assert.match(written.join(''), /"type":"done","ok":true/);
  assert.match(written.join(''), /usage: webai-agent/);
});
