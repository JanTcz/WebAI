// Client side: element inspector and chat panel. Runs only in development.
// Everything lives in the shadow DOM of <webai-overlay>, so site styles don't leak in.
//
// Talks to the agent through a transport: the default is HTTP + SSE to the dev server
// (`/__webai/*`); the web demo (`demo/`) injects its own that runs
// entirely in the browser.

const STORE_OPEN = 'webai:open';
const STORE_TARGET = 'webai:target';
const STORE_DRAFT = 'webai:draft';
const STORE_SIDE = 'webai:side';
const STORE_GEOMETRY = 'webai:geometry';
const MIN_W = 300;
const MIN_H = 320;
const STORE_TRIGGERS = 'webai:triggers';

const TRIGGERS = [
  ['shift-click', 'Shift + click'],
  ['alt-click', 'Alt + click'],
  ['contextmenu', 'Right click (Shift + right click = native menu)'],
];

const TOOL_ICONS = { Edit: '✎', MultiEdit: '✎', Write: '✚', Read: '◉', Bash: '$', Grep: '⌕', Glob: '⌕' };

export function start(cfg) {
  if (window.__webai) return;
  window.__webai = true;
  const run = () => new Overlay(cfg);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}

/**
 * Transport to the dev server. Interface:
 * - `request(method, path, body)` → data; failures throw an Error with a readable message
 * - `subscribe({ onEvent, onReady, onLost })` → unsubscribe function; first
 *   replays the whole history, then `onReady({ busy })`, then live events
 */
export function httpTransport(cfg) {
  return {
    async request(method, path, body) {
      let res;
      try {
        res = await fetch(cfg.base + path, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-WebAI-Token': cfg.token },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new Error('The dev server is not responding. Is it running? Reload the page after a restart.');
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) throw new Error('The dev server has restarted in the meantime, reload the page.');
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },

    subscribe({ onEvent, onReady, onLost }) {
      const es = new EventSource(`${cfg.base}/events?token=${cfg.token}`);
      es.onmessage = (m) => onEvent(JSON.parse(m.data));
      es.addEventListener('ready', (m) => onReady(JSON.parse(m.data)));
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) onLost('Lost connection to the dev server. Reload the page.');
      };
      return () => es.close();
    },
  };
}

class Overlay {
  constructor(cfg) {
    this.cfg = cfg;
    this.transport = cfg.transport ?? httpTransport(cfg);
    this.target = null;
    this.busy = false;
    this.live = null;
    this.unsubscribe = null;
    this.mount();
    this.bindInspector();
    // A reload after an edit must not eat what is being typed.
    this.el.input.value = sessionStorage.getItem(STORE_DRAFT) ?? '';
    this.el.input.addEventListener('input', () => {
      if (this.el.input.value) sessionStorage.setItem(STORE_DRAFT, this.el.input.value);
      else sessionStorage.removeItem(STORE_DRAFT);
    });
    if (sessionStorage.getItem(STORE_OPEN) === '1') {
      const saved = readJson(sessionStorage.getItem(STORE_TARGET));
      if (saved) this.setTarget(saved, findElement(saved, cfg.srcAttr));
      this.open();
    }
  }

  // ---------- DOM ----------

