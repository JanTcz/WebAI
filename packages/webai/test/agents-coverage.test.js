import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeAgent } from '../src/agents/claude.js';
import { codexAgent } from '../src/agents/codex.js';
import { customAgent } from '../src/agents/custom.js';
import { geminiAgent } from '../src/agents/gemini.js';
import { opencodeAgent } from '../src/agents/opencode.js';
import { piAgent } from '../src/agents/pi.js';
import { webaiAgent } from '../src/agents/webai.js';
import { resolveAgents } from '../src/agents/index.js';
import { cleanStderr, relPath } from '../src/agents/docker.js';
import { linkMarkdownAgents, writeCodexAgents } from '../src/agents/pack.js';

const ctx = { root: '/p' };
const flag = (args, f) => args[args.indexOf(f) + 1];

test('claude: command options', () => {
  const a = claudeAgent({ model: 'opus', allowedTools: ['Bash(ls)', 'Read'], skills: false, projectSettings: false, extraArgs: ['--x'], permissionMode: 'plan', bin: 'cl' });
  assert.equal(a.settings.model[0].label, 'Default (opus)');
  const c = a.command({ sessionId: 's', resume: false, systemPrompt: 'S', settings: { effort: 'high' } });
  assert.equal(c.cmd, 'cl');
  assert.equal(flag(c.args, '--session-id'), 's');
  assert.equal(flag(c.args, '--permission-mode'), 'plan');
  assert.equal(flag(c.args, '--model'), 'opus');
  assert.equal(flag(c.args, '--effort'), 'high');
  assert.deepEqual(c.args.slice(c.args.indexOf('--allowedTools') + 1, c.args.indexOf('--allowedTools') + 3), ['Bash(ls)', 'Read']);
  assert.ok(!c.args.includes('--plugin-dir'));
  assert.deepEqual(c.args.slice(-4), ['--setting-sources', 'user', '--strict-mcp-config', '--x'].slice(0, 4));
  const d = claudeAgent().command({ sessionId: 's', resume: true, systemPrompt: 'S', settings: { model: 'haiku' } });
  assert.equal(flag(d.args, '--resume'), 's');
  assert.equal(flag(d.args, '--model'), 'haiku');
  assert.equal(claudeAgent().settings.model[0].label, 'Default');
});

