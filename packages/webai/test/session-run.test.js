import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { adapter, cleanup, collect, make, msg, next, settled } from './session-helpers.js';

after(cleanup);

test('session: streams events, saves session id and cost, makes versions', async () => {
  const a = adapter(`
    require('fs').writeFileSync('page.html', process.argv[1]);
    out({type:'session', id:'S1'});
    console.log('');
    console.log('not json');
    out({type:'delta', text:'h'}, {type:'text', text:'hi'});
    out({type:'done', ok:true, totalCostUsd:0.5});
    process.stdout.write(JSON.stringify({events:[{type:'text',text:'tail'}]}));`);
  const { s, root } = make({ fake: a });
  const evs = collect(s);
  const done = next(s, 'done');
  s.send({ message: 'make it red', element: { tag: 'h1' } });
  assert.equal((await done).costUsd, 0.5);
  await settled(s);
  const types = evs.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['history', 'user', 'status']);
  assert.ok(types.includes('delta'));
  assert.ok(evs.some((e) => e.type === 'text' && e.text === 'tail'));
  assert.equal(s.current.sessionId, 'S1');
  assert.equal(s.current.started, true);
  assert.equal(s.current.totalCostUsd, 0.5);
  assert.equal(s.busy, false);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.webai/session.json'), 'utf8'));
  assert.equal(saved.sessions.fake.sessionId, 'S1');
  // deltas are not stored in the transcript
  const transcript = fs.readFileSync(path.join(root, '.webai/transcript.jsonl'), 'utf8');
  assert.ok(!transcript.includes('"delta"'));
  assert.equal(s.history.list().versions.at(-1).label, 'make it red');
  assert.match(fs.readFileSync(path.join(root, 'page.html'), 'utf8'), /\[Request\]\nmake it red/);
  assert.deepEqual(s.snapshot().session, { id: 'S1', started: true, totalCostUsd: 0.5 });
});

test('session: second turn resumes and prices only the difference', async () => {
  const a = adapter('', {
    presetSessionId: true,
    command: ({ resume }) => ({
      cmd: process.execPath,
      args: ['-e', `const out=(...e)=>console.log(JSON.stringify({events:e}));
        out({type:'session',id:${JSON.stringify(resume ? 'R' : 'N')}});
        out({type:'done',ok:true,totalCostUsd:${resume ? 0.75 : 0.5}});`],
    }),
  });
  const { s } = make({ fake: a });
  assert.match(s.current.sessionId, /^[0-9a-f-]{36}$/);
  let done = next(s, 'done');
  s.send(msg());
  assert.equal((await done).costUsd, 0.5);
  await settled(s);
  done = next(s, 'done');
  s.send(msg());
  assert.equal((await done).costUsd, 0.25);
  await settled(s);
  assert.equal(s.current.sessionId, 'R');
});

test('session: session event without id keeps the id, done with costUsd is not repriced', async () => {
  const a = adapter(`out({type:'session'}); out({type:'done',ok:true,totalCostUsd:2,costUsd:1}); out({type:'done',ok:true})`, { presetSessionId: true });
  const { s } = make({ fake: a });
  const id = s.current.sessionId;
  const done = next(s, 'done');
  s.send(msg());
  assert.equal((await done).costUsd, 1);
  await settled(s);
  assert.equal(s.current.sessionId, id);
  assert.equal(s.current.totalCostUsd, 0);
});

test('session: raw output passes every line, even empty ones', async () => {
  const a = adapter(`console.log('a'); console.log(''); process.stdout.write('last');`, {
    raw: true,
    parse: (line) => [{ type: 'text', text: line }, ...(line === 'last' ? [{ type: 'done', ok: true }] : [])],
  });
  const { s } = make({ fake: a });
  const evs = collect(s);
  const done = next(s, 'done');
  s.send(msg());
  await done;
  assert.deepEqual(evs.filter((e) => e.type === 'text').map((e) => e.text), ['a', '', 'last']);
});

