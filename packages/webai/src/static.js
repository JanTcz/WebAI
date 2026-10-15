import fs from 'node:fs';
import path from 'node:path';
import { annotateHtml } from './html.js';

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', xml: 'application/xml',
  webmanifest: 'application/manifest+json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', pdf: 'application/pdf', wasm: 'application/wasm',
};

export const mimeType = (file) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

/**
 * Serves a folder of static files. HTML pages get `data-webai-src` positions
 * (file:line:col), so the agent knows exactly where an element is. Nothing is
 * cached: every reload shows the files as they are now.
 */
export function staticFiles(dir) {
  dir = path.resolve(dir);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    // Dotfiles (.env, .git, .webai) stay private, and nothing outside the folder is served.
    if (rel.split('/').some((part) => part.startsWith('.'))) return send(res, 404, `Not found: ${rel}`);
    let file = path.join(dir, rel);
    // Defense in depth: the dotfile check above already rejects every `..` segment, so this can't trigger.
    /* node:coverage ignore next */
    if (!inside(dir, file)) return send(res, 403, 'Forbidden');
    if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
      if (!rel.endsWith('/')) return redirect(res, `${rel}/`);
      file = path.join(file, 'index.html');
    }
    // Clean URLs: /about → about.html
    if (!fs.existsSync(file) && !path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return send(res, 404, `Not found: ${rel}`);
    if (!inside(fs.realpathSync(dir), fs.realpathSync(file))) return send(res, 403, 'Forbidden'); // a symlink out

    const type = mimeType(file);
    let body = fs.readFileSync(file);
    if (type.startsWith('text/html')) body = annotateHtml(body.toString('utf8'), path.relative(dir, file).split(path.sep).join('/'));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${status}</title><p>${text.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`);
}

function redirect(res, location) {
  res.writeHead(301, { Location: encodeURI(location) });
  res.end();
}
