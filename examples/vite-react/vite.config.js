import webai from '@jantcz/webai/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// webai runs only in `vite dev` and adds nothing to the build.
export default defineConfig({
  plugins: [react(), webai()],
});