test('session: exit without done reports stderr, exit code or Stopped', async () => {
  const { s } = make({ fake: adapter(`console.error('boom'); process.exit(2)`) });
  let done = next(s, 'done');
  s.send(msg());
  assert.deepEqual([(await done).ok, (await done).error], [false, 'boom']);

  const b = adapter(`process.exit(3)`);
  const m = make({ fake: b });
  done = next(m.s, 'done');
  m.s.send(msg());
  assert.equal((await done).error, 'Agent exited with code 3.');
});

test('session: onExit adapter builds the events, the exit info says if it was stopped', async () => {
  const exits = [];
  const a = adapter(`process.on('SIGINT',()=>process.exit(0)); out({type:'text',text:'ready'}); setInterval(()=>{},1000)`, {
    onExit: (exit, ctx) => (exits.push({ ...exit, stderr: ctx.stderr }), [{ type: 'done', ok: false, error: 'custom' }]),
  });
  const { s } = make({ fake: a });
  await Promise.resolve();
  const ready = next(s, 'text');
  s.send(msg());
  await ready;
  assert.equal(s.stop(), true);
  assert.equal((await next(s, 'done')).error, 'custom');
  assert.deepEqual(exits, [{ code: 0, signal: 'SIGINT', stderr: '' }]);

  // a plain exit is not "stopped"
  const b = make({ fake: adapter(`process.exit(5)`, { onExit: (e) => (exits.push(e), [{ type: 'done', ok: false, error: 'x' }]) }) });
  const done = next(b.s, 'done');
  b.s.send(msg());
  await done;
  assert.deepEqual(exits.at(-1), { code: 5, signal: null });
});

test('session: a stopped agent without onExit says Stopped.', async () => {
  const a = adapter(`out({type:'text',text:'ready'}); setInterval(()=>{},1000)`);
  const { s } = make({ fake: a });
  const ready = next(s, 'text');
  s.send(msg());
  await ready;
  s.stop();
  const ev = await next(s, 'done');
  assert.equal(ev.error, 'Stopped.');
  assert.equal(s.stop(), false);
});

test('session: missing session starts a new one once', async () => {
  const calls = [];
  const a = adapter('', {
    presetSessionId: true,
    isMissingSession: (stderr) => stderr.includes('gone'),
    command: ({ resume, sessionId }) => {
      calls.push({ resume, sessionId });
      const script = resume
        ? `console.error('gone'); process.exit(1)`
        : `console.log(JSON.stringify({events:[{type:'done',ok:true}]}))`;
      return { cmd: process.execPath, args: ['-e', script] };
    },
  });
  const { s } = make({ fake: a });
  const evs = collect(s);
  const first = s.current.sessionId;
  s.current.started = true;
  const done = next(s, 'done');
  s.send(msg());
  assert.equal((await done).ok, true);
  assert.deepEqual(calls.map((c) => c.resume), [true, false]);
  assert.notEqual(calls[1].sessionId, first);
  assert.ok(evs.some((e) => e.type === 'status' && /not found/.test(e.text)));

  // already retried: the second failure is reported
  const b = adapter('', {
    presetSessionId: true,
    isMissingSession: () => true,
    command: () => ({ cmd: process.execPath, args: ['-e', `process.exit(1)`] }),
  });
  const m = make({ fake: b });
  m.s.current.started = true;
  const d2 = next(m.s, 'done');
  m.s.send(msg());
  assert.equal((await d2).error, 'Agent exited with code 1.');
});