test('claude: parse', () => {
  const a = claudeAgent();
  const root = '/p';
  assert.deepEqual(a.parse({ type: 'system', subtype: 'init', session_id: 'i', model: 'm' }, ctx), [{ type: 'session', id: 'i' }, { type: 'status', text: 'm ready' }]);
  assert.equal(a.parse({ type: 'system', subtype: 'init', session_id: 'i' }, ctx)[1].text, 'claude ready');
  assert.deepEqual(a.parse({ type: 'system', subtype: 'other' }, ctx), []);
  const delta = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
  assert.deepEqual(a.parse({ type: 'stream_event', event: delta }, ctx), [{ type: 'delta', text: 'x' }]);
  assert.deepEqual(a.parse({ type: 'stream_event', event: delta, parent_tool_use_id: 't' }, ctx), []);
  assert.deepEqual(a.parse({ type: 'stream_event', event: { type: 'ping' } }, ctx), []);
  assert.deepEqual(a.parse({ type: 'stream_event' }, ctx), []);
  assert.deepEqual(a.parse({ type: 'assistant', parent_tool_use_id: 't', message: {} }, ctx), []);
  assert.deepEqual(a.parse({ type: 'assistant' }, ctx), []);
  const tools = [
    { type: 'text', text: ' ' },
    { type: 'text', text: 'hi' },
    { type: 'thinking' },
    { type: 'tool_use', id: '1', name: 'Edit', input: { file_path: '/p/src/a.js' } },
    { type: 'tool_use', id: '2', name: 'Read', input: { file_path: 'rel.js' } },
    { type: 'tool_use', id: '3', name: 'Read', input: { file_path: '/p' } },
    { type: 'tool_use', id: '3b', name: 'Read', input: {} },
    { type: 'tool_use', id: '4', name: 'NotebookEdit', input: { notebook_path: '/p/n.ipynb' } },
    { type: 'tool_use', id: '5', name: 'Bash', input: { command: 'x'.repeat(200) } },
    { type: 'tool_use', id: '5b', name: 'Bash', input: {} },
    { type: 'tool_use', id: '6', name: 'Grep', input: { pattern: 'foo' } },
    { type: 'tool_use', id: '7', name: 'Glob', input: { pattern: '*.js', path: 'src' } },
    { type: 'tool_use', id: '8', name: 'Glob', input: { pattern: '*.js', path: '/p' } },
    { type: 'tool_use', id: '8b', name: 'Glob', input: {} },
    { type: 'tool_use', id: '9', name: 'WebFetch', input: { url: 'http://u' } },
    { type: 'tool_use', id: '9b', name: 'WebFetch' },
    { type: 'tool_use', id: '10', name: 'Other', input: { a: 'x', b: 1, c: 'y' } },
  ];
  const out = a.parse({ type: 'assistant', message: { content: tools } }, { root });
  assert.deepEqual(out.map((e) => e.summary ?? e.text), [
    'hi', 'src/a.js', 'rel.js', '/p', '', 'n.ipynb', 'x'.repeat(160), '', 'foo', '*.js in src', '*.js', '', 'http://u', '', 'x y',
  ]);
  assert.deepEqual(a.parse({ type: 'user' }, ctx), []);
  const user = { type: 'user', message: { content: [
    { type: 'tool_result', is_error: false, content: 'ok' },
    { type: 'text' },
    { type: 'tool_result', is_error: true, tool_use_id: 'a', content: 'e'.repeat(500) },
    { type: 'tool_result', is_error: true, tool_use_id: 'b', content: [{ text: 'l1' }, {}] },
    { type: 'tool_result', is_error: true, tool_use_id: 'c', content: null },
  ] } };
  const errs = a.parse(user, ctx);
  assert.deepEqual(errs.map((e) => e.text), ['e'.repeat(400), 'l1\n', '']);
  const res = a.parse({ type: 'result', is_error: false, total_cost_usd: 1, duration_ms: 2, num_turns: 3, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'ls' } }] }, ctx);
  assert.deepEqual(res[0], { type: 'denied', name: 'Bash', summary: 'ls' });
  assert.deepEqual(res[1], { type: 'done', ok: true, error: undefined, totalCostUsd: 1, durationMs: 2, turns: 3 });
  assert.equal(a.parse({ type: 'result', is_error: true, result: 'bad' }, ctx)[0].error, 'bad');
  assert.equal(a.parse({ type: 'result', is_error: true, subtype: 'sub' }, ctx)[0].error, 'sub');
  assert.deepEqual(a.parse({ type: 'weird' }, ctx), []);
  assert.ok(a.isMissingSession('Error: No conversation found with id'));
  assert.ok(a.isMissingSession('session abc not found'));
  assert.ok(!a.isMissingSession('boom'));
});

