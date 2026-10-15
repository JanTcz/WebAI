// @jantcz/webai: click an element on your site, tell an AI agent what to change.
// The core for any dev server; framework plugins are in `@jantcz/webai/astro`,
// `/vite` and `/next`, the CLI is `npx @jantcz/webai`.

export { claudeAgent, codexAgent, customAgent, geminiAgent, opencodeAgent, piAgent, webaiAgent } from './agents/index.js';
export { loadConfig } from './config.js';
export { BOOT_TAG, createWebai } from './core.js';
export { annotateHtml, injectHtml, SRC_ATTR } from './html.js';
export { htmlTransformer } from './inject.js';
export { BASE } from './server.js';
