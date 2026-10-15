import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// Hop-by-hop headers belong to one connection, not to the forwarded request.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/**
 * Reverse proxy to a running dev server (Next.js, Django, Rails, Laravel,
 * Hugo, …), for `webai --target <url>`. Pages are requested uncompressed so the
 * overlay can be added to them; WebSockets (the upstream's hot reload) pass through.
 */
export function proxyTo(target) {
  target = new URL(target);
  const client = target.protocol === 'https:' ? https : http;

  const handler = (req, res) => {
    const headers = forwardHeaders(req, target);
    if ((req.headers.accept ?? '').includes('text/html')) headers['accept-encoding'] = 'identity';
    const upstream = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (up) => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k)) out[k] = v;
        // Redirects to the upstream's own address stay on the proxy.
        if (out.location?.startsWith(target.origin)) out.location = out.location.slice(target.origin.length) || '/';
        res.writeHead(up.statusCode, up.statusMessage, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>webai</title><p>The dev server at ${target.origin} is not responding (${err.code ?? err.message}). Is it running?</p>`);
    });
    req.pipe(upstream);
  };

  /** For the HTTP server's `upgrade` event. */
  handler.upgrade = (req, socket, head) => {
    const connect = target.protocol === 'https:'
      ? () => tls.connect({ host: target.hostname, port: target.port || 443, servername: net.isIP(target.hostname) ? undefined : target.hostname })
      : () => net.connect({ host: target.hostname, port: target.port || 80 });
    const up = connect();
    const headers = { ...forwardHeaders(req, target), connection: 'Upgrade', upgrade: req.headers.upgrade };
    up.on(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    const close = () => (up.destroy(), socket.destroy());
    up.on('error', close);
    socket.on('error', close);
  };

  return handler;
}

function forwardHeaders(req, target) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = target.host;
  // Dev servers that check Origin (CSRF, WebSockets) see their own address.
  if (headers.origin) headers.origin = target.origin;
  return headers;
}