test('codex: command options and parse', () => {
  const a = codexAgent({ model: 'm1', models: ['m2'], sandbox: 'read-only', extraArgs: ['--e'], bin: 'cx' });
  assert.equal(a.settings.model[0].label, 'Default (m1)');
  assert.equal(a.settings.model[1].value, 'm2');
  assert.match(codexAgent().settings.model[0].label, /config\.toml/);
  const c = a.command({ sessionId: null, resume: false, systemPrompt: 'S"', settings: { effort: 'low' } });
  assert.equal(c.cmd, 'cx');
  assert.equal(flag(c.args, '--sandbox'), 'read-only');
  assert.equal(flag(c.args, '--model'), 'm1');
  assert.ok(c.args.includes('model_reasoning_effort="low"'));
  assert.ok(c.args.includes('developer_instructions="S\\""'));
  assert.deepEqual(c.args.slice(-2), ['--e', '-']);
  assert.equal(flag(codexAgent().command({ sessionId: null, resume: false, systemPrompt: 'S', settings: { model: 'x' } }).args, '--model'), 'x');
  assert.equal(flag(codexAgent().command({ sessionId: null, resume: false, systemPrompt: 'S' }).args, '--sandbox'), 'workspace-write');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  try {
    const created = a.prepare({ root });
    assert.ok(created.some((p) => p.startsWith('.agents/skills/')));
    assert.ok(created.some((p) => p.startsWith('.codex/agents/')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(a.parse({ type: 'item.started', item: { type: 'command_execution', id: 'c', command: 'ls' } }, ctx), [{ type: 'tool', id: 'c', name: 'Bash', summary: 'ls' }]);
  assert.equal(a.parse({ type: 'item.started', item: { type: 'command_execution', id: 'c' } }, ctx)[0].summary, '');
  assert.deepEqual(a.parse({ type: 'item.started', item: { type: 'x' } }, ctx), []);
  assert.deepEqual(a.parse({ type: 'item.started' }, ctx), []);
  assert.deepEqual(a.parse({ type: 'turn.completed', usage: { n: 1 } }, ctx), [{ type: 'done', ok: true, tokens: { n: 1 } }]);
  assert.equal(a.parse({ type: 'turn.failed' }, ctx)[0].error, 'Codex failed.');
  assert.deepEqual(a.parse({ type: 'error', message: 'm' }, ctx), [{ type: 'tool-error', text: 'm' }]);
  assert.deepEqual(a.parse({ type: 'zzz' }, ctx), []);
  const done = (it) => a.parse({ type: 'item.completed', item: it }, ctx);
  assert.deepEqual(done(undefined), []);
  assert.deepEqual(done({ type: 'agent_message', text: '  ' }), []);
  assert.deepEqual(done({ type: 'agent_message' }), []);
  assert.deepEqual(done({ type: 'file_change', id: 'f', changes: [{ kind: 'add', path: 'rel.js' }] }), [{ type: 'tool', id: 'f', name: 'Write', summary: 'rel.js' }]);
  assert.deepEqual(done({ type: 'file_change', id: 'f' }), []);
  assert.equal(done({ type: 'command_execution', id: 'c', command: 'ls', status: 'failed', exit_code: 2 })[0].text, 'ls: exit code 2');
  assert.equal(done({ type: 'command_execution', id: 'c', command: 'ls', status: 'declined' })[0].text, 'ls: declined');
  assert.deepEqual(done({ type: 'command_execution', status: 'completed' }), []);
  assert.deepEqual(done({ type: 'mcp_tool_call', id: 'm', server: 's', tool: 't' }), [{ type: 'tool', id: 'm', name: 's.t', summary: '' }]);
  assert.equal(done({ type: 'web_search', id: 'w', query: 'q' })[0].summary, 'q');
  assert.equal(done({ type: 'web_search', id: 'w' })[0].summary, '');
  assert.deepEqual(done({ type: 'error', id: 'e', message: 'bad' }), [{ type: 'tool-error', id: 'e', text: 'bad' }]);
  assert.deepEqual(done({ type: 'other' }), []);
  assert.ok(a.isMissingSession('no thread found'));
  assert.ok(a.isMissingSession('could not find session'));
  assert.ok(!a.isMissingSession('x'));
});

test('gemini: command, prepare and parse', () => {
  const a = geminiAgent({ model: 'g', approvalMode: 'yolo', extraArgs: ['--e'], bin: 'gm' });
  assert.equal(a.settings.model[0].label, 'Default (g)');
  assert.equal(geminiAgent().settings.model[0].label, 'Default');
  const c = a.command({ sessionId: 's', resume: true, settings: {}, prompt: '-p' });
  assert.deepEqual([c.cmd, c.promptInArgs, flag(c.args, '--approval-mode'), flag(c.args, '--resume'), flag(c.args, '--model')], ['gm', true, 'yolo', 's', 'g']);
  assert.deepEqual(c.args.slice(-2), ['--e', '--prompt=-p']);
  const d = geminiAgent().command({ sessionId: 's', resume: false, prompt: 'p' });
  assert.equal(flag(d.args, '--session-id'), 's');
  assert.equal(flag(d.args, '--approval-mode'), 'auto_edit');
  assert.ok(!d.args.includes('--model'));
  assert.equal(flag(geminiAgent().command({ sessionId: 's', resume: false, settings: { model: 'pro' }, prompt: 'p' }).args, '--model'), 'pro');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  try {
    const created = a.prepare({ root });
    assert.ok(created.some((p) => p.startsWith('.gemini/agents/')));
    assert.ok(created.some((p) => p.startsWith('.agents/skills/')));
    assert.deepEqual(linkMarkdownAgents(root, '.gemini/agents'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(a.parse({ type: 'init', session_id: 'i', model: 'm' }, ctx), [{ type: 'session', id: 'i' }, { type: 'status', text: 'm ready' }]);
  assert.equal(a.parse({ type: 'init', session_id: 'i' }, ctx)[1].text, 'gemini ready');
  assert.deepEqual(a.parse({ type: 'message', role: 'user', content: 'x' }, ctx), []);
  const c1 = { root: '/p' };
  assert.deepEqual(a.parse({ type: 'message', role: 'assistant', content: 'a', delta: true }, c1), [{ type: 'delta', text: 'a' }]);
  assert.equal(c1.text, 'a');
  assert.deepEqual(a.parse({ type: 'message', role: 'assistant', content: 'full' }, c1), [{ type: 'text', text: 'full' }]);
  assert.equal(c1.text, '');
  assert.deepEqual(a.parse({ type: 'message', role: 'assistant', content: ' ' }, c1), []);
  // tool_use flushes pending deltas first
  const c2 = { root: '/p' };
  a.parse({ type: 'message', role: 'assistant', content: 'pre', delta: true }, c2);
  const tu = a.parse({ type: 'tool_use', tool_id: 't', tool_name: 'read', parameters: { file_path: '/p/a.js' } }, c2);
  assert.deepEqual(tu, [{ type: 'text', text: 'pre' }, { type: 'tool', id: 't', name: 'read', summary: 'a.js' }]);
  const sum = (parameters) => a.parse({ type: 'tool_use', tool_id: 't', tool_name: 'x', parameters }, { root: '/p' })[0].summary;
  assert.equal(sum({ absolute_path: 'rel.js' }), 'rel.js');
  assert.equal(sum({ path: '/p/q' }), 'q');
  assert.equal(sum({ command: 'c'.repeat(200) }), 'c'.repeat(160));
  assert.equal(sum({ pattern: 'pp' }), 'pp');
  assert.equal(sum({ query: 'qq' }), 'qq');
  assert.equal(sum({}), '');
  assert.equal(sum(undefined), '');
  assert.deepEqual(a.parse({ type: 'tool_result', status: 'error', tool_id: 't', error: { message: 'm' } }, ctx), [{ type: 'tool-error', id: 't', text: 'm' }]);
  assert.equal(a.parse({ type: 'tool_result', status: 'error', tool_id: 't' }, ctx)[0].text, 'error');
  assert.deepEqual(a.parse({ type: 'tool_result', status: 'success' }, ctx), []);
  assert.deepEqual(a.parse({ type: 'error', severity: 'error', message: 'm' }, ctx), [{ type: 'tool-error', text: 'm' }]);
  assert.deepEqual(a.parse({ type: 'error', severity: 'warning', message: 'm' }, ctx), []);
  const r = a.parse({ type: 'result', status: 'error', error: { message: 'bad' }, stats: { duration_ms: 3 } }, { root: '/p' });
  assert.deepEqual(r, [{ type: 'done', ok: false, error: 'bad', durationMs: 3, tokens: { duration_ms: 3 } }]);
  assert.equal(a.parse({ type: 'result', status: 'success' }, { root: '/p' })[0].ok, true);
  assert.deepEqual(a.parse({ type: 'zzz' }, ctx), []);
  assert.ok(a.isMissingSession('Session x not found'));
  assert.ok(a.isMissingSession('no session'));
  assert.ok(!a.isMissingSession('x'));
});

test('opencode: local run, defaults and parse branches', () => {
  const a = opencodeAgent({ bin: 'oc', model: 'm', models: [{ value: 'v', label: 'V' }], extraArgs: ['--e'], permission: { bash: 'allow' } });
  assert.equal(a.bin, 'oc');
  assert.equal(a.label, 'OpenCode');
  assert.deepEqual(a.versionArgs, ['--version']);
  assert.deepEqual(a.settings.model, [{ value: '', label: 'Default (m)' }, { value: 'v', label: 'V' }]);
  const c = a.command({ sessionId: 's', resume: true, settings: { model: 'x' }, prompt: 'p' });
  assert.equal(c.cmd, 'oc');
  assert.equal(c.promptInArgs, true);
  assert.deepEqual(c.args, ['run', '--format', 'json', '--model', 'x', '--session', 's', '--e', '--', 'p']);
  assert.equal(JSON.parse(c.env.OPENCODE_CONFIG_CONTENT).permission.bash, 'allow');
  const d = opencodeAgent().command({ sessionId: 's', resume: true, prompt: 'p' });
  assert.equal(d.args[4], 'opencode/deepseek-v4.1-flash-free');
  assert.ok(opencodeAgent().settings.model.length > 2);
  assert.ok(!opencodeAgent().command({ sessionId: null, resume: true, prompt: 'p' }).args.includes('--session'));
  assert.equal(opencodeAgent({ docker: { service: 's', workdir: '/w' } }).label, 'OpenCode (Docker)');
  assert.equal(opencodeAgent({ docker: { service: 's', workdir: '/w' } }).bin, 'docker');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  try {
    assert.ok(a.prepare({ root }).length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(a.wrapPrompt('P', { systemPrompt: 'S', resume: false }), 'S\n\nP');
  assert.equal(a.wrapPrompt('P', { systemPrompt: 'S', resume: true }), 'P');

  const x = { root: '/p' };
  assert.deepEqual(a.parse({ type: 'text', sessionID: 's1', part: { text: 'hi' } }, x), [{ type: 'session', id: 's1' }, { type: 'text', text: 'hi' }]);
  assert.deepEqual(a.parse({ type: 'text', sessionID: 's1', part: { text: ' ' } }, x), []);
  assert.deepEqual(a.parse({ type: 'text' }, x), []);
  const tool = (part) => a.parse({ type: 'tool_use', part }, x);
  assert.equal(tool({ tool: 'invalid', callID: 'c' })[0].text, 'Invalid tool call.');
  assert.deepEqual(tool({ tool: 'bash', callID: 'c', state: { input: { command: 'ls' } } }), [{ type: 'tool', id: 'c', name: 'Bash', summary: 'ls' }]);
  assert.equal(tool({ tool: 'mytool', callID: 'c' })[0].name, 'mytool');
  assert.equal(tool({ tool: 'glob', callID: 'c', state: { input: { pattern: '*.js' } } })[0].summary, '*.js');
  assert.equal(tool({ tool: 'read', callID: 'c', state: { input: { path: '/p/a.js' } } })[0].summary, 'a.js');
  assert.equal(tool({ tool: 'x', callID: 'c', state: { input: {} } })[0].summary, '');
  const withErr = tool({ tool: 'edit', callID: 'c', state: { status: 'error', error: 'e'.repeat(500), input: {} } });
  assert.equal(withErr[1].text.length, 400);
  assert.equal(tool({ tool: 'edit', callID: 'c', state: { status: 'error' } })[1].text, '');
  // step_finish accumulates cost
  const y = {};
  a.parse({ type: 'step_finish', part: { cost: 1 } }, y);
  a.parse({ type: 'step_finish', part: {} }, y);
  a.parse({ type: 'step_finish' }, y);
  assert.equal(y.costUsd, 1);
  const errCtx = (error) => { const e = {}; a.parse({ type: 'error', error }, e); return e.error; };
  assert.equal(errCtx({ data: { message: 'dm' }, name: 'n' }), 'dm');
  assert.equal(errCtx({ name: 'n' }), 'n');
  assert.equal(errCtx(undefined), 'OpenCode error.');
  assert.deepEqual(a.parse({ type: 'unknown' }, {}), []);

  assert.deepEqual(a.onExit({ code: null, signal: 'SIGTERM' }, {}), [{ type: 'done', ok: false, error: 'Stopped.' }]);
  assert.deepEqual(a.onExit({ code: 1 }, { stderr: 'x'.repeat(700) })[0].error, 'x'.repeat(600));
  assert.equal(a.onExit({ code: 3 }, {})[0].error, 'OpenCode exited with code 3.');
  assert.equal(a.onExit({ code: 0 }, { costUsd: 2 })[0].costUsd, 2);
});

test('pi: local run, defaults and parse branches', () => {
  const a = piAgent({ bin: 'p', model: 'm', models: [{ value: 'v', label: 'V' }], tools: ['read'], skills: false, extraArgs: ['--e'] });
  assert.equal(a.label, 'Pi');
  assert.equal(a.bin, 'p');
  assert.deepEqual(a.versionArgs, ['--version']);
  assert.equal(a.settings.model[0].label, 'Default (m)');
  assert.match(piAgent().settings.model[0].label, /Pi settings/);
  assert.ok(piAgent().settings.model.length > 2);
  const c = a.command({ sessionId: 's', systemPrompt: 'S', settings: { thinking: 'high' }, prompt: 'p', root: '/p' });
  assert.equal(flag(c.args, '--tools'), 'read');
  assert.equal(flag(c.args, '--model'), 'm');
  assert.equal(flag(c.args, '--thinking'), 'high');
  assert.ok(!c.args.includes('--skill'));
  assert.deepEqual(c.args.slice(-3), ['--e', '--', 'p']);
  const d = piAgent().command({ sessionId: 's', systemPrompt: 'S', prompt: 'p', root: '/p' });
  assert.equal(d.cmd, 'pi');
  assert.equal(flag(d.args, '--tools'), 'read,edit,write,grep,find,ls');
  assert.ok(path.isAbsolute(flag(d.args, '--skill')));
  assert.ok(!d.args.includes('--model'));

  const x = { root: '/p' };
  assert.deepEqual(a.parse({ type: 'message_update', assistantMessageEvent: { type: 'other' } }, x), []);
  assert.deepEqual(a.parse({ type: 'message_update' }, x), []);
  assert.deepEqual(a.parse({ type: 'message_end', message: { role: 'user' } }, x), []);
  assert.deepEqual(a.parse({ type: 'message_end' }, x), []);
  const err = { root: '/p' };
  assert.deepEqual(a.parse({ type: 'message_end', message: { role: 'assistant', content: 'str', stopReason: 'error' } }, err), []);
  assert.equal(err.error, 'Model error.');
  assert.equal(err.costUsd, 0);
  a.parse({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'EM' } }, err);
  assert.equal(err.error, 'EM');
  const multi = a.parse({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b ' }] } }, x);
  assert.deepEqual(multi, [{ type: 'text', text: 'ab' }]);
  const start = (args) => a.parse({ type: 'tool_execution_start', toolCallId: 't', toolName: 'zzz', args }, x)[0];
  assert.equal(start({ file_path: '/p/q' }).summary, 'q');
  assert.equal(start({ pattern: 'pp' }).summary, 'pp');
  assert.equal(start({ command: 'c' }).summary, 'c');
  assert.equal(start(undefined).summary, '');
  assert.equal(start({}).name, 'zzz');
  const end = (result) => a.parse({ type: 'tool_execution_end', toolCallId: 't', isError: true, result }, x)[0].text;
  assert.equal(end({ content: 'str' }), 'str');
  assert.equal(end({ content: [{ text: 'a' }, {}] }), 'a\n');
  assert.equal(end({}), '');
  assert.equal(end(undefined), '');
  assert.deepEqual(a.parse({ type: 'tool_execution_end', isError: false }, x), []);
  assert.deepEqual(a.parse({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'e' }, x), [{ type: 'status', text: 'Retrying (1/3): e' }]);
  assert.deepEqual(a.parse({ type: 'agent_settled', aborted: true }, {}), [{ type: 'done', ok: false, error: 'Stopped.', costUsd: undefined }]);
  assert.equal(a.parse({ type: 'agent_settled' }, { error: 'E' })[0].ok, false);
  assert.deepEqual(a.parse({ type: 'zzz' }, x), []);

  assert.deepEqual(a.onExit({ signal: 'SIGTERM' }, {}), [{ type: 'done', ok: false, error: 'Stopped.' }]);
  assert.equal(a.onExit({ code: 2 }, {})[0].error, 'Pi exited with code 2.');
  assert.equal(a.onExit({ code: 2 }, { stderr: 'bad' })[0].error, 'bad');
});

test('docker helpers: path mapping, cleanStderr and relPath', () => {
  const a = piAgent({ docker: { service: 'agents', workdir: '/workspace/examples/astro' } });
  assert.equal(a.label, 'Pi (Docker)');
  assert.equal(cleanStderr(), '');
  assert.equal(cleanStderr(' Volume v Created\nreal'), 'real');
  assert.equal(relPath(5, '/b'), '');
  assert.equal(relPath('/b', '/b'), '/b');
  assert.equal(relPath('/b/x', '/b'), 'x');
  assert.equal(relPath('x/y', '/b'), 'x/y');
});

test('custom: command validation and exit handling', () => {
  assert.throws(() => customAgent().command({ sessionId: 's', prompt: 'p' }), /not set in the config/);
  assert.throws(() => customAgent({ editable: true }).command({ sessionId: 's', settings: {}, prompt: 'p' }), /Enter a command/);
  assert.match(customAgent({ editable: true }).settings.command.hint, /Runs via/);
  const stdin = customAgent({ command: 'cat' }).command({ sessionId: 's', prompt: 'p' });
  assert.deepEqual(stdin, { cmd: '/bin/sh', args: ['-c', 'cat'], stdin: true, promptInArgs: false });
  assert.equal(customAgent({ editable: true, command: 'a' }).command({ sessionId: 's', settings: { command: 'b {session}' }, prompt: 'p' }).args[1], "b 's'");
  const a = customAgent();
  const x = {};
  assert.deepEqual(a.parse('hi', x), [{ type: 'delta', text: 'hi\n', plain: true }]);
  a.parse('there', x);
  assert.equal(x.text, 'hi\nthere\n');
  assert.deepEqual(a.onExit({ code: 0 }, x), [{ type: 'text', text: 'hi\nthere', plain: true }, { type: 'done', ok: true, error: undefined }]);
  assert.deepEqual(a.onExit({ code: 0 }, {}), [{ type: 'done', ok: true, error: undefined }]);
  assert.equal(a.onExit({ code: 2 }, { stderr: ' oops \n' })[0].error, 'Command exited with code 2.\noops');
  assert.equal(a.onExit({ code: 2 }, {})[0].error, 'Command exited with code 2.');
  assert.deepEqual(a.onExit({ signal: 'SIGTERM' }, {}), [{ type: 'done', ok: false, error: 'Stopped.' }]);
});

test('webai: provider selection and exit', () => {
  const a = webaiAgent({ provider: 'openrouter', model: 'M' });
  const c = a.command({ sessionId: 's', resume: false, systemPrompt: 'S' });
  assert.equal(flag(c.args, '--base-url'), 'https://openrouter.ai/api/v1');
  assert.equal(flag(c.args, '--model'), 'M');
  assert.ok(!c.args.includes('--fallbacks'));
  const cust = webaiAgent({ baseUrl: 'http://o/v1' }).command({ sessionId: 's', resume: false, systemPrompt: 'S', settings: { provider: 'custom' } });
  assert.equal(flag(cust.args, '--base-url'), 'http://o/v1');
  assert.equal(flag(cust.args, '--model'), 'qwen2.5-coder:7b');
  assert.equal(flag(cust.args, '--fallbacks'), '');
  const bogus = webaiAgent().command({ sessionId: 's', resume: false, systemPrompt: 'S', settings: { provider: 'nope' } });
  assert.match(flag(bogus.args, '--base-url'), /kilo/);
  assert.deepEqual(a.parse(null), []);
  assert.deepEqual(a.parse({ type: 5 }), []);
  assert.deepEqual(a.onExit({ signal: 'SIGKILL' }, {}), [{ type: 'done', ok: false, error: 'Stopped.' }]);
  assert.equal(a.onExit({ code: 1 }, { stderr: ' boom ' })[0].error, 'boom');
  assert.equal(a.onExit({ code: 4 }, {})[0].error, 'The built-in agent exited with code 4.');
});

test('index: resolveAgents merges custom agents and fills labels', () => {
  const agents = resolveAgents({ agents: [{ name: 'mine' }, { name: 'named', label: 'N' }], custom: { command: 'echo' } });
  assert.deepEqual(Object.keys(agents).slice(0, 6), ['claude', 'codex', 'gemini', 'opencode', 'pi', 'webai']);
  assert.equal(Object.keys(agents).at(-1), 'custom');
  assert.equal(agents.mine.label, 'mine');
  assert.equal(agents.named.label, 'N');
  assert.equal(Object.keys(resolveAgents()).length, 7);
});

test('pack: agents without frontmatter or name fall back to the file name and whole body', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realRead = fs.readFileSync;
  const realList = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, ...rest) => (String(dir).endsWith('agents/agents') ? ['plain.md', 'nameless.md', 'skip.txt'] : realList(dir, ...rest)));
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).endsWith('plain.md')) return '  just a body  ';
    if (String(file).endsWith('nameless.md')) return '---\ndescription: D\n---\nB\n';
    return realRead(file, ...rest);
  });
  t.mock.method(fs, 'symlinkSync', () => {});
  const written = writeCodexAgents(root);
  assert.deepEqual(written.map((f) => path.basename(f)), ['plain.toml', 'nameless.toml']);
  const toml = (n) => fs.readFileSync(path.join(root, '.codex/agents', n), 'utf8');
  assert.match(toml('plain.toml'), /^name = "plain"$/m);
  assert.match(toml('plain.toml'), /^description = ""$/m);
  assert.match(toml('plain.toml'), /^developer_instructions = "just a body"$/m);
  assert.match(toml('nameless.toml'), /^name = "nameless"$/m);
  assert.match(toml('nameless.toml'), /^description = "D"$/m);
});

test('pack: existing codex agent files are kept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));
  try {
    assert.ok(writeCodexAgents(root).length > 0);
    assert.deepEqual(writeCodexAgents(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
