// HTML helpers shared by the CLI, the framework plugins and the browser demo:
// no Node dependencies.

export const SRC_ATTR = 'data-webai-src';

const SKIP = new Set(['html', 'head', 'meta', 'link', 'title', 'base', 'script', 'style', 'noscript', 'template', 'br']);

/**
 * Adds `data-webai-src="file:line:column"` to every element of a static HTML
 * file, as the Astro plugin does for templates. Attributes are inserted without
 * new lines, so line numbers match the source.
 */
export function annotateHtml(html, file = 'index.html') {
  let out = '';
  let last = 0;
  let line = 1;
  let lineStart = 0;
  const count = (from, to) => {
    for (let i = from; i < to; i++) {
      if (html[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
  };
  const re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<([a-zA-Z][\w-]*)/g;
  for (let m; (m = re.exec(html)); ) {
    count(last, m.index);
    const tag = m[2]?.toLowerCase();
    const end = m.index + m[0].length;
    out += html.slice(last, end);
    if (tag && !SKIP.has(tag)) out += ` ${SRC_ATTR}="${file}:${line}:${m.index - lineStart + 1}"`;
    count(m.index, end);
    last = end;
  }
  return out + html.slice(last);
}

/** `snippet` before the last `</body>`, or at the end when there is none. */
export function injectHtml(html, snippet) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}
