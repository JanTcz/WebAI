import path from 'node:path';
import { linkSkills, tomlString, writeCodexAgents } from './pack.js';

/**
 * Adapter for the OpenAI Codex CLI (`codex exec --json`).
 *
 * Codex doesn't let us set the conversation ID up front: it assigns one in the first
 * `thread.started` event and later messages resume via `codex exec resume <id>`.
 * Codex reports no costs, only tokens.
 *
 * Written from the docs and the codex-rs sources (exec_events.rs), not yet
 * tested for real.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin]
 * @param {string} [opts.model]
 * @param {string[]} [opts.models] models offered in the panel
 * @param {string} [opts.sandbox] default `workspace-write`
 * @param {string[]} [opts.extraArgs]
 */
export function codexAgent(opts = {}) {
  const bin = opts.bin ?? 'codex';
  return {
    name: 'codex',
    label: 'Codex',
    bin,
    presetSessionId: false,

    settings: {
      model: [
        { value: '', label: opts.model ? `Default (${opts.model})` : 'Default from ~/.codex/config.toml' },
        ...(opts.models ?? []).map((m) => ({ value: m, label: m })),
      ],
      effort: [{ value: '', label: 'Default' }, ...['low', 'medium', 'high'].map((v) => ({ value: v, label: v }))],
    },

    prepare({ root }) {
      return [...linkSkills(root), ...writeCodexAgents(root)];
    },

    command({ sessionId, resume, systemPrompt, settings = {} }) {
      const flags = [
        '--json',
        '--skip-git-repo-check',
        '--sandbox', opts.sandbox ?? 'workspace-write',
        '-c', 'approval_policy="never"',
        '-c', `developer_instructions=${tomlString(systemPrompt)}`,
      ];
      const model = settings.model || opts.model;
      if (model) flags.push('--model', model);
      if (settings.effort) flags.push('-c', `model_reasoning_effort="${settings.effort}"`);
      flags.push(...(opts.extraArgs ?? []));
      // `-` = prompt from stdin. Flags belong to `exec`, hence before the `resume` subcommand.
      const args = resume ? ['exec', ...flags, 'resume', sessionId, '-'] : ['exec', ...flags, '-'];
      return { cmd: bin, args, stdin: true };
    },

    parse(msg, ctx) {
      switch (msg.type) {
        case 'thread.started':
          return [{ type: 'session', id: msg.thread_id }];
        case 'item.started':
          if (msg.item?.type === 'command_execution') {
            return [{ type: 'tool', id: msg.item.id, name: 'Bash', summary: String(msg.item.command ?? '').slice(0, 160) }];
          }
          return [];
        case 'item.completed':
          return item(msg.item, ctx);
        case 'turn.completed':
          return [{ type: 'done', ok: true, tokens: msg.usage }];
        case 'turn.failed':
          return [{ type: 'done', ok: false, error: msg.error?.message ?? 'Codex failed.' }];
        case 'error':
          return [{ type: 'tool-error', text: msg.message }];
        default:
          return [];
      }
    },

    isMissingSession(stderr) {
      return /no (session|thread|rollout).*found|not find (session|thread|rollout)/i.test(stderr);
    },
  };
}

function item(it, ctx) {
  if (!it) return [];
  switch (it.type) {
    case 'agent_message':
      return it.text?.trim() ? [{ type: 'text', text: it.text }] : [];
    case 'file_change':
      return (it.changes ?? []).map((c) => ({
        type: 'tool',
        id: it.id,
        name: c.kind === 'add' ? 'Write' : 'Edit',
        summary: path.isAbsolute(c.path) ? path.relative(ctx.root, c.path) : c.path,
      }));
    case 'command_execution':
      return it.status === 'failed' || it.status === 'declined'
        ? [{ type: 'tool-error', id: it.id, text: `${it.command}: ${it.status === 'declined' ? 'declined' : `exit code ${it.exit_code}`}` }]
        : [];
    case 'mcp_tool_call':
      return [{ type: 'tool', id: it.id, name: `${it.server}.${it.tool}`, summary: '' }];
    case 'web_search':
      return [{ type: 'tool', id: it.id, name: 'WebSearch', summary: it.query ?? '' }];
    case 'error':
      return [{ type: 'tool-error', id: it.id, text: it.message }];
    default:
      return [];
  }
}
