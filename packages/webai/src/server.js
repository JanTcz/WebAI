import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const BASE = '/__webai';
export const BRIDGE_TOKEN_FILE = 'bridge-token';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The overlay's HTTP API. The endpoints run an agent with write access to the
 * sources, so they are protected by:
 * - a token from the injected script,
 * - Origin/Sec-Fetch-Site against requests from foreign pages,
 * - Host against DNS rebinding (a foreign domain pointed at 127.0.0.1),
 * - client address: this machine only, even when `astro dev --host` exposes the site to the network.
 *
 * `allowRemote` disables the last two checks. A dev server in a container
 * needs that, since the browser comes in over the Docker network.
 * `trustProxy`: requests come through a reverse proxy on this machine (Next.js
 * rewrites), so the browser's address and host are in X-Forwarded-For/-Host.
 */
export function createMiddleware(session, token, { allowRemote = false, trustProxy = false } = {}) {
  const api = createApi(session);
  return (req, res, next) => {
    const route = routeOf(req);
    if (route == null) return next();
    if (!browserAllowed(req, token, { allowRemote, trustProxy })) return json(res, 403, { error: 'forbidden' });
    return api(req, res, route);
  };
}

/**
 * Variant for a dev server in a container: checks the browser like
 * `createMiddleware`, but forwards the request to the bridge on the host, where the agents run.
 * The bridge token is read on every request so it survives a bridge restart.
 */
export function createProxyMiddleware({ token, bridge, root, stateDir, allowRemote = true, trustProxy = false }) {
  const tokenFile = path.resolve(root, stateDir, BRIDGE_TOKEN_FILE);
  const down = `The agent bridge on the host is not responding (${bridge}). Start it on the host: npx webai-bridge`;
  return (req, res, next) => {
    const route = routeOf(req);
    if (route == null) return next();
    if (!browserAllowed(req, token, { allowRemote, trustProxy })) return json(res, 403, { error: 'forbidden' });

    let bridgeToken;
    try {
      bridgeToken = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return json(res, 502, { error: `${down} (missing ${path.relative(root, tokenFile)})` });
    }
    const url = new URL(BASE + route + new URL(req.url, 'http://x').search, bridge);
    const headers = { 'x-webai-token': bridgeToken };
    for (const h of ['content-type', 'content-length', 'last-event-id']) if (req.headers[h]) headers[h] = req.headers[h];

    const upstream = http.request(url, { method: req.method, headers }, (up) => {
      if (up.statusCode === 403) {
        up.resume();
        return json(res, 502, { error: 'The bridge rejected the token. Is it running for this project (--root)?' });
      }
      res.writeHead(up.statusCode, up.headers);
      // The bridge going away mid-stream (SSE) must end the browser's response too.
      up.on('aborted', () => res.destroy());
      up.pipe(res);
    });
    upstream.on('error', () => res.headersSent ? res.end() : json(res, 502, { error: down }));
    // SSE: when the browser leaves, close the bridge connection too.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}

/** Bridge on the host: called only by the dev server (not the browser), with a token. */
export function createBridgeHandler(session, token, describe) {
  const api = createApi(session);
  return (req, res) => {
    const route = routeOf(req);
    if (route == null) return json(res, 404, { error: 'not found' });
    // No token: the dev server only reports to the terminal what the bridge offers.
    if (route === '/health' && req.method === 'GET') return json(res, 200, { agents: describe() });
    // Browsers send Origin, the dev server doesn't: no direct access from web pages.
    if (req.headers.origin || req.headers['x-webai-token'] !== token) return json(res, 403, { error: 'forbidden' });
    return api(req, res, route);
  };
}

function createApi(session) {
  return async (req, res, route) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && route === '/state') return json(res, 200, session.snapshot());
      if (req.method === 'GET' && route === '/events') {
        // After a drop EventSource sends Last-Event-ID, the `since` query stays the original.
        const since = Math.max(Number(url.searchParams.get('since') ?? 0), Number(req.headers['last-event-id'] ?? 0));
        return events(req, res, session, since);
      }
      if (req.method === 'POST' && route === '/send') {
        const body = await readJson(req);
        if (typeof body.message !== 'string' || !body.message.trim()) return json(res, 400, { error: 'Empty message.' });
        if (session.busy) return json(res, 409, { error: 'The agent is still working on the previous message.' });
        session.send(body);
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && route === '/settings') {
        return json(res, 200, { settings: session.setSettings(await readJson(req)) });
      }
      if (req.method === 'POST' && route === '/permission') {
        const { id, allow } = await readJson(req);
        if (typeof id !== 'string' || typeof allow !== 'boolean') return json(res, 400, { error: 'id is the request, allow is true or false.' });
        session.answerPermission(id, allow);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/stop') return json(res, 200, { stopped: session.stop() });
      if (req.method === 'GET' && route === '/history') return json(res, 200, session.history.list());
      if (req.method === 'POST' && route === '/history/restore') {
        const { index } = await readJson(req);
        if (!Number.isInteger(index)) return json(res, 400, { error: 'index is a version number.' });
        return json(res, 200, session.restoreVersion(index));
      }
      if (req.method === 'POST' && route === '/reset') {
        session.reset();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.status ?? (err instanceof BadRequest ? 400 : 500), { error: err.message });
    }
  };
}

export function routeOf(req) {
  const { pathname } = new URL(req.url, 'http://localhost');
  return pathname.startsWith(BASE + '/') ? pathname.slice(BASE.length) : null;
}

function browserAllowed(req, token, opts) {
  const url = new URL(req.url, 'http://localhost');
  return pageAllowed(req, opts) && (req.headers['x-webai-token'] ?? url.searchParams.get('token')) === token;
}

/**
 * Whether a request may come from the page in the browser: this machine (unless
 * `allowRemote`) and the same origin. Also guards the script that carries the token.
 */
export function pageAllowed(req, { allowRemote = false, trustProxy = false } = {}) {
  const forwarded = trustProxy && isLoopback(req.socket.remoteAddress);
  const host = (forwarded && req.headers['x-forwarded-host']?.split(',')[0].trim()) || req.headers.host;
  const addr = (forwarded && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  if (!allowRemote && !(isLoopback(addr) && LOOPBACK.has(hostname(host)))) return false;
  return sameOrigin(req, host);
}

function isLoopback(addr = '') {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function hostname(host = '') {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

// Another port on localhost is `same-site`, not `same-origin`: neither may read the token.
function sameOrigin(req, host) {
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function events(req, res, session, since) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform: proxies in between (Next.js rewrites) must not gzip and so buffer the stream.
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const write = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
  for (const ev of session.events) if (ev.seq > since) write(ev);
  res.write(`event: ready\ndata: ${JSON.stringify({ busy: session.busy })}\n\n`);
  const unsubscribe = session.subscribe(write);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

class BadRequest extends Error {}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new BadRequest('Request is too large.');
  }
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    throw new BadRequest('Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected a JSON object.');
  return body;
}
