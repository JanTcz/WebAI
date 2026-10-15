import path from 'node:path';
import { linkMarkdownAgents, linkSkills } from './pack.js';

/**
 * Adapter for the Google Gemini CLI (`gemini -p … --output-format stream-json`).
 *
 * We pick the conversation ID ourselves (`--session-id` first, then `--resume`).
 * Gemini can only replace the system prompt, not append to it, so the instructions
 * go at the start of the first message, where they stay in the history.
 *
 * Written from the gemini-cli docs (headless.md, output/types.ts), not yet
 * tested for real.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin]
 * @param {string} [opts.model]
 * @param {string} [opts.approvalMode] default `auto_edit`
 * @param {string[]} [opts.extraArgs]
 */
export function geminiAgent(opts = {}) {
  const bin = opts.bin ?? 'gemini';
  return {
    name: 'gemini',
    label: 'Gemini CLI',
    bin,
    presetSessionId: true,

    settings: {
      model: [
        { value: '', label: opts.model ? `Default (${opts.model})` : 'Default' },
        ...['auto', 'pro', 'flash', 'flash-lite'].map((m) => ({ value: m, label: m })),
      ],
    },

    prepare({ root }) {
      return [...linkSkills(root), ...linkMarkdownAgents(root, '.gemini/agents')];
    },

    wrapPrompt(prompt, { systemPrompt, resume }) {
      return resume ? prompt : `${systemPrompt}\n\n${prompt}`;
    },

    command({ sessionId, resume, settings = {}, prompt }) {
      const args = [
        '--output-format', 'stream-json',
        '--approval-mode', opts.approvalMode ?? 'auto_edit',
        resume ? '--resume' : '--session-id', sessionId,
      ];
      const model = settings.model || opts.model;
      if (model) args.push('--model', model);
      args.push(...(opts.extraArgs ?? []));
      // `--prompt=…` as one argument: a message starting with "-" would otherwise be read as a flag.
      args.push(`--prompt=${prompt}`);
      return { cmd: bin, args, promptInArgs: true };
    },

    parse(msg, ctx) {
      switch (msg.type) {
        case 'init':
          return [{ type: 'session', id: msg.session_id }, { type: 'status', text: `${msg.model ?? 'gemini'} ready` }];
        case 'message':
          if (msg.role !== 'assistant') return [];
          if (msg.delta) {
            ctx.text = (ctx.text ?? '') + msg.content;
            return [{ type: 'delta', text: msg.content }];
          }
          ctx.text = '';
          return msg.content?.trim() ? [{ type: 'text', text: msg.content }] : [];
        case 'tool_use':
          return [...flush(ctx), { type: 'tool', id: msg.tool_id, name: msg.tool_name, summary: summarize(msg.parameters, ctx.root) }];
        case 'tool_result':
          return msg.status === 'error' ? [{ type: 'tool-error', id: msg.tool_id, text: msg.error?.message ?? 'error' }] : [];
        case 'error':
          return msg.severity === 'error' ? [{ type: 'tool-error', text: msg.message }] : [];
        case 'result':
          return [
            ...flush(ctx),
            { type: 'done', ok: msg.status !== 'error', error: msg.error?.message, durationMs: msg.stats?.duration_ms, tokens: msg.stats },
          ];
        default:
          return [];
      }
    },

    isMissingSession(stderr) {
      return /session.*not found|no session/i.test(stderr);
    },
  };
}

/** Join the deltas into one finished text so it gets saved to the history. */
function flush(ctx) {
  const text = ctx.text?.trim();
  ctx.text = '';
  return text ? [{ type: 'text', text }] : [];
}

function summarize(params = {}, root) {
  const file = params.file_path ?? params.absolute_path ?? params.path;
  if (file) return path.isAbsolute(file) ? path.relative(root, file) : file;
  return String(params.command ?? params.pattern ?? params.query ?? '').slice(0, 160);
}
