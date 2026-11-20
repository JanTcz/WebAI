// The MCP tools. Read-only: they show what is in the browser (selection, console,
// DOM) and the file versions; nothing here changes the page or the sources.
// `run(session, args)` returns data for JSON; a thrown error with `status` is a reported failure.

import { failure, LEVEL_RANK } from '../pages.js';

const tab = { type: 'string', description: 'Tab id from webai_page_info. Default: the page the person used last.' };

const text = (v, name, { max = 600, required = false } = {}) => {
  if (v == null && !required) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw failure(`${name} is a non-empty string of at most ${max} characters.`);
  return v;
};

const int = (v, name, def, min, max) => {
  if (v == null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw failure(`${name} is an integer from ${min} to ${max}.`);
  return v;
};

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
};

export const TOOLS = [
  {
    name: 'webai_get_selection',
    description:
      'The element the person picked in the browser overlay (Shift+click): source location (file:line:col when the framework provides it), '
      + 'CSS selector, text, HTML excerpt, enclosing components. Call this first when they say "this element", "here" or "this button".',
    inputSchema: { type: 'object', properties: { tab }, additionalProperties: false },
    run(session, { tab: id } = {}) {
      const t = session.pages.resolve(text(id, 'tab', { max: 64 }));
      if (!t.selection) {
        return { tab: t.id, element: null, hint: 'Nothing is selected in this tab. Ask the person to Shift+click an element on the page (webai_page_info lists the other tabs).' };
      }
      return { tab: t.id, page: t.selectionPage, selectedAgo: ago(Date.now() - t.selectedAt), element: t.selection };
    },
  },
  {
    name: 'webai_console',
    description:
      'The browser console of a page: console.* output, uncaught errors, unhandled promise rejections and failed requests (kind "network"), '
      + 'oldest first. Only what happened after the overlay loaded; the buffer holds the last 500 entries per tab and survives reloads (see `nav`).',
    inputSchema: {
      type: 'object',
      properties: {
        tab,
        level: { enum: ['debug', 'log', 'info', 'warn', 'error'], description: 'Minimum level, default "log" (everything but debug).' },
        kind: { enum: ['console', 'error', 'network'], description: 'Only console.* calls, only uncaught errors, or only failed requests.' },
        since_seconds: { type: 'integer', minimum: 1, maximum: 86400, description: 'Only entries from the last N seconds.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most recent N entries, default 100.' },
      },
      additionalProperties: false,
    },
    run(session, args = {}) {
      const t = session.pages.resolve(text(args.tab, 'tab', { max: 64 }));
      const level = args.level ?? 'log';
      if (!(level in LEVEL_RANK)) throw failure('level is debug, log, info, warn or error.');
      if (args.kind != null && !['console', 'error', 'network'].includes(args.kind)) throw failure('kind is console, error or network.');
      const since = int(args.since_seconds, 'since_seconds', null, 1, 86400);
      const limit = int(args.limit, 'limit', 100, 1, 500);
      const now = Date.now();
      const all = t.logs.filter((e) => LEVEL_RANK[e.level] >= LEVEL_RANK[level]
        && (args.kind == null || e.kind === args.kind)
        && (since == null || now - e.at <= since * 1000));
      const entries = all.slice(-limit).map(({ at, level: l, kind, text: msg, stack, nav }) => ({ age: ago(now - at), level: l, kind, nav, text: msg, stack }));
      return { tab: t.id, url: t.url, nav: t.nav, matching: all.length, shown: entries.length, entries };
    },
  },
  {
    name: 'webai_query_dom',
    description:
      'Looks at elements in the live page by CSS selector: count, and for the first few their source location, selector, text, HTML excerpt, '
      + 'bounding box, visibility and computed styles. Use it to check how something actually renders (sizes, colours, overflow).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, e.g. "nav a" or "[data-testid=cta]".' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many matches to describe, default 3.' },
        styles: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Computed style properties, e.g. ["color", "font-size", "display"]. A common set by default.' },
        tab,
      },
      required: ['selector'],
      additionalProperties: false,
    },
    run(session, args = {}) {
      const selector = text(args.selector, 'selector', { required: true });
      const limit = int(args.limit, 'limit', 3, 1, 10);
      let styles = args.styles;
      if (styles != null) {
        if (!Array.isArray(styles) || styles.length > 20 || !styles.every((s) => typeof s === 'string' && /^[a-z-]{1,40}$/i.test(s))) {
          throw failure('styles is a list of at most 20 CSS property names, e.g. ["color", "font-size"].');
        }
      }
      return session.pages.command(text(args.tab, 'tab', { max: 64 }), 'query', { selector, limit, styles });
    },
  },
  {
    name: 'webai_page_info',
    description:
      'The browser tabs that have the WebAI overlay (which one the person used last, their URLs, whether a selection exists), '
      + 'plus live details of the active one: current URL and title, viewport, scroll position, document size.',
    inputSchema: { type: 'object', properties: { tab }, additionalProperties: false },
    async run(session, { tab: id } = {}) {
      const t = session.pages.resolve(text(id, 'tab', { max: 64 }));
      const live = t.send ? await session.pages.command(t.id, 'info').catch((err) => ({ unavailable: err.message })) : null;
      return { tabs: session.pages.list(), selectedTab: t.id, live };
    },
  },
  {
    name: 'webai_history',
    description: 'The versions of the project files that WebAI keeps (one per agent turn, plus the person\'s own edits). Read-only: restoring is done in the panel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (session) => session.history.list(),
  },
];

/** Runs a tool by name; `args` come from the caller and are validated by the tool. */
export async function callTool(session, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw failure(`Unknown tool ${name}.`, 404);
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw failure('arguments is an object.');
  return tool.run(session, args ?? {});
}