  mount() {
    this.host = document.createElement('webai-overlay');
    const root = this.host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLES}</style>
      <div class="hover" hidden><span class="label"></span></div>
      <div class="pick" hidden></div>
      <button class="fab" hidden title="WebAI – open chat (or Shift+click an element)">✦</button>
      <section class="panel" hidden>
        <header>
          <strong>WebAI</strong><span class="agent"></span>
          <span class="spacer"></span>
          <span class="versions" hidden><button class="back" title="Previous version">◀</button><span class="vnum"></span><button class="fwd" title="Next version">▶</button></span>
          <button class="gear" title="Settings" aria-label="Settings">${GEAR_ICON}</button>
          <button class="reset" title="Start a new conversation">New</button>
          <button class="close" title="Close (Esc)">×</button>
        </header>
        <div class="settings" hidden></div>
        <div class="log"></div>
        <div class="target" hidden><code></code><button title="Don't send the element">×</button></div>
        <form>
          <textarea rows="2" placeholder="What should happen to the element? Enter sends, Shift+Enter adds a new line"></textarea>
          <button type="submit" class="send">Send</button>
        </form>
        <footer class="hint"></footer>
        <div class="grip nw" data-grip="-1,-1"></div><div class="grip ne" data-grip="1,-1"></div>
        <div class="grip sw" data-grip="-1,1"></div><div class="grip se" data-grip="1,1"></div>
      </section>`;
    const $ = (s) => root.querySelector(s);
    this.el = {
      hover: $('.hover'), label: $('.hover .label'), pick: $('.pick'), panel: $('.panel'),
      agent: $('.agent'), log: $('.log'), target: $('.target'), targetCode: $('.target code'),
      form: $('form'), input: $('textarea'), send: $('.send'), fab: $('.fab'), settings: $('.settings'),
      gear: $('.gear'), hint: $('.hint'),
      versions: $('.versions'), vnum: $('.vnum'), back: $('.back'), fwd: $('.fwd'),
    };
    this.el.back.onclick = () => this.restoreVersion(this.history.current - 1);
    this.el.fwd.onclick = () => this.restoreVersion(this.history.current + 1);
    $('.close').onclick = () => this.close();
    $('.reset').onclick = () => this.reset();
    this.el.gear.onclick = () => this.toggleSettings();
    this.el.fab.onclick = () => {
      this.open();
      this.el.input.focus();
    };
    this.el.fab.hidden = !this.cfg.fab;
    $('.target button').onclick = () => this.setTarget(null);
    this.el.form.onsubmit = (e) => {
      e.preventDefault();
      this.busy ? this.stop() : this.send();
    };
    this.el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy) this.send();
      }
    });
    this.applySide();
    this.initGeometry(root);
    this.updateHint();
    document.documentElement.appendChild(this.host);
    const follow = () => this.drawPick();
    addEventListener('scroll', follow, { passive: true, capture: true });
    addEventListener('resize', follow, { passive: true });
  }

  // ---------- inspector ----------

  // Read on every mouse move, so cached in memory rather than read from localStorage.
  get triggers() {
    this._triggers ??= readJson(localStorage.getItem(STORE_TRIGGERS)) ?? this.cfg.triggers;
    return this._triggers;
  }

  bindInspector() {
    const ours = (e) => e.composedPath().includes(this.host);
    const armed = (e) => {
      const triggers = this.triggers;
      return (triggers.includes('shift-click') && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
        (triggers.includes('alt-click') && e.altKey && !e.metaKey && !e.ctrlKey);
    };

    addEventListener('mousemove', (e) => {
      if (!armed(e) || ours(e)) return this.hideHover();
      this.showHover(e.target);
    }, { passive: true, capture: true });
    addEventListener('keyup', (e) => (e.key === 'Shift' || e.key === 'Alt') && this.hideHover(), true);
    addEventListener('blur', () => this.hideHover());

    // Otherwise Shift+mousedown would start selecting text.
    addEventListener('mousedown', (e) => {
      if (e.button === 0 && armed(e) && !ours(e)) e.preventDefault();
    }, true);
    addEventListener('click', (e) => {
      if (e.button !== 0 || !armed(e) || ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.pick(e.target);
    }, true);
    // Shift+right click keeps the native menu (Inspect element).
    addEventListener('contextmenu', (e) => {
      if (!this.triggers.includes('contextmenu') || e.shiftKey || ours(e)) return;
      e.preventDefault();
      this.pick(e.target);
    }, true);
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.panel.hidden) this.close();
    });
  }

  showHover(node) {
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(this.el.hover.style, box(r));
    const src = el.closest(`[${this.cfg.srcAttr}]`)?.getAttribute(this.cfg.srcAttr);
    this.el.label.textContent = `${el.tagName.toLowerCase()}${src ? `  ${src}` : ''}`;
    this.el.label.classList.toggle('below', r.top < 24);
    this.el.hover.hidden = false;
  }

  hideHover() {
    this.el.hover.hidden = true;
  }

  pick(node) {
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return;
    this.hideHover();
    getSelection()?.removeAllRanges(); // Shift+click extends the text selection
    this.setTarget(describe(el, this.cfg.srcAttr), el);
    this.open();
    this.el.input.focus();
  }

  setTarget(info, el = null) {
    this.target = info;
    this.targetEl = el;
    if (info) sessionStorage.setItem(STORE_TARGET, JSON.stringify(info));
    else sessionStorage.removeItem(STORE_TARGET);
    this.el.target.hidden = !info;
    if (info) this.el.targetCode.textContent = `<${info.tag.match(/^<?([\w-]+)/)?.[1] ?? '?'}>  ${info.src ?? info.selector}`;
    this.drawPick();
  }

  drawPick() {
    const el = this.targetEl;
    if (!el || !el.isConnected || this.el.panel.hidden) {
      this.el.pick.hidden = true;
      return;
    }
    Object.assign(this.el.pick.style, box(el.getBoundingClientRect()));
    this.el.pick.hidden = false;
  }

  // ---------- panel ----------

  open() {
    sessionStorage.setItem(STORE_OPEN, '1');
    this.el.panel.hidden = false;
    this.el.fab.hidden = true;
    this.drawPick();
    if (!this.unsubscribe) this.connect();
  }

  close() {
    sessionStorage.removeItem(STORE_OPEN);
    this.el.panel.hidden = true;
    this.el.pick.hidden = true;
    this.el.fab.hidden = !this.cfg.fab;
    this.showSettings(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  applySide() {
    const left = localStorage.getItem(STORE_SIDE) === 'left';
    this.el.panel.classList.toggle('left', left);
    this.el.fab.classList.toggle('left', left);
  }

  // ---------- moving and resizing ----------

  // The header moves the panel, the corners resize it; both remember the result.
  // A double click on the header docks it back to its side at its default size.
  initGeometry(root) {
    const header = root.querySelector('header');
    header.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !e.target.closest('button')) this.gesture(e, null);
    });
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      localStorage.removeItem(STORE_GEOMETRY);
      this.applyGeometry();
    });
    for (const grip of root.querySelectorAll('[data-grip]')) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button === 0) this.gesture(e, grip.dataset.grip.split(',').map(Number));
      });
    }
    addEventListener('resize', () => this.applyGeometry(), { passive: true });
    this.applyGeometry();
  }

  /** Move (`dir` null) or resize from a corner (`dir` = [±1, ±1]) while the pointer is down. */
  gesture(e, dir) {
    e.preventDefault();
    const panel = this.el.panel;
    const start = panel.getBoundingClientRect();
    const [x0, y0] = [e.clientX, e.clientY];
    let started = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      // A click (or the first half of a double click) moves nothing.
      if (!started) {
        if (Math.hypot(dx, dy) < 4) return;
        started = true;
        panel.setPointerCapture(ev.pointerId);
        panel.classList.add('dragging');
      }
      let { left: x, top: y, width: w, height: h } = start;
      if (!dir) {
        x += dx;
        y += dy;
      } else {
        const [sx, sy] = dir;
        const nw = Math.max(MIN_W, w + sx * dx);
        const nh = Math.max(MIN_H, h + sy * dy);
        if (sx < 0) x += w - nw;
        if (sy < 0) y += h - nh;
        [w, h] = [nw, nh];
      }
      this.applyGeometry({ x, y, w, h });
    };
    const end = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (!started) return;
      panel.releasePointerCapture(ev.pointerId);
      panel.classList.remove('dragging');
      const r = panel.getBoundingClientRect();
      localStorage.setItem(STORE_GEOMETRY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  /** The remembered (or given) position and size, kept inside the window; none = docked to its side. */
  applyGeometry(g = JSON.parse(localStorage.getItem(STORE_GEOMETRY) ?? 'null')) {
    const style = this.el.panel.style;
    if (!g) {
      for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) style[k] = '';
      return;
    }
    const w = Math.min(Math.max(MIN_W, g.w), innerWidth - 16);
    const h = Math.min(Math.max(MIN_H, g.h), innerHeight - 16);
    const x = Math.min(Math.max(8, g.x), innerWidth - w - 8);
    const y = Math.min(Math.max(8, g.y), innerHeight - h - 8);
    Object.assign(style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, right: 'auto', bottom: 'auto' });
  }

  // ---------- settings ----------

  toggleSettings() {
    this.showSettings(this.el.settings.hidden);
  }

  async showSettings(show) {
    this.el.settings.hidden = !show;
    this.el.log.hidden = show;
    this.el.form.hidden = show;
    this.el.gear.classList.toggle('active', show);
    this.el.target.hidden = show || !this.target;
    if (show) await this.renderSettings();
  }

  async renderSettings() {
    const box = this.el.settings;
    let state;
    try {
      state = await this.api('GET', '/state');
    } catch (err) {
      box.textContent = err.message;
      return;
    }
    this.el.agent.textContent = state.agent;
    const current = state.agents.find((a) => a.name === state.settings.agent);
    const mine = state.settings[current.name] ?? {};
    // Choices with a `group` go into <optgroup>s, in the order the groups first appear.
    const options = (choices, value) => {
      const option = (c) => `<option value="${escapeHtml(c.value)}"${c.value === value ? ' selected' : ''}${c.disabled ? ' disabled' : ''}>${escapeHtml(c.label)}</option>`;
      return [...new Set(choices.map((c) => c.group ?? ''))]
        .map((g) => {
          const inner = choices.filter((c) => (c.group ?? '') === g).map(option).join('');
          return g ? `<optgroup label="${escapeHtml(g)}">${inner}</optgroup>` : inner;
        })
        .join('');
    };
    const select = (key, label, choices, value, hint = '') => `
      <label>${escapeHtml(label)}<select data-key="${escapeHtml(key)}">${options(choices, value)}</select>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`;
    const triggers = this.triggers;
    box.innerHTML = `
      <h3>Agent</h3>
      ${state.agents.length < 2 ? '' : select('agent', 'CLI', state.agents.map((a) => ({
        value: a.name,
        label: a.version ? `${a.label} (${a.version})` : `${a.label}: not installed`,
        disabled: !a.version,
      })), current.name, 'Each agent has its own conversation. Switching back to an agent resumes its context.')}
      ${Object.entries(current.settings).map(([key, spec]) => Array.isArray(spec)
        ? select(key, SETTING_LABELS[key] ?? key, spec, mine[key] ?? '', SETTING_HINTS[key])
        : spec.type === 'action'
        ? `<div class="action"><button type="button" data-action="${escapeHtml(spec.action)}">${escapeHtml(spec.label)}</button>${spec.hint ? `<small>${escapeHtml(spec.hint)}</small>` : ''}</div>`
        : `<label>${escapeHtml(spec.label ?? key)}<input type="${spec.secret ? 'password' : 'text'}" data-text="${escapeHtml(key)}" value="${escapeHtml((!spec.readonly && mine[key]) || spec.default || '')}" placeholder="${escapeHtml(spec.placeholder ?? '')}" spellcheck="false"${spec.readonly ? ' disabled' : ''}>${spec.hint ? `<small>${escapeHtml(spec.hint)}</small>` : ''}</label>`).join('')}
      <h3>Element picking</h3>
      ${TRIGGERS.map(([value, label]) => `<label class="check"><input type="checkbox" data-trigger="${value}"${triggers.includes(value) ? ' checked' : ''}> ${label}</label>`).join('')}
      <h3>Panel</h3>
      ${select('side', 'Position', [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], localStorage.getItem(STORE_SIDE) ?? 'right')}
      <h3>Conversation</h3>
      <p class="meta">${escapeHtml(current.label)} · ${state.session.started ? `session <code>${escapeHtml(String(state.session.id).slice(0, 8))}</code>` : 'not started yet'}${state.session.totalCostUsd ? ` · total $${state.session.totalCostUsd.toFixed(3)}` : ''}</p>`;

    for (const el of box.querySelectorAll('select[data-key]')) {
      el.onchange = () => this.changeSetting(el.dataset.key, el.value, current.name);
    }
    for (const el of box.querySelectorAll('input[data-text]')) {
      // Saved on blur or Enter, not on every keystroke.
      el.onchange = () => this.changeSetting(el.dataset.text, el.value, current.name);
      el.onkeydown = (e) => e.key === 'Enter' && el.blur();
    }
    // Buttons the agent offers (e.g. signing in to a provider in the browser editor).
    for (const el of box.querySelectorAll('button[data-action]')) {
      el.onclick = async () => {
        try {
          await this.api('POST', '/action', { agent: current.name, action: el.dataset.action });
        } catch (err) {
          return this.flashSettingsError(err.message);
        }
        await this.renderSettings();
      };
    }
    for (const el of box.querySelectorAll('input[data-trigger]')) {
      el.onchange = () => {
        const picked = [...box.querySelectorAll('input[data-trigger]:checked')].map((i) => i.dataset.trigger);
        localStorage.setItem(STORE_TRIGGERS, JSON.stringify(picked));
        this._triggers = picked;
        this.updateHint();
      };
    }
  }

  async changeSetting(key, value, agentName) {
    if (key === 'side') {
      localStorage.setItem(STORE_SIDE, value);
      localStorage.removeItem(STORE_GEOMETRY); // choosing a side docks the panel there
      this.applySide();
      this.applyGeometry();
      return;
    }
    try {
      await this.api('POST', '/settings', key === 'agent' ? { agent: value } : { [agentName]: { [key]: value } });
    } catch (err) {
      this.flashSettingsError(err.message);
    }
    await this.renderSettings();
  }

  flashSettingsError(text) {
    const p = document.createElement('p');
    p.className = 'msg error';
    p.textContent = text;
    this.el.settings.prepend(p);
  }

  updateHint() {
    const labels = TRIGGERS.filter(([v]) => this.triggers.includes(v)).map(([, l]) => l.split(' (')[0]);
    this.el.hint.textContent = labels.length ? `${labels.join(' / ')} selects an element on the page` : 'Element picking is off (⚙)';
  }

  connect() {
    this.el.log.textContent = '';
    this.live = null;
    this.unsubscribe = this.transport.subscribe({
      onEvent: (ev) => this.handle(ev),
      onReady: ({ busy }) => {
        this.caughtUp = true; // events from here on are new, not the replayed history
        this.setBusy(busy);
        this.scroll(true);
      },
      onLost: (text) => {
        this.line('error', text);
        this.unsubscribe = null;
      },
    });
    this.api('GET', '/state').then((s) => (this.el.agent.textContent = s.agent)).catch(() => {});
    this.loadHistory();
  }

  // ---------- versions ----------

  loadHistory() {
    this.api('GET', '/history').then((h) => this.showHistory(h)).catch(() => {});
  }

  showHistory(h) {
    this.history = h;
    const { versions, current } = h;
    this.el.versions.hidden = !h.enabled || versions.length < 2;
    this.el.vnum.textContent = `v${current + 1}/${versions.length}`;
    const v = versions[current];
    this.el.vnum.title = v ? `${v.label} · ${new Date(v.ts).toLocaleString()}` : '';
    this.el.back.disabled = this.busy || current <= 0;
    this.el.fwd.disabled = this.busy || current >= versions.length - 1;
    const tip = (i) => (versions[i] ? `: ${versions[i].label}` : '');
    this.el.back.title = `Previous version${tip(current - 1)}`;
    this.el.fwd.title = `Next version${tip(current + 1)}`;
  }

  async restoreVersion(index) {
    try {
      this.showHistory(await this.api('POST', '/history/restore', { index }));
    } catch (err) {
      this.line('error', err.message);
    }
  }

  api(method, path, body) {
    return this.transport.request(method, path, body);
  }

  async send() {
    const message = this.el.input.value.trim();
    if (!message) return;
    // After an edit and reload the element may have moved or disappeared: describe it again.
    if (this.target && this.targetEl?.isConnected) this.target = describe(this.targetEl, this.cfg.srcAttr);
    this.setBusy(true);
    try {
      await this.api('POST', '/send', {
        message,
        element: this.target,
        page: { url: location.pathname + location.search, title: document.title },
      });
      this.el.input.value = '';
      sessionStorage.removeItem(STORE_DRAFT);
    } catch (err) {
      this.setBusy(false);
      this.line('error', err.message);
    }
  }

  stop() {
    this.api('POST', '/stop').catch((err) => this.line('error', err.message));
  }

  reset() {
    if (this.el.log.childElementCount && !confirmReset()) {
      this.line('status', 'Click "New" again to discard the context and start a new conversation.');
      this.scroll(true);
      return;
    }
    this.api('POST', '/reset').catch((err) => this.line('error', err.message));
  }

  setBusy(busy) {
    this.busy = busy;
    this.el.send.textContent = busy ? 'Stop' : 'Send';
    this.el.send.classList.toggle('stop', busy);
    this.el.panel.classList.toggle('busy', busy);
    this.el.fab.classList.toggle('busy', busy);
    if (this.history) this.showHistory(this.history);
  }

  // ---------- agent events ----------

  handle(ev) {
    const stick = this.atBottom();
    switch (ev.type) {
      case 'reset':
        this.el.log.textContent = '';
        this.live = null;
        this.setBusy(false);
        break;
      case 'user': {
        const div = this.line('user', '');
        div.textContent = ev.text;
        const where = ev.element?.src ?? ev.element?.selector;
        const how = [ev.agent, ev.settings?.model, ev.settings?.effort].filter(Boolean).join(' · ');
        if (where || how) {
          const chip = document.createElement('code');
          chip.textContent = [where, how].filter(Boolean).join('  ·  ');
          div.prepend(chip);
        }
        this.live = null;
        break;
      }
      case 'status':
        if (ev.busy) this.setBusy(true);
        else this.line('status', ev.text);
        break;
      case 'delta':
        this.live ??= this.line('assistant live', '');
        this.live.dataset.raw = (this.live.dataset.raw ?? '') + ev.text;
        this.live.innerHTML = render(this.live.dataset.raw, ev.plain);
        break;
      case 'text':
        if (this.live) {
          this.live.classList.remove('live');
          this.live.innerHTML = render(ev.text, ev.plain);
          this.live = null;
        } else {
          this.line('assistant', '').innerHTML = render(ev.text, ev.plain);
        }
        break;
      case 'tool':
        this.live = null;
        this.line('tool', `${TOOL_ICONS[ev.name] ?? '•'} ${ev.name} ${ev.summary ?? ''}`);
        break;
      case 'tool-error':
        this.line('tool error', ev.text);
        break;
      case 'permission': {
        const div = this.line('permission', '');
        div.dataset.id = ev.id;
        const ask = document.createElement('span');
        ask.textContent = `${ev.name} ${ev.summary ?? ''}`.trim();
        const allow = document.createElement('button');
        allow.textContent = 'Allow';
        const deny = document.createElement('button');
        deny.textContent = 'Deny';
        deny.className = 'deny';
        for (const [button, ok] of [[allow, true], [deny, false]]) {
          button.onclick = () => {
            allow.disabled = deny.disabled = true;
            this.api('POST', '/permission', { id: ev.id, allow: ok }).catch((err) => {
              allow.disabled = deny.disabled = false;
              this.line('error', err.message);
            });
          };
        }
        const label = document.createElement('b');
        label.textContent = 'Allow this? ';
        div.append(label, ask, allow, deny);
        break;
      }
      case 'permission-answer': {
        const div = [...this.el.log.querySelectorAll('.msg.permission')].find((d) => d.dataset.id === ev.id);
        if (!div) break;
        div.querySelector('b').textContent = ev.cancelled ? 'Not answered: ' : ev.allow ? 'Allowed: ' : 'Denied: ';
        div.classList.add(ev.allow ? 'allowed' : 'answered');
        div.querySelectorAll('button').forEach((b) => b.remove());
        break;
      }
      case 'denied':
        this.line('denied', `Denied: ${ev.name} ${ev.summary ?? ''}. Allow it in options.claude.allowedTools.`);
        break;
      case 'history':
        // Without hot reload (CLI, Next.js wrapper) the page shows the new files after a reload.
        // A moment first: a dev server behind the proxy may not have noticed the change yet.
        if (this.cfg.reload && ev.reload && this.caughtUp) setTimeout(() => location.reload(), 400);
        else this.loadHistory();
        break;
      case 'done': {
        this.live = null;
        this.setBusy(false);
        if (!ev.ok) this.line('error', ev.error ?? 'The agent finished with an error.');
        const meta = [ev.durationMs && `${Math.round(ev.durationMs / 1000)} s`, ev.costUsd != null && `$${ev.costUsd.toFixed(3)}`]
          .filter(Boolean).join(' · ');
        if (ev.ok) this.line('meta', meta ? `done · ${meta}` : 'done');
        break;
      }
    }
    this.scroll(stick);
  }

  line(kind, text) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    div.textContent = text;
    this.el.log.appendChild(div);
    return div;
  }

  atBottom() {
    const l = this.el.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  }

  scroll(stick) {
    if (stick) this.el.log.scrollTop = this.el.log.scrollHeight;
  }
}

// ---------- element description for the agent ----------

function describe(el, srcAttr) {
  const annotated = el.closest(`[${srcAttr}]`);
  const src = annotated?.getAttribute(srcAttr);

  // Where the component is used: nearest ancestors from other files.
  const chain = [];
  let file = src?.split(':')[0];
  for (let p = annotated?.parentElement?.closest(`[${srcAttr}]`); p && chain.length < 4; p = p.parentElement?.closest(`[${srcAttr}]`)) {
    const s = p.getAttribute(srcAttr);
    const f = s.split(':')[0];
    if (f !== file) {
      chain.push(s);
      file = f;
    }
  }

  const testEl = el.closest('[data-testid],[data-test-id],[data-test]');
  return {
    src,
    exact: annotated === el,
    chain,
    tag: openTag(el),
    testId: testEl?.getAttribute('data-testid') ?? testEl?.getAttribute('data-test-id') ?? testEl?.getAttribute('data-test') ?? undefined,
    selector: selectorOf(el),
    text: (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined,
    html: cleanHtml(el.outerHTML, srcAttr).slice(0, 1500),
  };
}

function findElement(info, srcAttr) {
  if (info.src) {
    const els = document.querySelectorAll(`[${srcAttr}="${CSS.escape(info.src)}"]`);
    if (els.length === 1) return els[0];
  }
  try {
    return document.querySelector(info.selector);
  } catch {
    return null;
  }
}

function openTag(el) {
  const attrs = [...el.attributes]
    .filter((a) => !noise(a.name))
    .map((a) => (a.value ? `${a.name}="${a.value.slice(0, 80)}"` : a.name));
  return `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
}

