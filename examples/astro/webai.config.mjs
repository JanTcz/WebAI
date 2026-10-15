// Options for webai. Read by astro.config.mjs and by the host bridge
// (`npm run bridge`), which runs the agents during development in Docker.

// OpenCode and Pi run in the `agents` container (docker-compose.yml), not on the host.
const docker = { service: 'agents', workdir: '/workspace/examples/astro' };

/** @type {import('@jantcz/webai').WebAiOptions} */
export default {
  triggers: ['shift-click'],
  // Free models, no account or key needed.
  opencode: { docker },
  // Needs a key in .env (OPENROUTER_API_KEY, MINIMAX_API_KEY, …).
  pi: { docker },
};
