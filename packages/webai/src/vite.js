import { createWebai } from './core.js';

/**
 * Vite plugin: `plugins: [webai()]` in vite.config, for React, Vue, Svelte,
 * SvelteKit, Solid, Qwik… on Vite's dev server. Only in `vite dev`. The
 * overlay goes into every HTML page the dev server sends, SPA or server-rendered.
 *
 * @param {import('./index').WebAiOptions & { root?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function webai(options = {}) {
  let w = null;
  return {
    name: '@jantcz/webai',
    apply: 'serve',
    // For other plugins (and tests): the running instance, `null` before the config is resolved.
    api: {
      get webai() {
        return w;
      },
    },
    configResolved(config) {
      w = createWebai({ ...options, root: options.root ?? config.root });
      w.setLogger(viteLogger(config.logger));
    },
    configureServer(server) {
      // Before Vite's own middlewares: the HTML they send passes the injector.
      server.middlewares.use(w.middleware);
      server.middlewares.use(w.injector);
      w.ready().then((line) => server.config.logger.info(`[webai] ${line}`, { timestamp: true }));
      server.httpServer?.once('close', () => w.dispose());
    },
  };
}

function viteLogger(logger) {
  return {
    info: (msg) => logger.info(`[webai] ${msg}`, { timestamp: true }),
    warn: (msg) => logger.warn(`[webai] ${msg}`, { timestamp: true }),
    error: (msg) => logger.error(`[webai] ${msg}`, { timestamp: true }),
  };
}
