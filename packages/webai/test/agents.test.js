import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeAgent } from '../src/agents/claude.js';
import { codexAgent } from '../src/agents/codex.js';
import { customAgent } from '../src/agents/custom.js';
import { geminiAgent } from '../src/agents/gemini.js';
import { opencodeAgent } from '../src/agents/opencode.js';
import { piAgent } from '../src/agents/pi.js';
import { linkSkills, writeCodexAgents } from '../src/agents/pack.js';
import { AgentSession } from '../src/session.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));

test('claude: without an allowed shell it offers no Bash and loads the skill pack', () => {
  const { args } = claudeAgent().command({ sessionId: 'x', resume: false, systemPrompt: 's' });
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'Bash']);
  assert.ok(args.includes('--plugin-dir'));
  const allowed = claudeAgent({ allowedTools: ['Bash(npm run check)'] }).command({ sessionId: 'x', resume: true, systemPrompt: 's' });
  assert.ok(!allowed.args.includes('--disallowedTools'));
});

test('codex: first message without an ID, later ones via exec resume', () => {
  const a = codexAgent();
  assert.deepEqual(a.command({ sessionId: null, resume: false, systemPrompt: 'x' }).args.slice(0, 2), ['exec', '--json']);
  const resumed = a.command({ sessionId: 'T1', resume: true, systemPrompt: 'x' }).args;
  // Flags belong to `exec`, the `resume <id>` subcommand comes after them.
  assert.deepEqual([resumed[0], ...resumed.slice(-3)], ['exec', 'resume', 'T1', '-']);
  const ctx = { root: '/p' };
  assert.deepEqual(a.parse({ type: 'thread.started', thread_id: 'T1' }, ctx), [{ type: 'session', id: 'T1' }]);
  assert.deepEqual(
    a.parse({ type: 'item.completed', item: { id: 'i', type: 'file_change', changes: [{ path: '/p/src/A.astro', kind: 'update' }] } }, ctx),
    [{ type: 'tool', id: 'i', name: 'Edit', summary: 'src/A.astro' }],
  );
  assert.equal(a.parse({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, ctx)[0].text, 'Done.');
  assert.equal(a.parse({ type: 'turn.failed', error: { message: 'x' } }, ctx)[0].ok, false);
});

test('gemini: deltas are joined into one text at the end', () => {
  const a = geminiAgent();
  const ctx = { root: '/p' };
  a.parse({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }, ctx);
  a.parse({ type: 'message', role: 'assistant', content: 'world', delta: true }, ctx);
  const out = a.parse({ type: 'result', status: 'success', stats: { duration_ms: 5 } }, ctx);
  assert.deepEqual(out.map((e) => e.type), ['text', 'done']);
  assert.equal(out[0].text, 'Hello world');
  assert.match(a.wrapPrompt('P', { systemPrompt: 'S', resume: false }), /^S\n\nP$/);
  assert.equal(a.wrapPrompt('P', { systemPrompt: 'S', resume: true }), 'P');
});

test('pack: skills get linked, an existing file stays', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agents/skills/czech-copy'), { recursive: true });
  const created = linkSkills(root);
  assert.ok(created.includes('.agents/skills/element-edit'));
  assert.ok(!created.includes('.agents/skills/czech-copy'));
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/web-styling/SKILL.md')));
  assert.ok(!path.isAbsolute(fs.readlinkSync(path.join(root, '.agents/skills/web-styling'))));
  // A broken link (moved package) is replaced on the next run.
  fs.rmSync(path.join(root, '.agents/skills/web-styling'));
  fs.symlinkSync('../../nowhere', path.join(root, '.agents/skills/web-styling'));
  assert.deepEqual(linkSkills(root), ['.agents/skills/web-styling']);
  const toml = fs.readFileSync(path.join(root, writeCodexAgents(root)[0]), 'utf8');
  assert.match(toml, /^name = "/m);
  assert.match(toml, /^developer_instructions = "/m);
});

test('other: the custom command gets the prompt and its output is the reply', async () => {
  const root = tmp();
  const session = new AgentSession({ root, agents: { custom: customAgent({ editable: true }) }, stateDir: '.webai' });
  await session.detect();
  session.setSettings({ custom: { command: "tr a-z A-Z && echo session={session} | cut -c1-8" } });
  const done = new Promise((resolve) => session.subscribe((ev) => ev.type === 'done' && resolve()));
  session.send({ message: 'hello' });
  await done;
  const text = session.events.find((e) => e.type === 'text').text;
  assert.match(text, /^HELLOsession=$/); // tr adds no \n, cut trims the ID
  assert.equal(session.events.at(-1).ok, true);
});

test('other: {prompt} is safely quoted', async () => {
  const root = tmp();
  const session = new AgentSession({ root, agents: { custom: customAgent({ editable: true }) }, stateDir: '.webai' });
  await session.detect();
  session.setSettings({ custom: { command: 'printf %s {prompt}' } });
  const done = new Promise((resolve) => session.subscribe((ev) => ev.type === 'done' && resolve()));
  session.send({ message: "it's $(whoami) `x`" });
  await done;
  assert.equal(session.events.find((e) => e.type === 'text').text, "it's $(whoami) `x`");
});

test('bridge: the "Other" command from the browser is ignored, the config applies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  assert.equal(customAgent().settings.command.readonly, true, 'not editable unless the config says so');
  const agents = { custom: customAgent({ command: 'echo host', editable: false }) };
  const session = new AgentSession({ root, agents, stateDir: '.webai' });
  session.setSettings({ custom: { command: 'touch /tmp/pwned' } });
  assert.deepEqual(session.settings.custom, {});
  const { args } = agents.custom.command({ sessionId: 'x', settings: { command: 'touch /tmp/pwned' }, prompt: 'p' });
  assert.equal(args[1], 'echo host');
});

test('opencode: in Docker, permissions without shell, session from events', () => {
  const a = opencodeAgent({ docker: { service: 'agents', workdir: '/workspace/examples/astro' } });
  const first = a.command({ sessionId: null, resume: false, settings: {}, prompt: '-x' });
  assert.equal(first.cmd, 'docker');
  assert.deepEqual(first.args.slice(0, 5), ['compose', 'run', '--rm', '-T', '--no-deps']);
  // Stop must remove the container too: the compose client doesn't stop it on exit.
  const name = first.args[first.args.indexOf('--name') + 1];
  assert.deepEqual(first.cleanup, { cmd: 'docker', args: ['rm', '-f', name] });
  const config = JSON.parse(first.args[first.args.indexOf('-e') + 1].replace(/^OPENCODE_CONFIG_CONTENT=/, ''));
  assert.equal(config.permission.bash, 'deny');
  assert.deepEqual(first.args.slice(-2), ['--', '-x']);
  assert.ok(!first.args.includes('--session'));
  assert.deepEqual(a.command({ sessionId: 'ses_1', resume: true, settings: {}, prompt: 'p' }).args.slice(-4, -2), ['--session', 'ses_1']);

  // Captured output of `opencode run --format json` 1.19.0 (shortened).
  const ctx = { root: '/host/example' };
  const events = [
    { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'invalid', callID: 'c0', state: { status: 'completed', input: { tool: 'bash', error: "Model tried to call unavailable tool 'bash'." } } } },
    { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { filePath: '/workspace/examples/astro/src/A.astro', oldString: 'a', newString: 'b' } } } },
    { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'Done.' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'stop', cost: 0 } },
  ].flatMap((e) => a.parse(e, ctx));
  assert.deepEqual(events.map((e) => e.type), ['session', 'tool-error', 'tool', 'text']);
  assert.equal(events[2].summary, 'src/A.astro');
  assert.deepEqual(a.onExit({ code: 0, signal: null }, ctx), [{ type: 'done', ok: true, error: undefined, costUsd: 0 }]);
  assert.equal(a.onExit({ code: 0, signal: null }, { ...ctx, error: 'Unexpected server error.' })[0].ok, false);
});

