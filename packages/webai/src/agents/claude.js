import path from 'node:path';
import { PACK_DIR } from './pack.js';

/**
 * Adapter for Claude Code in non-interactive mode (`claude -p`).
 *
 * One conversation = one session ID. The first message creates it via
 * `--session-id`, later ones resume it via `--resume`, so the agent keeps
 * context and the prompt cache is reused.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin] executable, default `claude`
 * @param {string} [opts.model]
 * @param {string} [opts.permissionMode] default `acceptEdits` – may edit files; anything else asks in the panel
 * @param {string[]} [opts.allowedTools] e.g. `['Bash(npm run check)']`, allowed without asking
 * @param {boolean} [opts.interactive] ask in the panel before a tool that isn't allowed (Bash, MCP, …), default `true`;
 *   `false` denies such calls and doesn't offer Bash unless `allowedTools` has it
 * @param {boolean} [opts.projectSettings] load `.claude/` and `.mcp.json` from the project, default `true`
 * @param {string[]} [opts.extraArgs]
 */
export function claudeAgent(opts = {}) {
  const bin = opts.bin ?? 'claude';
  return {
    name: 'claude',
    label: 'Claude Code',
    bin,
    // We pick the conversation ID ourselves via --session-id.
    presetSessionId: true,

    /** Options switchable from the panel. Empty value = default from the config. */
    settings: {
      model: [
        { value: '', label: opts.model ? `Default (${opts.model})` : 'Default' },
        { value: 'haiku', label: 'Haiku – cheapest, small edits' },
        { value: 'sonnet', label: 'Sonnet – balanced' },
        { value: 'opus', label: 'Opus – most capable' },
      ],
      effort: [
        { value: '', label: 'Default' },
        ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v })),
      ],
    },

    command({ sessionId, resume, systemPrompt, settings = {} }) {
      const interactive = opts.interactive !== false;
      const args = [
        '-p',
        // Interactive: the prompt is a stream-json message and stdin stays open for permission answers.
        ...(interactive ? ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'] : []),
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', opts.permissionMode ?? 'acceptEdits',
        resume ? '--resume' : '--session-id', sessionId,
        // The system prompt isn't stored in the session, it's sent on every call.
        '--append-system-prompt', systemPrompt,
      ];
      const model = settings.model || opts.model;
      if (model) args.push('--model', model);
      if (settings.effort) args.push('--effort', settings.effort);
      // Rules as separate arguments: a rule itself may contain a comma.
      if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
      // Without a way to ask, don't offer Bash unless it's allowed: every attempt would be
      // denied and the agent would waste time looking for another way.
      if (!interactive && !opts.allowedTools?.some((t) => t.startsWith('Bash'))) args.push('--disallowedTools', 'Bash');
      // Skills and subagents from @jantcz/webai/agents (named webai:<skill>).
      if (opts.skills !== false) args.push('--plugin-dir', PACK_DIR);
      // No hooks, permissions or MCP servers from the project (bridge: the container writes to the project too).
      if (opts.projectSettings === false) args.push('--setting-sources', 'user', '--strict-mcp-config');
      args.push(...(opts.extraArgs ?? []));
      // The prompt goes to stdin, not argv: it's often long and contains HTML.
      return {
        cmd: bin,
        args,
        stdin: true,
        ...(interactive && {
          // stdin stays open until the turn ends (see session.run): permission answers go through it.
          interactive: true,
          input: (text) => line({ type: 'user', message: { role: 'user', content: text } }),
        }),
      };
    },

    /** The answer to a `permission` event, as a line for the agent's stdin. */
    answer({ requestId, input }, allow) {
      const response = allow
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user denied this in the WebAI panel.' };
      return line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    },

    /** Converts one stream-json line into UI events. */
    parse(msg, ctx) {
      switch (msg.type) {
        case 'control_request': {
          const r = msg.request;
          if (r?.subtype !== 'can_use_tool') return [];
          const input = r.input ?? {};
          return [{ type: 'permission', id: msg.request_id, name: r.tool_name, summary: summarizeTool({ name: r.tool_name, input }, ctx.root), input }];
        }
        // The agent gave up on the call (the turn was interrupted): the question is moot.
        case 'control_cancel_request':
          return [{ type: 'permission-answer', id: msg.request_id, allow: false, cancelled: true }];
        case 'system':
          return msg.subtype === 'init'
            ? [{ type: 'session', id: msg.session_id }, { type: 'status', text: `${msg.model ?? 'claude'} ready` }]
            : [];
        case 'stream_event': {
          const ev = msg.event;
          if (msg.parent_tool_use_id) return [];
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            return [{ type: 'delta', text: ev.delta.text }];
          }
          return [];
        }
        case 'assistant': {
          if (msg.parent_tool_use_id) return [];
          const out = [];
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text.trim()) out.push({ type: 'text', text: block.text });
            if (block.type === 'tool_use') out.push({ type: 'tool', id: block.id, name: block.name, summary: summarizeTool(block, ctx.root) });
          }
          return out;
        }
        case 'user': {
          const out = [];
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_result' && block.is_error) {
              out.push({ type: 'tool-error', id: block.tool_use_id, text: resultText(block.content).slice(0, 400) });
            }
          }
          return out;
        }
        case 'result': {
          const out = [];
          for (const d of msg.permission_denials ?? []) {
            out.push({ type: 'denied', name: d.tool_name, summary: summarizeTool({ name: d.tool_name, input: d.tool_input }, ctx.root) });
          }
          out.push({
            type: 'done',
            ok: !msg.is_error,
            error: msg.is_error ? String(msg.result ?? msg.subtype) : undefined,
            // total_cost_usd is the total for the whole session including previous --resume calls.
            totalCostUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            turns: msg.num_turns,
          });
          return out;
        }
        default:
          return [];
      }
    },

    /** Stderr that tells us the session doesn't exist on disk. */
    isMissingSession(stderr) {
      return /no conversation found|session .* not found/i.test(stderr);
    },
  };
}

const line = (msg) => JSON.stringify(msg) + '\n';

function rel(file, root) {
  if (!file) return '';
  return path.isAbsolute(file) ? path.relative(root, file) || file : file;
}

function summarizeTool({ name, input = {} }, root) {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return rel(input.file_path ?? input.notebook_path, root);
    case 'Bash':
      return String(input.command ?? '').slice(0, 160);
    case 'Grep':
    case 'Glob':
      // A search in the project root doesn't show the path.
      return `${input.pattern ?? ''}${input.path && path.resolve(root, input.path) !== root ? ` in ${rel(input.path, root)}` : ''}`;
    case 'WebFetch':
      return input.url ?? '';
    default:
      return Object.values(input).filter((v) => typeof v === 'string').join(' ').slice(0, 120);
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('\n');
  return '';
}
