// @ts-check
import { defineConfig } from 'astro/config';
import webai from '@jantcz/webai/astro';
import webaiOptions from './webai.config.mjs';

// webai runs only in `astro dev` and adds nothing to the build (guarded by test/).
export default defineConfig({
  integrations: [webai(webaiOptions)],
  build: { inlineStylesheets: 'always', format: 'directory' },
  devToolbar: { enabled: false },
});
