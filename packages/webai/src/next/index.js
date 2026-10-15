import http from 'node:http';
import { createWebai } from '../core.js';
import { BASE } from '../server.js';

export const DEFAULT_PORT = 4399;
const KEY = Symbol.for('@jantcz/webai/next');

/**
 * Next.js: `export default withWebai(nextConfig)` in next.config.mjs, plus
 * `<WebaiScript />` from `@jantcz/webai/next/script` in the root layout.
 * Only in `next dev`. Next.js has no hook for middleware of its own, so the
 * overlay's API runs on a small server beside it (`port`, default 4399), and a
 * rewrite sends `/__webai/*` there: the page and the API stay on one origin.
 *
 * @param {object | ((phase: string, ctx: object) => object | Promise<object>)} [nextConfig]
 * @param {import('../index').WebAiOptions & { port?: number }} [options]
 */
export function withWebai(nextConfig = {}, options = {}) {
  return async (phase, ctx) => {
    const config = typeof nextConfig === 'function' ? await nextConfig(phase, ctx) : nextConfig;
    if (phase !== 'phase-development-server') return config;
    const port = options.port ?? DEFAULT_PORT;
    await startSidecar(port, options);
    const ours = [{ source: `${BASE}/:path*`, destination: `http://127.0.0.1:${port}${BASE}/:path*` }];
    return {
      ...config,
      async rewrites() {
        const theirs = (await config.rewrites?.()) ?? [];
        return Array.isArray(theirs) ? [...ours, ...theirs] : { ...theirs, beforeFiles: [...ours, ...(theirs.beforeFiles ?? [])] };
      },
    };
  };
}

/**
 * Next.js loads its config in more than one process; the first one serves the
 * overlay, the others find the port taken and leave it to that one.
 */
export async function startSidecar(port, options = {}) {
  globalThis[KEY] ??= new Promise((resolve) => {
    // Requests come through Next.js on this machine: the browser's host is in X-Forwarded-Host.
    // Fast Refresh shows the changes, no reload needed.
    const w = createWebai({ ...options, trustProxy: true });
    const server = http.createServer((req, res) => w.middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }));
    server.once('error', (err) => {
      w.dispose();
      resolve(err.code === 'EADDRINUSE' ? null : Promise.reject(err));
    });
    server.listen(port, '127.0.0.1', async () => {
      server.unref();
      console.log(`[webai] ${await w.ready()}`);
      resolve({ server, webai: w });
    });
  });
  return globalThis[KEY];
}
