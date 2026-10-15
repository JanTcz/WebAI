import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgents } from './agents/index.js';
import { consoleLogger } from './config.js';
import { injectHtml, SRC_ATTR } from './html.js';
import { htmlTransformer } from './inject.js';
import { BASE, createMiddleware, createProxyMiddleware, json, pageAllowed, routeOf } from './server.js';
import { AgentSession, describeAgents } from './session.js';

const CLIENT_FILE = fileURLToPath(new URL('./client/overlay.js', import.meta.url));

/** The tag that starts the overlay on a page. */
export const BOOT_TAG = `<script type="module" src="${BASE}/boot.js"></script>`;

/**
 * webai for any dev server: the agents' session, the overlay's HTTP API and
 * the overlay's script, as one connect middleware. The framework plugins
 * (`/astro`, `/vite`, `/next`) and the `webai` CLI are thin layers over it.
 *
 * @param {import('./index').CreateWebaiOptions} [options]
 */
export function createWebai(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const token = randomBytes(24).toString('hex');
  const stateDir = options.stateDir ?? '.webai';
  const bridge = options.bridge ?? process.env.WEBAI_BRIDGE ?? null;
  const allowRemote = options.allowRemote ?? false;
  const trustProxy = options.trustProxy ?? false;
  let logger = options.logger ?? consoleLogger;
  const log = { info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m) => (logger.error ?? logger.warn)(m) };

  /** What the page's `start()` gets. `reload`: reload after the agent's changes (no hot reload). */
  const client = {
    base: BASE,
    token,
    srcAttr: SRC_ATTR,
    triggers: options.triggers ?? ['shift-click'],
    fab: options.fab ?? true,
    reload: options.reload ?? false,
  };

  let session = null;
  let api;
  if (bridge) {
    // Dev server in a container, agents on the host (logins, ~/.claude, skills).
    api = createProxyMiddleware({ token, bridge, root, stateDir, trustProxy });
  } else {
    // "Other" from another machine on the network = arbitrary command on this one: never editable from the panel.
    const agents = resolveAgents(allowRemote ? { ...options, custom: { ...options.custom, editable: false } } : options);
    session = new AgentSession({ root, agents, stateDir, logger: log });
    api = createMiddleware(session, token, { allowRemote, trustProxy });
  }

  const boot = `import { start } from '${BASE}/client.js';\nstart(${JSON.stringify(client)});\n`;
  const script = (res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  /** API and scripts under `/__webai/`; everything else goes on to `next`. */
  const middleware = (req, res, next) => {
    const route = routeOf(req);
    if (req.method === 'GET' && route === '/client.js') return script(res, fs.readFileSync(CLIENT_FILE));
    if (req.method === 'GET' && route === '/boot.js') {
      // It carries the token: only for this site's own pages.
      if (!pageAllowed(req, { allowRemote, trustProxy })) return json(res, 403, { error: 'forbidden' });
      return script(res, boot);
    }
    return api(req, res, next);
  };

  return {
    root,
    token,
    client,
    session,
    middleware,
    /** Middleware that adds the overlay to every HTML page the next handlers send. */
    injector: htmlTransformer((html) => injectHtml(html, BOOT_TAG)),
    setLogger(next) {
      logger = next;
    },
    /** Detects the agents; resolves to a line for the terminal. */
    async ready() {
      const how = client.triggers.join(' / ');
      if (!bridge) {
        await session.detect();
        return `AI overlay active: ${how} on a page element. Agents: ${describeAgents(session)}.`;
      }
      const state = await fetch(new URL(`${BASE}/health`, bridge), { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json())
        .catch(() => null);
      return `AI overlay active: ${how} on a page element. Agents via bridge ${bridge}`
        + (state ? `: ${state.agents}.` : ', which is not running yet (on the host: npx webai bridge).');
    },
    dispose() {
      session?.dispose();
    },
  };
}