function noise(name) {
  return name.startsWith('data-webai-') || name.startsWith('data-astro-cid') || name === 'data-astro-source-file' || name === 'data-astro-source-loc';
}

function cleanHtml(html, srcAttr) {
  return html
    .replace(new RegExp(`\\s${srcAttr}="[^"]*"`, 'g'), '')
    .replace(/\sdata-astro-cid-[\w-]+(="[^"]*")?/g, '');
}

function selectorOf(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 6; n = n.parentElement) {
    if (n.id) {
      parts.unshift(`#${CSS.escape(n.id)}`);
      break;
    }
    let part = n.tagName.toLowerCase();
    const classes = [...n.classList].filter((c) => !c.startsWith('astro-')).slice(0, 2);
    if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
    const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
}

// ---------- helpers ----------

function box(r) {
  return { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` };
}

function readJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function confirmReset() {
  // No window.confirm: it blocks the page. A second click within 3 s confirms.
  const now = Date.now();
  const ok = now - (confirmReset.at ?? 0) < 3000;
  confirmReset.at = now;
  return ok;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Custom command output is plain text; agent replies are Markdown. */
function render(text, plain) {
  return plain ? `<pre class="plain">${escapeHtml(text)}</pre>` : markdown(text);
}

function markdown(src) {
  const blocks = escapeHtml(src).split(/```(?:[\w-]*)\n?/);
  return blocks
    .map((b, i) =>
      i % 2
        ? `<pre>${b}</pre>`
        : b
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>'),
    )
    .join('');
}

const SETTING_LABELS = { model: 'Model', effort: 'Effort', thinking: 'Thinking', provider: 'Provider' };
const SETTING_HINTS = {
  model: 'Switching models mid-conversation makes the next message more expensive once, because the new model has to write the whole context to the cache again.',
};

const GEAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.hover, .pick {
  position: fixed; pointer-events: none; z-index: 2147483646;
  outline: 2px solid #7c5cff; background: rgba(124, 92, 255, .12); border-radius: 2px;
}
.pick { outline: 2px dashed #ffb020; background: transparent; }
.label {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; white-space: nowrap;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff;
  background: #7c5cff; padding: 2px 6px; border-radius: 3px;
}
.label.below { bottom: auto; top: 100%; margin: 4px 0 0; }
[hidden] { display: none !important; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: min(400px, calc(100vw - 32px)); height: min(560px, calc(100vh - 32px));
  display: flex; flex-direction: column;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #e7e7ee; background: #17171f; border: 1px solid #33334a; border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden;
}
.panel.left { right: auto; left: 16px; }
.panel header { cursor: move; user-select: none; touch-action: none; }
.panel header button { cursor: pointer; }
.panel.dragging { user-select: none; opacity: .97; }
.grip { position: absolute; width: 14px; height: 14px; z-index: 2; touch-action: none; }
.grip.nw { top: 0; left: 0; cursor: nwse-resize; }
.grip.ne { top: 0; right: 0; cursor: nesw-resize; }
.grip.sw { bottom: 0; left: 0; cursor: nesw-resize; }
.grip.se { bottom: 0; right: 0; cursor: nwse-resize; }
.grip.se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
  border-right: 2px solid #4a4a66; border-bottom: 2px solid #4a4a66; }
.fab {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 44px; height: 44px; border-radius: 50%; padding: 0;
  font: 20px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: #fff;
  background: #7c5cff; border: 0; box-shadow: 0 6px 20px rgba(0,0,0,.4); opacity: .85;
}
.fab:hover { background: #8d71ff; opacity: 1; }
.fab.left { right: auto; left: 16px; }
.fab.busy { animation: pulse 1s infinite; }
.gear { display: inline-flex; align-items: center; justify-content: center; padding: 3px 6px; }
.gear svg { width: 18px; height: 18px; }
header button.active { background: #7c5cff; border-color: #7c5cff; }
.settings { flex: 1; overflow-y: auto; padding: 4px 12px 12px; }
.settings h3 { margin: 12px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8f8fa8; }
.settings label { display: block; margin-bottom: 8px; }
.settings select {
  display: block; width: 100%; margin-top: 3px; font: inherit; color: inherit;
  background: #101018; border: 1px solid #33334a; border-radius: 6px; padding: 4px 6px;
}
.settings input[data-text] {
  display: block; width: 100%; margin-top: 3px; color: inherit; background: #101018;
  border: 1px solid #33334a; border-radius: 6px; padding: 5px 7px;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.settings input[data-text]:focus { border-color: #7c5cff; outline: none; }
.settings input[data-text]:disabled { opacity: .6; cursor: not-allowed; }
.settings small { display: block; margin-top: 3px; color: #8f8fa8; font-size: 11px; }
.settings .action { margin-bottom: 10px; }
.settings .action button { width: 100%; padding: 6px 8px; background: #7c5cff; border-color: #7c5cff; }
.settings label.check { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
.settings .meta { color: #8f8fa8; font-size: 12px; }
header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #2a2a3c; }
header .agent { color: #8f8fa8; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.versions { display: flex; align-items: center; gap: 2px; font-size: 12px; color: #8f8fa8; }
.versions button { padding: 1px 6px; font-size: 10px; }
.versions button:disabled { opacity: .4; cursor: default; }
.vnum { min-width: 38px; text-align: center; cursor: help; }
.spacer { flex: 1; }
button {
  font: inherit; color: #e7e7ee; background: #2a2a3c; border: 1px solid #3a3a52;
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: #34344a; }
.log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.msg { white-space: normal; overflow-wrap: anywhere; }
.msg.user {
  align-self: flex-end; max-width: 90%; background: #3b2f86; padding: 6px 10px;
  border-radius: 10px 10px 2px 10px; white-space: pre-wrap;
}
.msg.user code { display: block; font-size: 11px; color: #c9bfff; margin-bottom: 2px; }
.msg.assistant { background: #22222f; padding: 6px 10px; border-radius: 10px 10px 10px 2px; }
.msg.assistant.live::after { content: "▍"; color: #7c5cff; }
.msg.tool, .msg.status, .msg.meta { color: #8f8fa8; font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.msg.meta { text-align: right; }
.msg.error, .msg.tool.error { color: #ff7a7a; }
.msg.denied { color: #ffb020; font-size: 12px; }
.msg.permission { background: #2a2418; border: 1px solid #5c4a1e; border-radius: 8px; padding: 6px 10px; font-size: 12px; color: #ffd37a; }
.msg.permission span { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.msg.permission button { margin: 6px 6px 0 0; font: inherit; padding: 2px 12px; border: 0; border-radius: 6px; background: #7c5cff; color: #fff; cursor: pointer; }
.msg.permission button.deny { background: #3a3a50; }
.msg.permission button:disabled { opacity: 0.5; cursor: default; }
.msg.permission.allowed, .msg.permission.answered { background: none; border-color: transparent; padding: 0; color: #8f8fa8; }
code, pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.msg code { background: #2d2d40; padding: 0 3px; border-radius: 3px; }
pre.plain { margin: 0; background: transparent; padding: 0; white-space: pre-wrap; }
pre { background: #101018; padding: 8px; border-radius: 6px; overflow-x: auto; white-space: pre; }
.target {
  display: flex; align-items: center; gap: 6px; margin: 0 10px; padding: 4px 6px 4px 8px;
  background: #2b2414; border: 1px solid #5c4a1c; border-radius: 6px; color: #ffcf70;
}
.target code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target button { padding: 0 6px; background: transparent; border: 0; color: inherit; }
form { display: flex; gap: 6px; padding: 8px 10px; }
textarea {
  flex: 1; resize: none; font: inherit; color: inherit; background: #101018;
  border: 1px solid #33334a; border-radius: 6px; padding: 6px 8px; outline: none;
}
textarea:focus { border-color: #7c5cff; }
.send { background: #7c5cff; border-color: #7c5cff; color: #fff; }
.send.stop { background: #b33a3a; border-color: #b33a3a; }
.panel.busy header strong::after { content: " ●"; color: #7c5cff; animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .2; } }
footer { padding: 0 10px 8px; color: #6f6f88; font-size: 11px; }
`;
