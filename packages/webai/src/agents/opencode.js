import { cleanStderr, inDocker, relPath } from './docker.js';
import { linkSkills } from './pack.js';

const TOOL_NAMES = { read: 'Read', edit: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep', list: 'LS', bash: 'Bash', webfetch: 'WebFetch' };

/**
 * May edit files, but not use the shell or the web (same as Claude without allowedTools).
 * Passed via OPENCODE_CONFIG_CONTENT, which takes precedence over the project's opencode.json.
 */
const PERMISSIONS = { edit: 'allow', bash: 'deny', webfetch: 'deny' };

/**
 * Adapter for OpenCode (`opencode run --format json`). Its `-free` models
 * (OpenCode Zen) work without an account or API key, but only from the OpenCode client.
 *
 * OpenCode assigns the session ID (`ses_…`), later messages resume via `-s`.
 * It can't append a system prompt from the command line, so it goes at the start
 * of the first message. JSON mode has no deltas, text arrives in blocks.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin] default `opencode`
 * @param {{ service: string, workdir: string }} [opts.docker] run in a container, see docker-compose.yml
 * @param {string} [opts.model] default `opencode/deepseek-v4.1-flash-free`
 * @param {{ value: string, label: string }[]} [opts.models]
 * @param {Record<string, string>} [opts.permission] default edit: allow, bash and webfetch: deny
 * @param {string[]} [opts.extraArgs]
 */
export function opencodeAgent(opts = {}) {
  const bin = opts.bin ?? 'opencode';
  const docker = opts.docker && inDocker(opts.docker);
  const run = (args, env) => (docker ? docker.command(bin, args, env) : { cmd: bin, args, env });
  const defaultModel = opts.model ?? 'opencode/deepseek-v4.1-flash-free';

  return {
    name: 'opencode',
    label: docker ? 'OpenCode (Docker)' : 'OpenCode',
    bin: docker ? 'docker' : bin,
    versionArgs: run(['--version']).args,
    presetSessionId: false,

    settings: {
      model: [
        { value: '', label: `Default (${defaultModel})` },
        ...(opts.models ?? DEFAULT_MODELS),
      ],
    },

    prepare({ root }) {
      return linkSkills(root);
    },

    wrapPrompt(prompt, { systemPrompt, resume }) {
      return resume ? prompt : `${systemPrompt}\n\n${prompt}`;
    },

    command({ sessionId, resume, settings = {}, prompt }) {
      const args = ['run', '--format', 'json', '--model', settings.model || defaultModel];
      if (resume && sessionId) args.push('--session', sessionId);
      args.push(...(opts.extraArgs ?? []), '--', prompt);
      const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { ...PERMISSIONS, ...opts.permission } }) };
      return { ...run(args, env), promptInArgs: true };
    },

    parse(msg, ctx) {
      const out = [];
      if (msg.sessionID && !ctx.session) {
        ctx.session = msg.sessionID;
        out.push({ type: 'session', id: msg.sessionID });
      }
      const part = msg.part ?? {};
      switch (msg.type) {
        case 'text':
          if (part.text?.trim()) out.push({ type: 'text', text: part.text });
          break;
        case 'tool_use': {
          const state = part.state ?? {};
          if (part.tool === 'invalid') {
            out.push({ type: 'tool-error', id: part.callID, text: String(state.input?.error ?? 'Invalid tool call.').slice(0, 400) });
            break;
          }
          const input = state.input ?? {};
          const base = opts.docker?.workdir ?? ctx.root;
          out.push({
            type: 'tool',
            id: part.callID,
            name: TOOL_NAMES[part.tool] ?? part.tool,
            summary: relPath(input.filePath ?? input.path, base) || String(input.pattern ?? input.command ?? '').slice(0, 160),
          });
          if (state.status === 'error') out.push({ type: 'tool-error', id: part.callID, text: String(state.error ?? '').slice(0, 400) });
          break;
        }
        case 'step_finish':
          ctx.costUsd = (ctx.costUsd ?? 0) + (part.cost ?? 0);
          break;
        case 'error':
          ctx.error = msg.error?.data?.message ?? msg.error?.name ?? 'OpenCode error.';
          break;
      }
      return out;
    },

    // OpenCode doesn't report the end of a run in JSON; the exit code and any error decide.
    onExit({ code, signal }, ctx) {
      if (signal) return [{ type: 'done', ok: false, error: 'Stopped.' }];
      const error = ctx.error ?? (code === 0 ? undefined : cleanStderr(ctx.stderr).slice(-600) || `OpenCode exited with code ${code}.`);
      return [{ type: 'done', ok: !error, error, costUsd: ctx.costUsd ?? 0 }];
    },
  };
}

/** Free OpenCode Zen models. The lineup changes, current list: `opencode models opencode`. */
const DEFAULT_MODELS = [
  { value: 'opencode/deepseek-v4.1-flash-free', label: 'DeepSeek V4.1 Flash (free)' },
  { value: 'opencode/mimo-v2.6-flash-free', label: 'MiMo V2.6 Flash (free)' },
  { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra (free)' },
  { value: 'opencode/step-5-preview-free', label: 'Step 5 Preview (free)' },
];
