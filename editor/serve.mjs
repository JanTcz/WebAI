// Local static server for the editor: node editor/serve.mjs → http://localhost:4500/editor/
// The root is the whole repo; the editor imports the overlay from packages/webai.
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4500);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

http
  .createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      statSync(file);
    } catch {
      return res.writeHead(404).end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Editor: http://localhost:${PORT}/editor/`));