test('session: prepare runs once, reports created paths and failures', async () => {
  const logged = [];
  const calls = [];
  const a = adapter(`out({type:'done',ok:true})`, {
    prepare: () => (calls.push(1), calls.length === 1 ? ['.claude/skills'] : calls.length === 2 ? [] : (() => { throw new Error('nope'); })()),
  });
  const { s } = make({ fake: a }, { logger: { info: (m) => logged.push(m) } });
  const evs = collect(s);
  for (let i = 0; i < 2; i++) {
    const done = next(s, 'done');
    s.send(msg());
    await done;
    await settled(s);
  }
  assert.equal(calls.length, 1);
  assert.ok(evs.some((e) => /Skills for Fake: \.claude\/skills/.test(e.text ?? '')));
  assert.deepEqual(logged, ['Created for Fake: .claude/skills']);

  // empty list: nothing reported; throwing prepare: reported as status
  for (const [prepare, reported] of [[() => [], false], [() => { throw new Error('nope'); }, true]]) {
    const m = make({ fake: adapter(`out({type:'done',ok:true})`, { prepare }) });
    const e = collect(m.s);
    const done = next(m.s, 'done');
    m.s.send(msg());
    await done;
    await settled(m.s);
    assert.equal(e.some((x) => /Skills for|Failed to prepare skills for Fake: nope/.test(x.text ?? '')), reported);
  }
});

test('session: wrapPrompt, stdin, promptInArgs, env and a failing command()', async () => {
  const got = [];
  const stdinScript = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{out({type:'text',text:d+'|'+process.env.X+'|'+process.argv.length},{type:'done',ok:true})})`;
  const a = adapter('', {
    wrapPrompt: (p, ctx) => (got.push(ctx), 'W:' + p),
    command: ({ prompt }) => ({ cmd: process.execPath, args: ['-e', 'const out=(...e)=>console.log(JSON.stringify({events:e}));' + stdinScript], stdin: true, env: { X: 'y' } }),
  });
  const { s } = make({ fake: a });
  const evs = collect(s);
  let done = next(s, 'done');
  s.send(msg('hello'));
  await done;
  assert.equal(evs.find((e) => e.type === 'text').text, 'W:hello|y|1');
  assert.equal(got[0].resume, false);
  assert.match(got[0].systemPrompt, /browser overlay/);

  const b = adapter('', {
    command: () => ({ cmd: process.execPath, args: ['-e', 'const out=(...e)=>console.log(JSON.stringify({events:e}));out({type:"text",text:String(process.argv.length)},{type:"done",ok:true})'], promptInArgs: true }),
  });
  const m = make({ fake: b });
  const e2 = collect(m.s);
  done = next(m.s, 'done');
  m.s.send(msg());
  await done;
  assert.equal(e2.find((e) => e.type === 'text').text, '1');

  const c = adapter('', { command: () => { throw new Error('bad command'); } });
  const k = make({ fake: c });
  done = next(k.s, 'done');
  k.s.send(msg());
  assert.deepEqual([(await done).ok, (await done).error], [false, 'bad command']);
  assert.equal(k.s.busy, false);
});

test('session: a command that cannot start', async () => {
  const a = adapter('', { command: () => ({ cmd: '/nonexistent/webai-agent', args: [] }) });
  const { s } = make({ fake: a });
  const done = next(s, 'done');
  s.send(msg());
  assert.match((await done).error, /Failed to start "\/nonexistent\/webai-agent"/);
  assert.equal(s.busy, false);
});

test('session: an error in the adapter ends the run instead of crashing', async () => {
  const a = adapter(`out({type:'text',text:'x'}); setInterval(()=>{},1000)`, {
    parse: () => { throw new Error('parse failed'); },
  });
  const { s } = make({ fake: a });
  const done = next(s, 'done');
  s.send(msg());
  const ev = await done;
  assert.equal(ev.error, 'Error processing output: parse failed');
  assert.equal(s.busy, false);

  // an error after reset(): nothing more to report
  const b = adapter(`out({type:'text',text:'x'}); setInterval(()=>{},1000)`);
  const m = make({ fake: b });
  const evs = collect(m.s);
  m.s.subscribe((ev) => {
    if (ev.type === 'text') {
      m.s.reset();
      throw new Error('late');
    }
  });
  const reset = next(m.s, 'reset');
  m.s.send(msg());
  await reset;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(evs.some((e) => e.type === 'done' && e.ok === false), false);
});
