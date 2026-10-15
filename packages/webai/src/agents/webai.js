import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../bin/webai-agent.js', import.meta.url));

/** Free models in fallback order, best at tool use first (measured October 2026). */
const FREE = ['poolside/laguna-s-2.1:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free'];

/**
 * Where the built-in agent sends its requests. Kilo Gateway serves free models
 * without a key (from a server; browsers are blocked by CORS, which doesn't
 * apply here). OpenRouter needs OPENROUTER_API_KEY (or WEBAI_API_KEY) in the
 * environment of the dev server; keys never go into the project's files.
 */
const PROVIDERS = {
  kilo: { label: 'Kilo Gateway: free models, no key', baseUrl: 'https://ai-gateway.kilo.ai/api/v1', model: FREE[0], fallbacks: FREE },
  openrouter: { label: 'OpenRouter (OPENROUTER_API_KEY)', baseUrl: 'https://openrouter.ai/api/v1', model: FREE[0], fallbacks: FREE.slice(0, 3) },
  custom: { label: 'Custom OpenAI-compatible endpoint (e.g. Ollama)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', fallbacks: [] },
};

/**
 * The built-in agent: no coding CLI needed, Node runs `bin/webai-agent.js`, a
 * small loop over any OpenAI-compatible API with file tools on the project
 * (list, search, read, edit, write, delete) and Openverse images. No shell.
 *
 * @param {object} [opts]
 * @param {'kilo' | 'openrouter' | 'custom'} [opts.provider] default `kilo`
 * @param {string} [opts.model]
 * @param {string} [opts.baseUrl] for `custom`
 */
export function webaiAgent(opts = {}) {
  const provider = (settings) => PROVIDERS[settings.provider || opts.provider || 'kilo'] ?? PROVIDERS.kilo;
  return {
    name: 'webai',
    label: 'Built-in (free models, OpenRouter, Ollama)',
    bin: process.execPath,
    versionArgs: ['--version'],
    presetSessionId: true,

    settings: {
      provider: Object.entries(PROVIDERS).map(([value, p]) => ({ value, label: p.label })),
      model: { type: 'text', label: 'Model', placeholder: FREE[0], default: '', hint: 'Empty = the provider\'s default; free models switch to the next one when busy.' },
      baseUrl: { type: 'text', label: 'Endpoint URL (custom)', placeholder: PROVIDERS.custom.baseUrl, default: '', hint: 'Only for the custom provider. Ollama: http://localhost:11434/v1' },
    },

    command({ sessionId, resume, systemPrompt, settings = {} }) {
      const p = provider(settings);
      const model = settings.model?.trim() || opts.model || p.model;
      const baseUrl = (p === PROVIDERS.custom && (settings.baseUrl?.trim() || opts.baseUrl)) || p.baseUrl;
      const args = [SCRIPT, '--session', sessionId, '--base-url', baseUrl, '--model', model, '--system', systemPrompt];
      // A model the user picked stays; the default may hand over to the next free one.
      if (!settings.model?.trim() && !opts.model) args.push('--fallbacks', p.fallbacks.join(','));
      if (resume) args.push('--resume');
      return { cmd: process.execPath, args, stdin: true };
    },

    // The script already speaks the session's events.
    parse(msg) {
      return msg && typeof msg.type === 'string' ? [msg] : [];
    },

    onExit({ code, signal }, ctx) {
      if (signal) return [{ type: 'done', ok: false, error: 'Stopped.' }];
      return [{ type: 'done', ok: false, error: ctx.stderr?.trim().slice(-600) || `The built-in agent exited with code ${code}.` }];
    },
  };
}
