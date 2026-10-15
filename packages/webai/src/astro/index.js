import { fileURLToPath } from 'node:url';
import { createWebai } from '../core.js';
import { annotatePlugin } from './annotate.js';

/**
 * Astro integration: `integrations: [webai()]` in astro.config. Only in
 * `astro dev`; the build has no trace of it. Templates get their exact source
 * positions from Astro's own compiler.
 *
 * @param {import('../index').WebAiOptions} [options]
 * @returns {import('astro').AstroIntegration}
 */
export default function webai(options = {}) {
  let w = null;
  return {
    name: '@jantcz/webai',
    hooks: {
      'astro:config:setup'({ command, config, updateConfig, injectScript }) {
        if (command !== 'dev') return;
        const root = fileURLToPath(config.root);
        w = createWebai({ ...options, root });
        updateConfig({ vite: { plugins: [annotatePlugin({ root })] } });
        injectScript('page', `import { start } from '@jantcz/webai/client'; start(${JSON.stringify(w.client)});`);
      },

      async 'astro:server:setup'({ server, logger }) {
        if (!w) return;
        w.setLogger(logger);
        server.middlewares.use(w.middleware);
        logger.info(await w.ready());
      },

      // After a config change Astro restarts the server in the same process: the old agent must not keep running.
      'astro:server:done'() {
        w?.dispose();
        w = null;
      },
    },
  };
}
