import path from 'node:path';
import { cleanStderr, inDocker, relPath } from './docker.js';
import { PACK_DIR } from './pack.js';

/** Default tools: read, search, edit. No `bash`, same as Claude without allowedTools. */
const TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'];

const TOOL_NAMES = { read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS', bash: 'Bash' };

/**
 * Adapter for Pi (https://pi.dev, `@earendil-works/pi-coding-agent`).
 *
 * `--session-id` both creates and resumes a session, so we pick the ID ourselves
 * and the same flag works for the first and later messages. Output is `--mode json`.
 *
 * With the `docker` option Pi runs in a container: `docker compose run --rm <service>`
 * per message. The model runs on an API key (OpenRouter, MiniMax, …), so the
 * container needs no logins from the host and the tools only see the mounted
 * repo. Sessions survive in the service's volume.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin] default `pi`
 * @param {{ service: string, workdir: string }} [opts.docker] compose service and the project root inside it
 * @param {string} [opts.model] e.g. `openrouter/poolside/laguna-s-2.1:free`
 * @param {{ value: string, label: string }[]} [opts.models] models offered in the panel
 * @param {string[]} [opts.tools] default without `bash`
 * @param {boolean} [opts.skills] load skills from `@jantcz/webai/agents`, default `true`
 * @param {string[]} [opts.extraArgs]
 */
export function piAgent(opts = {}) {
  const bin = opts.bin ?? 'pi';
  const docker = opts.docker && inDocker(opts.docker);
  const run = (args) => (docker ? docker.command(bin, args) : { cmd: bin, args });

  return {
    name: 'pi',
    label: docker ? 'Pi (Docker)' : 'Pi',
    bin: docker ? 'docker' : bin,
    versionArgs: run(['--version']).args,
    presetSessionId: true,

    settings: {
      model: [
        { value: '', label: opts.model ? `Default (${opts.model})` : 'Default from Pi settings' },
        ...(opts.models ?? DEFAULT_MODELS),
      ],
      thinking: [
        { value: '', label: 'Default' },
        ...['off', 'low', 'medium', 'high'].map((v) => ({ value: v, label: v })),
      ],
    },

    command({ sessionId, systemPrompt, settings = {}, prompt, root }) {
      const args = [
        '--mode', 'json',
        '--session-id', sessionId,
        '--append-system-prompt', systemPrompt,
        '--tools', (opts.tools ?? TOOLS).join(','),
        // Don't load project extensions, settings and MCP from `.pi/`: anyone with repo access can write to the project.
        '--no-approve',
      ];
      const model = settings.model || opts.model;
      if (model) args.push('--model', model);
      if (settings.thinking) args.push('--thinking', settings.thinking);
      if (opts.skills !== false) {
        const skills = path.join(PACK_DIR, 'skills');
        // In the container, the same path relative to the project root (the whole repo is mounted).
        args.push('--skill', docker ? docker.path(skills, root) : skills);
      }
      args.push(...(opts.extraArgs ?? []));
      // `--`: a message starting with "-" is not a flag.
      args.push('--', prompt);
      return { ...run(args), promptInArgs: true };
    },

    parse(msg, ctx) {
      const base = opts.docker?.workdir ?? ctx.root;
      switch (msg.type) {
        case 'session':
          return [{ type: 'session', id: msg.id }];
        case 'message_update': {
          const ev = msg.assistantMessageEvent;
          return ev?.type === 'text_delta' ? [{ type: 'delta', text: ev.delta }] : [];
        }
        case 'message_end': {
          const m = msg.message;
          if (m?.role !== 'assistant') return [];
          ctx.costUsd = (ctx.costUsd ?? 0) + (m.usage?.cost?.total ?? 0);
          if (m.stopReason === 'error') ctx.error = m.errorMessage ?? 'Model error.';
          const text = (Array.isArray(m.content) ? m.content : [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
          return text ? [{ type: 'text', text }] : [];
        }
        case 'tool_execution_start':
          return [{ type: 'tool', id: msg.toolCallId, name: TOOL_NAMES[msg.toolName] ?? msg.toolName, summary: summarize(msg.args, base) }];
        case 'tool_execution_end':
          return msg.isError ? [{ type: 'tool-error', id: msg.toolCallId, text: resultText(msg.result).slice(0, 400) }] : [];
        case 'auto_retry_start':
          return [{ type: 'status', text: `Retrying (${msg.attempt}/${msg.maxAttempts}): ${msg.errorMessage}` }];
        case 'agent_settled':
          return [{
            type: 'done',
            ok: !msg.aborted && !ctx.error,
            error: msg.aborted ? 'Stopped.' : ctx.error,
            costUsd: ctx.costUsd,
          }];
        default:
          return [];
      }
    },

    onExit({ code, signal }, ctx) {
      if (signal) return [{ type: 'done', ok: false, error: 'Stopped.' }];
      // The session-creation warning is expected (`--session-id` creates it the first time).
      const stderr = cleanStderr(ctx.stderr).replace(/^Warning: No project session found.*\n?/m, '').trim();
      const hint = /no model|api key|not_ready|credentials/i.test(stderr)
        ? '\nSet a provider key (e.g. OPENROUTER_API_KEY in .env) and a model.'
        : '';
      return [{ type: 'done', ok: false, error: `${stderr.slice(-600) || `Pi exited with code ${code}.`}${hint}` }];
    },
  };
}

/** Models for the panel. Prices and availability change, the default list is just a starting point. */
const DEFAULT_MODELS = [
  { value: 'openrouter/poolside/laguna-s-2.1:free', label: 'Laguna S 2.1 (OpenRouter, free)' },
  { value: 'openrouter/cohere/north-mini-code:free', label: 'North Mini Code (OpenRouter, free)' },
  { value: 'openrouter/minimax/minimax-m3', label: 'MiniMax M3 (OpenRouter, cheap)' },
];

function summarize(args = {}, base) {
  return relPath(args.path ?? args.file_path, base) || String(args.pattern ?? args.command ?? '').slice(0, 160);
}

function resultText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('\n');
  return '';
}
