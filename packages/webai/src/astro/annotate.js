import { createRequire } from 'node:module';
import path from 'node:path';
import { SRC_ATTR } from '../html.js';

// Elements that cannot be clicked or whose content is raw text.
const SKIP = new Set([
  'html', 'head', 'meta', 'link', 'title', 'base', 'script', 'style',
  'noscript', 'template', 'slot',
]);

/**
 * Astro 7 switched to a Rust compiler that ignores the `annotateSourceFile`
 * option (data-astro-source-* attributes). So we annotate ourselves: every HTML
 * element in the template gets `data-webai-src="path:line:column"`.
 *
 * AST offset units differ between @astrojs/compiler-rs versions (0.3: UTF-8
 * bytes, 0.5: UTF-16 like JS strings). We work on a Buffer and verify each
 * position by checking that `<tag` really starts there.
 */
export async function loadParser(root) {
  const fromRoot = createRequire(path.join(root, 'package.json'));
  const fromAstro = createRequire(fromRoot.resolve('astro/package.json'));
  const mod = await import(fromAstro.resolve('@astrojs/compiler-rs'));
  return mod.parse;
}

export async function annotate(parse, source, relPath) {
  const { ast, diagnostics } = await parse(source, {});
  // Leave a broken template unannotated, Astro reports the error itself.
  if (diagnostics?.some((d) => d.severity === 'error')) return null;
  const buf = Buffer.from(source, 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lineStarts.push(i + 1);

  const elements = [];
  walk(ast.body, (node) => {
    if (node.type !== 'JSXElement') return;
    const open = node.openingElement;
    if (open?.name?.type !== 'JSXIdentifier') return; // Foo.Bar, svg:defs
    const name = open.name.name;
    if (!/^[a-z]/.test(name) || SKIP.has(name)) return; // components and skipped tags
    if (open.attributes.some((a) => a.name?.name === SRC_ATTR || a.name?.name === 'is:raw')) return;
    elements.push({ name, offset: open.start });
  });

  const toByte = offsetUnits(source, buf, elements);
  const inserts = [];
  for (const { name, offset } of elements) {
    const start = toByte(offset);
    // Position can't be verified: better no annotation than a broken template.
    if (!opensTag(buf, start, name)) continue;
    const { line, col } = position(buf, lineStarts, start);
    inserts.push({ at: start + 1 + Buffer.byteLength(name), text: ` ${SRC_ATTR}="${relPath}:${line}:${col}"` });
  }
  if (!inserts.length) return null;

  inserts.sort((a, b) => a.at - b.at);
  const parts = [];
  let last = 0;
  for (const { at, text } of inserts) {
    parts.push(buf.subarray(last, at), Buffer.from(text));
    last = at;
  }
  parts.push(buf.subarray(last));
  return Buffer.concat(parts).toString('utf8');
}

/** `<name` starts at the position and the name ends right after it (not `<p` from `<pre`). */
function opensTag(buf, at, name) {
  const end = at + 1 + Buffer.byteLength(name);
  return buf.toString('utf8', at, end) === `<${name}` && /[\s/>]/.test(String.fromCharCode(buf[end]));
}

/**
 * Decides once per file whether offsets are in bytes or in UTF-16.
 * The deciding element is the first one where the two readings differ (non-ASCII
 * text precedes it) and exactly one of them matches. If they never differ, both are the same.
 */
function offsetUnits(source, buf, elements) {
  const map = utf16ByteMap(source);
  const fromUtf16 = (o) => map[o] ?? -1;
  for (const { name, offset } of elements) {
    if (fromUtf16(offset) === offset) continue;
    const asBytes = opensTag(buf, offset, name);
    const asUtf16 = opensTag(buf, fromUtf16(offset), name);
    if (asBytes !== asUtf16) return asBytes ? (o) => o : fromUtf16;
  }
  return (o) => o;
}

/** UTF-16 index → UTF-8 byte offset */
function utf16ByteMap(source) {
  const map = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let i = 0; i < source.length; i++) {
    map[i] = bytes;
    const c = source.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // surrogate pair = 4 bytes, the second half adds nothing
      map[++i] = bytes;
    } else bytes += 3;
  }
  map[source.length] = bytes;
  return map;
}

function position(buf, lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  // Column in characters, as editors show it.
  return { line: lo + 1, col: buf.toString('utf8', lineStarts[lo], offset).length + 1 };
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const key in node) {
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

/** Vite plugin that annotates .astro files before Astro compiles them. */
export function annotatePlugin({ root }) {
  let parse;
  return {
    name: 'webai:astro-annotate',
    apply: 'serve',
    enforce: 'pre',
    transform: {
      order: 'pre',
      async handler(code, id) {
        if (id.includes('?') || !id.endsWith('.astro') || id.includes('/node_modules/')) return;
        if (parse === false) return;
        try {
          parse ??= await loadParser(root);
        } catch (err) {
          parse = false; // Astro without @astrojs/compiler-rs (< 7): overlay works, just without source positions
          this.warn(`webai: annotations disabled, cannot load parser (${err.message})`);
          return;
        }
        const rel = path.relative(root, id).split(path.sep).join('/');
        try {
          const out = await annotate(parse, code, rel);
          return out == null ? undefined : { code: out, map: null };
        } catch {
          return; // Astro reports the parser error during its own compilation
        }
      },
    },
  };
}
