/**
 * Connect middleware that passes `transform(html, req)` over every HTML page
 * the next handlers send, whatever they are: a framework's dev server, a
 * reverse proxy or a static file server. Other responses go through untouched,
 * and so do compressed ones (the proxy asks its upstream for uncompressed pages).
 */
export function htmlTransformer(transform) {
  return (req, res, next) => {
    if (req.method !== 'GET' || !(req.headers.accept ?? '').includes('text/html')) return next();
    const original = { writeHead: res.writeHead, write: res.write, end: res.end };
    let head = null; // writeHead arguments, held back until we know what the body is
    let chunks = null; // null = not decided yet, false = passing through

    const restore = () => Object.assign(res, original);
    const flushHead = () => {
      if (head) original.writeHead.apply(res, head);
      head = null;
    };
    // At the first byte of the body: from here on, either buffer the page or pass everything through.
    const decide = () => {
      if (chunks !== null) return;
      if (head) {
        const [status, reason, headers] = typeof head[1] === 'string' ? head : [head[0], undefined, head[1]];
        for (const [k, v] of headerEntries(headers)) res.setHeader(k, v);
        head = reason === undefined ? [status] : [status, reason];
      }
      const type = String(res.getHeader('content-type') ?? '');
      if (/^text\/html\b/i.test(type) && !res.getHeader('content-encoding')) {
        chunks = [];
      } else {
        chunks = false;
        restore();
        flushHead();
      }
    };

    res.writeHead = (...args) => {
      head = args;
      return res;
    };
    res.write = (chunk, encoding, cb) => {
      decide();
      if (chunks === false) return res.write(chunk, encoding, cb);
      chunks.push(toBuffer(chunk, encoding));
      if (typeof encoding === 'function') encoding();
      else cb?.();
      return true;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === 'function') [chunk, cb] = [undefined, chunk];
      else if (typeof encoding === 'function') [encoding, cb] = [undefined, encoding];
      decide();
      if (chunks === false) return res.end(chunk, encoding, cb);
      if (chunk != null) chunks.push(toBuffer(chunk, encoding));
      restore();
      const body = Buffer.from(transform(Buffer.concat(chunks).toString('utf8'), req));
      if (!res.headersSent) {
        res.removeHeader('content-length');
        res.setHeader('content-length', body.length);
      }
      flushHead();
      return res.end(body, cb);
    };
    next();
  };
}

function toBuffer(chunk, encoding) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
}

/** writeHead's headers: an object, a flat `[name, value, …]` list or `[[name, value], …]`. */
function headerEntries(headers) {
  if (!headers) return [];
  if (!Array.isArray(headers)) return Object.entries(headers);
  if (Array.isArray(headers[0])) return headers;
  const out = [];
  for (let i = 0; i < headers.length; i += 2) out.push([headers[i], headers[i + 1]]);
  return out;
}
