import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { describeAgents } from '../src/session.js';
import { adapter, cleanup, collect, make, msg, next, settled } from './session-helpers.js';

after(cleanup);

const agent = (name, extra = {}) => adapter('', { name, label: name.toUpperCase(), ...extra });
const done = `out({type:'done',ok:true})`;

function seed(files) {
  // a project dir with state files written before the session is created
  return Object.fromEntries(Object.entries(files).map(([f, v]) => [`.webai/${f}`, typeof v === 'string' ? v : JSON.stringify(v)]));
}

test('session: load restores settings, sessions and transcript, skipping broken lines', () => {
  const lines = [JSON.stringify({ type: 'user', seq: 3 }), '{"truncated', '', JSON.stringify({ type: 'done', seq: 7 })].join('\n');
  const { s } = make(
    { a: agent('a'), b: agent('b') },
    {
      files: seed({
        'settings.json': { agent: 'b' },
        'session.json': { sessions: { b: { sessionId: 'X', started: true } } },
        'transcript.jsonl': lines,
      }),
    },
  );
  assert.equal(s.settings.agent, 'b');
  assert.equal(s.current.sessionId, 'X');
  assert.deepEqual(s.events.map((e) => e.seq), [3, 7]);
  assert.equal(s.seq, 7);
  // missing totalCostUsd falls back to 0
  assert.equal(s.snapshot().session.totalCostUsd, 0);
  assert.equal(s.snapshot().agent, 'B');
});

