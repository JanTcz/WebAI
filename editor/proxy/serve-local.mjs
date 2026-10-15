// Run the Worker locally without wrangler: node editor/proxy/serve-local.mjs
// Environment variables are passed as `env` (UPSTREAM_URL, UPSTREAM_KEY, …).
import http from 'node:http';
import worker from './worker.js';

const PORT = Number(process.env.PORT ?? 4510);
http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body,
    });
    const response = await worker.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Demo proxy: http://localhost:${PORT}/v1`));
