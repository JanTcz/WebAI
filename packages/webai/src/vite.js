import { createRequire } from 'node:module';
import path from 'node:path';
import { createWebai } from './core.js';
import { SRC_ATTR } from './html.js';

const JSX_RUNTIME = 'react/jsx-dev-runtime';
const JSX_FILE = /\.[jt]sx$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The numbers of one source map segment (base64 VLQ). */
function vlq(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >> 1) : value >> 1);
    value = shift = 0;
  }
  return out;
}

/**
 * How many lines something put in front of the file's own code (plugin-react's Fast Refresh header is
 * 19 of them): the first mapped line of the source map minus the source line it maps to. esbuild numbers
 * the JSX of the code it is given, so without this the places it reports are that much too high.
 */
export function leadingOffset(mappings) {
  const lines = typeof mappings === 'string' ? mappings.split(';') : [];
  const first = lines.findIndex((l) => l !== '');
  if (first < 1) return 0;
  const [, , srcLine] = vlq(lines[first].split(',')[0]);
  return srcLine === undefined || srcLine < 0 ? 0 : Math.max(0, first - srcLine); // a broken map says nothing
}
const VIRTUAL = '\0webai-jsx-dev-runtime';

/**
 * React 19 dropped `_debugSource`, but the JSX transform still hands `jsxDEV` the place of every
 * element ({ fileName, lineNumber, columnNumber }) and React ignores it. This stand-in for
 * `react/jsx-dev-runtime` writes it to the host elements as `data-webai-src`, like Astro's compiler does.
 */
export function jsxRuntimeModule(root, attr = SRC_ATTR) {
  const base = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  return `import * as real from '${JSX_RUNTIME}';
const ROOT = ${JSON.stringify(base)};
const ATTR = ${JSON.stringify(attr)};
export const Fragment = real.Fragment;
export const jsx = real.jsx;
export const jsxs = real.jsxs;
export function jsxDEV(type, props, key, isStatic, source, self) {
  const file = source?.fileName?.replace(/\\\\/g, '/');
  if (typeof type === 'string' && file && !file.includes('/node_modules/') && props && !(ATTR in props)) {
    const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : file;
    // What the transforms before esbuild put in front of the file (see leadingOffset in vite.js).
    const line = source.lineNumber - (globalThis.__webaiLineOffsets?.[source.fileName] ?? 0);
    props = { ...props, [ATTR]: line >= 1 ? rel + ':' + line + ':' + source.columnNumber : rel };
  }
  return real.jsxDEV(type, props, key, isStatic, source, self);
}
`;
}

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
    // Before Vite's own resolver: React's dev runtime is swapped for the one that records source places.
    enforce: 'pre',
    // For other plugins (and tests): the running instance, `null` before the config is resolved.
    api: {
      get webai() {
        return w;
      },
    },
    config(config) {
      // The stand-in imports the real runtime, which must be pre-bundled up front (a discovery at run time reloads the page).
      const from = path.resolve(options.root ?? config.root ?? process.cwd(), 'package.json');
      try {
        createRequire(from).resolve(JSX_RUNTIME);
      } catch {
        return; // not a React project
      }
      return { optimizeDeps: { include: [JSX_RUNTIME] } };
    },
    // After plugin-react (it must come first in `plugins`): tell the runtime how far its header pushed the lines down.
    transform(code, id) {
      const file = id.split('?')[0];
      if (!JSX_FILE.test(file) || file.includes('/node_modules/')) return;
      let map;
      try {
        map = this.getCombinedSourcemap();
      } catch {
        return; // no source map to read it from: the places stay as esbuild gave them
      }
      const offset = leadingOffset(map?.mappings);
      if (!offset) return;
      // One line, in front of the first: it must not move any line.
      const note = `globalThis.__webaiLineOffsets = { ...globalThis.__webaiLineOffsets, [${JSON.stringify(file)}]: ${offset} };`;
      return { code: note + code, map: null };
    },
    resolveId(source, importer) {
      if (source === JSX_RUNTIME && importer !== VIRTUAL) return VIRTUAL;
    },
    load(id) {
      if (id === VIRTUAL) return jsxRuntimeModule(w.root);
    },
    configResolved(config) {
      const names = config.plugins?.map((p) => p.name) ?? [];
      if (names.indexOf('vite:react-babel') > names.indexOf('@jantcz/webai') && names.includes('@jantcz/webai')) {
        config.logger.warn('[webai] List webai() after react() in plugins: otherwise the line numbers of React elements are off by the length of its Fast Refresh header.');
      }
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