test('session: load trims an overlong transcript and emit keeps the cap', () => {
  const lines = Array.from({ length: 1005 }, (_, i) => JSON.stringify({ type: 'text', seq: i + 1 })).join('\n');
  const { s, root } = make({ a: agent('a') }, { files: seed({ 'transcript.jsonl': lines, 'session.json': { nope: 1 } }) });
  assert.equal(s.events.length, 1000);
  assert.equal(s.events[0].seq, 6);
  assert.equal(fs.readFileSync(path.join(root, '.webai/transcript.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1000);
  s.emit({ type: 'text' });
  assert.equal(s.events.length, 1000);
  assert.equal(s.events.at(-1).seq, 1006);
  assert.equal(s.events[0].seq, 7);
});

test('session: sanitize keeps only valid settings', () => {
  const sel = [{ value: 'a' }, { value: 'off', disabled: true }];
  const { s } = make({
    x: agent('x', { settings: { model: sel, note: { type: 'text' }, fixed: Object.assign([{ value: 'z' }], { readonly: true }) } }),
    y: agent('y'),
  });
  const out = s.sanitize({ agent: 'nope', x: { model: 'a', note: '  hi  ', fixed: 'z', other: 'q' }, y: { k: 'v' } });
  assert.deepEqual(out, { agent: 'x', x: { model: 'a', note: 'hi' }, y: {} });
  const out2 = s.sanitize({ agent: 'y', x: { model: 'off', note: 5 } });
  assert.deepEqual(out2, { agent: 'y', x: {}, y: {} });
  assert.equal(s.sanitize({ note: '' }).agent, 'x');
  // the readonly flag is on the spec object itself
  const ro = make({ r: agent('r', { settings: { k: { type: 'text', readonly: true } } }) }).s;
  assert.deepEqual(ro.sanitize({ r: { k: 'v' } }).r, {});
});

test('session: setSettings validates, persists, logs and announces the switch', () => {
  const info = [];
  const { s, root } = make(
    { a: agent('a', { settings: { note: { type: 'text' } } }), b: agent('b') },
    { logger: { info: (m) => info.push(m) } },
  );
  s.available = { a: '1', b: null };
  const evs = collect(s);
  assert.throws(() => s.setSettings({ agent: 'b' }), { status: 400, message: 'B is not installed.' });
  assert.deepEqual(s.setSettings({ a: { note: 'x' } }).a, { note: 'x' });
  assert.equal(info.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.webai/settings.json'), 'utf8')).a, { note: 'x' });
  s.setSettings({ a: { note: 'x' } }); // unchanged: no log
  s.setSettings({}); // keeps the agent
  assert.equal(info.length, 1);
  assert.equal(evs.length, 0);

  s.available.b = '2';
  s.setSettings({ agent: 'b' });
  assert.match(evs.at(-1).text, /Switched to B\. Starting its own conversation/);
  s.current.started = true;
  s.setSettings({ agent: 'a' });
  s.setSettings({ agent: 'b' });
  assert.match(evs.at(-1).text, /Resuming its previous conversation/);

  // no logger: still fine
  const m = make({ a: agent('a'), b: agent('b') });
  m.s.available = { a: '1', b: '1' };
  m.s.setSettings({ agent: 'b' });
  assert.equal(m.s.settings.agent, 'b');
});

test('session: cannot switch agents while busy', async () => {
  const a = adapter(`out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const { s } = make({ fake: a, other: agent('other') });
  const ready = next(s, 'text');
  s.send(msg());
  await ready;
  assert.throws(() => s.setSettings({ agent: 'other' }), { status: 409 });
  s.setSettings({ agent: 'fake' }); // the same agent is fine
  assert.throws(() => s.send(msg()), /still working/);
  assert.throws(() => s.restoreVersion(0), { status: 409 });
  s.stop();
  await next(s, 'done');
  await settled(s);
});

test('session: send refuses an agent that is not installed', () => {
  const { s } = make({ a: agent('a') });
  s.available.a = null;
  assert.throws(() => s.send(msg()), /A is not installed/);
});

test('session: detect probes the CLIs and falls back to an available agent', async () => {
  const node = (args, extra = {}) => agent(extra.name, { bin: process.execPath, versionArgs: args, ...extra });
  const { s } = make({
    custom: agent('custom'),
    ver: node(['-e', 'console.log("tool v1.2.3-beta")'], { name: 'ver' }),
    word: node(['-e', 'console.log("hello")'], { name: 'word' }),
    empty: node(['-e', ''], { name: 'empty' }),
    bad: node(['-e', 'process.exit(1)'], { name: 'bad' }),
    missing: agent('missing', { bin: '/nonexistent/webai-bin' }),
  });
  s.settings.agent = 'missing';
  const available = await s.detect();
  assert.equal(available.custom, 'custom command');
  assert.equal(available.ver, '1.2.3-beta');
  assert.equal(available.word, 'hello');
  assert.equal(available.empty, process.execPath);
  assert.equal(available.bad, null);
  assert.equal(available.missing, null);
  assert.equal(s.settings.agent, 'custom');
  assert.equal(describeAgents(s), 'CUSTOM ✓, VER ✓, WORD ✓, EMPTY ✓, BAD ✗, MISSING ✗');

  // nothing available: the selection stays; default versionArgs
  const m = make({ only: agent('only', { bin: '/nonexistent/webai-bin' }) });
  await m.s.detect();
  assert.equal(m.s.settings.agent, 'only');

  // a probe that hangs is killed after the timeout
  const h = make({ slow: agent('slow', { bin: process.execPath, versionArgs: ['-e', 'setInterval(()=>{},1000)'] }) });
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = h.s.detect();
  mock.timers.tick(15000);
  mock.timers.reset();
  assert.equal((await p).slow, null);
});

test('session: version() tolerates a failing history, restoreVersion announces', async () => {
  const warned = [];
  const { s, root } = make({ a: agent('a') }, { logger: { warn: (m) => warned.push(m) } });
  s.history.snapshot = () => { throw new Error('disk'); };
  s.version('x');
  assert.deepEqual(warned, ['webai: version history: disk']);
  const bare = make({ a: agent('a') }).s;
  bare.history.snapshot = () => { throw new Error('disk'); };
  bare.version('x'); // no logger

  const m = make({ a: agent('a') });
  const evs = collect(m.s);
  fs.writeFileSync(path.join(m.root, 'f.txt'), '1');
  m.s.version('one');
  assert.equal(evs.at(-1).type, 'history');
  assert.equal(evs.at(-1).reload, false);
  m.s.version('unchanged');
  assert.equal(evs.length, 1);
  fs.writeFileSync(path.join(m.root, 'f.txt'), '2');
  m.s.version('two', { reload: true });
  const list = m.s.restoreVersion('0');
  assert.equal(list.current, 0);
  assert.deepEqual(evs.slice(-2).map((e) => e.type), ['status', 'history']);
  assert.equal(evs.at(-2).text, 'Version 1 of 2: one');
  assert.equal(evs.at(-1).reload, true);
  assert.equal(fs.readFileSync(path.join(m.root, 'f.txt'), 'utf8'), '1');
});

test('session: send labels the first version Start, later ones Your edits', async () => {
  const { s, root } = make({ fake: adapter(done) });
  let d = next(s, 'done');
  s.send(msg('first'));
  await d;
  await settled(s);
  fs.writeFileSync(path.join(root, 'by-hand.txt'), 'x');
  d = next(s, 'done');
  s.send(msg('second'));
  await d;
  await settled(s);
  assert.deepEqual(s.history.list().versions.map((v) => v.label), ['Start', 'Your edits']);
});

test('session: stop escalates to SIGTERM for an agent that ignores SIGINT', async () => {
  const a = adapter(`process.on('SIGINT',()=>{}); out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const { s } = make({ fake: a });
  const ready = next(s, 'text');
  s.send(msg());
  await ready;
  mock.timers.enable({ apis: ['setTimeout'] });
  s.stop();
  mock.timers.tick(3000);
  mock.timers.reset();
  assert.equal((await next(s, 'done')).error, 'Stopped.');

  // exited already by SIGINT: the timer finds nothing to kill
  const b = adapter(`out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const m = make({ fake: b });
  const r2 = next(m.s, 'text');
  m.s.send(msg());
  await r2;
  const closed = new Promise((r) => m.s.proc.once('close', r));
  // no timeout timer here: clearTimeout would be mocked while the real one is pending
  const d = new Promise((r) => { const un = m.s.subscribe((ev) => ev.type === 'done' && (un(), r(ev))); });
  mock.timers.enable({ apis: ['setTimeout'] });
  m.s.stop();
  await closed;
  mock.timers.tick(3000);
  mock.timers.reset();
  assert.equal((await d).error, 'Stopped.');
});

test('session: cleanup after stop is asynchronous, a failing cleanup is ignored', async () => {
  const marker = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'webai-marker-')), 'cleaned');
  const mk = (cleanup) => adapter('', {
    command: () => ({
      cmd: process.execPath,
      args: ['-e', `console.log(JSON.stringify({events:[{type:'text',text:'ready'}]})); setInterval(()=>{},1000)`],
      cleanup,
    }),
  });
  const { s } = make({ fake: mk({ cmd: process.execPath, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`] }) });
  let ready = next(s, 'text');
  s.send(msg());
  await ready;
  s.stop();
  await next(s, 'done');
  await settled(s);
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');

  const m = make({ fake: mk({ cmd: '/nonexistent/webai-cleanup', args: [] }) });
  ready = next(m.s, 'text');
  m.s.send(msg());
  await ready;
  m.s.stop();
  await next(m.s, 'done');
  await settled(m.s);
  await new Promise((r) => setTimeout(r, 50)); // the spawn error is swallowed
  fs.rmSync(path.dirname(marker), { recursive: true, force: true });
});

test('session: killing a group that is already gone is harmless', () => {
  const { s } = make({ a: agent('a') });
  s.proc = { pid: 99999999 };
  s.dispose();
  assert.equal(s.proc, null);
});

test('session: reset forgets conversations and discards the old output', async () => {
  const a = adapter(`out({type:'session',id:'S'}); out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const { s, root } = make({ fake: a });
  const evs = collect(s);
  const ready = next(s, 'text');
  s.send(msg());
  await ready;
  s.reset();
  assert.equal(s.busy, false);
  assert.deepEqual(s.state, { sessions: {} });
  assert.deepEqual(s.events.map((e) => e.type), ['reset']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.webai/session.json'), 'utf8')).sessions.fake, undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(evs.some((e) => e.type === 'done'), false);
  // idle reset
  s.reset();
});

test('session: on win32 the agent is not detached and only the process is killed', async () => {
  const real = process.platform;
  const a = adapter(`out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const { s } = make({ fake: a });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const ready = next(s, 'text');
    s.send(msg());
    await ready;
    s.stop();
    assert.equal((await next(s, 'done')).error, 'Stopped.');
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
  await settled(s);
});

test('session: describeAgents falls back to the name', () => {
  const { s } = make({ plain: adapter('', { label: undefined }) });
  s.available.plain = null;
  assert.equal(describeAgents(s), 'plain ✗');
  assert.equal(s.snapshot().agents[0].label, 'plain');
});

test('session: without agents the selection stays empty', () => {
  const { s } = make({}, { files: seed({ 'settings.json': { agent: 'x' } }) });
  assert.equal(s.settings.agent, undefined);
});

test('session: a start error after reset is not reported', async () => {
  const a = adapter('', { command: () => ({ cmd: '/nonexistent/webai-agent', args: [] }) });
  const { s } = make({ fake: a });
  const evs = collect(s);
  s.send(msg());
  s.reset();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(evs.some((e) => e.type === 'done'), false);
});

test('session: a saved session without a cost total is priced from zero', async () => {
  const a = adapter(`out({type:'done',ok:true,totalCostUsd:1.5})`);
  const { s } = make({ fake: a }, { files: seed({ 'session.json': { sessions: { fake: { sessionId: null, started: false } } } }) });
  const done = next(s, 'done');
  s.send(msg());
  assert.equal((await done).costUsd, 1.5);
  await settled(s);
});

test('session: the process exit hook disposes the session', () => {
  const { s } = make({ a: agent('a') });
  s.proc = { pid: 99999999 };
  s.onExit();
  assert.equal(s.proc, null);
});
