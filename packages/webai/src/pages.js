// What the browser tells the server about its pages (selection, console, failed
// requests) and the way back: read-only commands the server sends to a page.
// Used by the MCP tools (`mcp/tools.js`); the overlay feeds it over `/__webai/page/*`.

const TAB_ID = /^[\w-]{1,64}$/;
const LEVELS = ['debug', 'log', 'info', 'warn', 'error'];
const KINDS = ['console', 'error', 'network'];

export const MAX_TABS = 12;
export const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

/** An error the HTTP API reports with this status (the message is for the caller). */
export function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);

/** Only the known fields of an element description, so a page cannot stuff arbitrary data in. */
export function cleanElement(el) {
  if (!el || typeof el !== 'object') return null;
  return {
    src: str(el.src, 300),
    exact: typeof el.exact === 'boolean' ? el.exact : undefined,
    chain: Array.isArray(el.chain) ? el.chain.slice(0, 4).map((c) => str(c, 300)).filter(Boolean) : undefined,
    tag: str(el.tag, 600),
    testId: str(el.testId, 200),
    selector: str(el.selector, 600),
    text: str(el.text, 300),
    html: str(el.html, 3000),
  };
}

export class PageHub {
  /**
   * @param {object} [o]
   * @param {number} [o.maxLog] log entries kept per tab
   * @param {number} [o.timeoutMs] how long a command waits for the page
   * @param {(origin: string) => void} [o.onOrigin] called when the pages' origin becomes known or changes
   */
  constructor({ maxLog = 500, timeoutMs = 8000, onOrigin } = {}) {
    this.maxLog = maxLog;
    this.timeoutMs = timeoutMs;
    this.onOrigin = onOrigin;
    this.origin = null;
    this.tabs = new Map();
    this.pending = new Map();
    this.touches = 0;
    this.commands = 0;
  }

  static validId(id) {
    return typeof id === 'string' && TAB_ID.test(id);
  }

  /** The tab, created on first sight. */
  tab(id) {
    if (!PageHub.validId(id)) throw failure('tab is an id of 1 to 64 letters, digits, _ or -.');
    let t = this.tabs.get(id);
    if (!t) {
      t = { id, logs: [], selection: null, send: null, touched: 0, seen: Date.now(), nav: 0 };
      this.tabs.set(id, t);
      this.prune(id);
    }
    return t;
  }

  /** The most recently used tabs only; one that is connected, or the one just created (`keep`), is never dropped. */
  prune(keep) {
    while (this.tabs.size > MAX_TABS) {
      const old = [...this.tabs.values()].filter((t) => !t.send && t.id !== keep).sort((a, b) => a.touched - b.touched)[0];
      if (!old) return;
      this.tabs.delete(old.id);
    }
  }

  touch(t) {
    t.touched = ++this.touches;
    t.seen = Date.now();
  }

  /** A page has loaded (or navigated). `visible`: it is the one the person is looking at. */
  hello(body) {
    const t = this.tab(body.tab);
    t.url = str(body.url, 1000);
    t.title = str(body.title, 300);
    t.nav = num(body.nav) ?? t.nav;
    const v = body.viewport;
    t.viewport = v && typeof v === 'object' ? { width: num(v.width), height: num(v.height) } : undefined;
    if (body.visible) this.touch(t);
    const origin = str(body.origin, 300);
    if (origin && origin !== this.origin) {
      this.origin = origin;
      this.onOrigin?.(origin);
    }
  }

  focus(id) {
    this.touch(this.tab(id));
  }

  selection(id, element, page) {
    const t = this.tab(id);
    t.selection = cleanElement(element);
    if (t.selection) {
      t.selectedAt = Date.now();
      t.selectionPage = page && typeof page === 'object' ? { url: str(page.url, 1000), title: str(page.title, 300) } : undefined;
      this.touch(t);
    }
  }

  /** Log entries from the page; anything malformed is dropped. */
  log(id, entries) {
    const t = this.tab(id);
    if (!Array.isArray(entries)) throw failure('entries is a list.');
    const at = Date.now();
    for (const e of entries.slice(0, 200)) {
      if (!e || typeof e.text !== 'string') continue;
      t.logs.push({
        at,
        level: LEVELS.includes(e.level) ? e.level : 'log',
        kind: KINDS.includes(e.kind) ? e.kind : 'console',
        text: e.text.slice(0, 4000),
        stack: str(e.stack, 4000),
        nav: num(e.nav) ?? t.nav,
      });
    }
    if (t.logs.length > this.maxLog) t.logs.splice(0, t.logs.length - this.maxLog);
  }

  /** The page's command channel (an open event stream). Returns the function that closes it. */
  attach(id, send) {
    const t = this.tab(id);
    t.send = send;
    t.seen = Date.now();
    return () => {
      if (t.send === send) t.send = null;
    };
  }

  /** The tab asked for, or the one the person used last. */
  resolve(id) {
    if (id != null) {
      const t = this.tabs.get(id);
      if (!t) throw failure(`No tab ${id}. Ask webai_page_info for the open ones.`, 404);
      return t;
    }
    const best = [...this.tabs.values()].sort((a, b) => Number(!!b.send) - Number(!!a.send) || b.touched - a.touched)[0];
    if (!best) throw failure('No page with the WebAI overlay has reported in. Open the site in a browser (the dev server with webai must be running).', 404);
    return best;
  }

  list() {
    const active = this.tabs.size ? this.resolve().id : null;
    return [...this.tabs.values()].map((t) => ({
      tab: t.id,
      active: t.id === active,
      connected: !!t.send,
      url: t.url,
      title: t.title,
      viewport: t.viewport,
      selected: t.selection ? (t.selection.src ?? t.selection.selector) : null,
      logEntries: t.logs.length,
      lastSeenSecondsAgo: Math.round((Date.now() - t.seen) / 1000),
    }));
  }

  /** Runs a read-only command in the page; resolves to what the page answers. */
  command(id, cmd, args = {}) {
    const t = this.resolve(id);
    if (!t.send) return Promise.reject(failure(`Tab ${t.id} is not connected right now (page closed or reloading). Try again in a moment.`, 409));
    const key = String(++this.commands);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(failure(`The page did not answer in ${this.timeoutMs / 1000} s (tab frozen, or in the background).`, 504));
      }, this.timeoutMs);
      this.pending.set(key, { tab: t.id, resolve, reject, timer });
      t.send({ id: key, cmd, args });
    });
  }

  /** The page's answer to a command; false when nobody is waiting (late, or from another tab). */
  result(id, { id: key, ok, data, error }) {
    const p = this.pending.get(String(key));
    if (!p || p.tab !== id) return false;
    this.pending.delete(String(key));
    clearTimeout(p.timer);
    if (ok) p.resolve(data);
    else p.reject(failure(str(error, 1000) ?? 'The page reported an error.', 422));
    return true;
  }

  dispose() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(failure('The server is shutting down.', 503));
    }
    this.pending.clear();
  }
}