test('pi: --session-id for first and later messages, skills at the container path', () => {
  // The real example root: skills live next to it in the repo, under /workspace in the container.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/astro');
  const a = piAgent({ docker: { service: 'agents', workdir: '/workspace/examples/astro' } });
  const { args } = a.command({ sessionId: 'u1', resume: true, systemPrompt: 'S', settings: { model: 'openrouter/x:free' }, prompt: 'p', root });
  assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2), ['--session-id', 'u1']);
  assert.equal(args[args.indexOf('--tools') + 1], 'read,edit,write,grep,find,ls');
  assert.equal(args[args.indexOf('--skill') + 1], '/workspace/packages/webai/agents/skills');
  assert.deepEqual(args.slice(-2), ['--', 'p']);

  // Event shapes per docs/json.md (pi 1.2.0).
  const ctx = { root };
  const events = [
    { type: 'session', version: 3, id: 'u1', cwd: '/workspace/example' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hot' } },
    { type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: '/workspace/examples/astro/src/A.astro' } },
    { type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', isError: true, result: { content: [{ type: 'text', text: 'oldText not found' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { cost: { total: 0.002 } }, stopReason: 'stop' } },
    { type: 'agent_settled', aborted: false },
  ].flatMap((e) => a.parse(e, ctx));
  assert.deepEqual(events.map((e) => e.type), ['session', 'delta', 'tool', 'tool-error', 'text', 'done']);
  assert.equal(events[2].summary, 'src/A.astro');
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, error: undefined, costUsd: 0.002 });
});

test("docker: compose messages don't end up in the agent error", () => {
  const a = piAgent({ docker: { service: 'agents', workdir: '/w' } });
  const stderr = ' Container webai-agents-1 Creating \n Container webai-agents-1 Created \nWarning: No project session found with id \'x\'; creating a new session with that id.\nNo API key found for the selected model.\n';
  const [done] = a.onExit({ code: 1, signal: null }, { root: '/r', stderr });
  assert.match(done.error, /^No API key found for the selected model\.\nSet a provider key/);
});
