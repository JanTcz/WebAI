// WebAI Editor: edit any website in the browser, nothing to install. Everything runs in the browser. The site's files (incl.
// folders and images) live in the browser's Cache Storage, and the preview at
// preview/… is served by a service worker (sw.js). The agent is a short loop
// over an OpenAI-compatible API with the tools list_files / read_file /
// edit_file / write_file / delete_file. The overlay is the same as in the
// Astro integration, except it talks to this page instead of a dev server (transport).

import { annotateHtml, injectHtml, SRC_ATTR } from '../packages/webai/src/html.js';
import { buildPrompt } from '../packages/webai/src/prompt.js';
import { createZip, readZip } from './zip.js';

const OVERLAY_URL = new URL('../packages/webai/src/client/overlay.js', import.meta.url).href;
const ORIGINAL_FILES = ['index.html', 'styles.css'];
const TEXT_EXT = /\.(html?|css|m?js|json|svg|txt|md|xml|webmanifest)$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SITE_BYTES = 50 * 1024 * 1024;
const MAX_STEPS = 15;
const MAX_EVENTS = 300;

// Storage names keep the old `demo` prefix, so sites saved before the rename are still there.
const CACHE = { files: 'webai-demo-files', preview: 'webai-demo-preview', versions: 'webai-demo-versions' };
const MAX_VERSIONS = 50;

const STORE = {
  files: 'webai-demo:files', // legacy storage, migrated to CACHE.files
  events: 'webai-demo:events',
  messages: 'webai-demo:messages',
  settings: 'webai-demo:settings',
  versions: 'webai-demo:versions',
};

/**
 * Optional editor proxy (editor/proxy): with it, visitors need no account. Its URL
 * goes into `<meta name="webai-proxy">`; locally it runs on :4510. Without it,
 * visitors sign in with OpenRouter (OAuth PKCE, straight from the browser).
 */
const PROXY_URL = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '')
  ? 'http://localhost:4510/v1' // the public proxy only serves the published editor
  : globalThis.document?.querySelector('meta[name="webai-proxy"]')?.content || '';

/** Free models in fallback order, best at tool use first (measured October 2026). */
const FREE_FALLBACKS = [
  'poolside/laguna-s-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

/**
 * Providers with an OpenAI-compatible `/chat/completions` that allow calls
 * from the browser (CORS). Anonymous keyless endpoints (Pollinations, Kilo)
 * block direct browser calls, so the default is OpenRouter with sign-in.
 */
const PROVIDERS = {
  ...(PROXY_URL
    ? {
        webai: {
          label: 'WebAI server (free, nothing needed)',
          baseUrl: PROXY_URL,
          model: 'poolside/laguna-s-2.1:free',
          fallbacks: FREE_FALLBACKS,
          keyless: true,
        },
      }
    : {}),
  openrouter: {
    label: 'OpenRouter (:free models at no cost, sign in or paste a key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'poolside/laguna-s-2.1:free',
    fallbacks: FREE_FALLBACKS,
  },
  custom: {
    label: 'Custom endpoint (e.g. Ollama)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    keyless: true,
  },
};

const DEFAULT_PROVIDER = PROXY_URL ? 'webai' : 'openrouter';

/**
 * Models that can call tools, for the model select. There is no "strength"
 * in the lists: free models go in the order measured with this editor, then by
 * size in the name; paid ones by price, a rough proxy. Lists without prices
 * or capabilities (e.g. Ollama) are kept whole, by size.
 */
export function rankModels(models, { freeOnly = false } = {}) {
  const usable = models.filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'));
  if (!usable.some((m) => m.pricing)) {
    return usable.map((m) => ({ value: m.id, label: m.name ?? m.id })).sort((a, b) => size(b.value) - size(a.value) || a.value.localeCompare(b.value));
  }
  const isFree = (m) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
  const tested = (m) => (FREE_FALLBACKS.includes(m.id) ? FREE_FALLBACKS.indexOf(m.id) : FREE_FALLBACKS.length);
  const perMillion = (price) => `$${+(Number(price) * 1e6).toFixed(2)}`;
  const free = usable.filter(isFree).sort((a, b) => tested(a) - tested(b) || size(b.id) - size(a.id) || a.name.localeCompare(b.name));
  const paid = freeOnly ? [] : usable.filter((m) => !isFree(m)).sort((a, b) => Number(b.pricing.completion) - Number(a.pricing.completion));
  return [
    ...free.map((m) => ({ value: m.id, label: m.name.replace(/\s*\(free\)$/i, ''), group: 'Free: tested best first, then by size' })),
    ...paid.map((m) => ({ value: m.id, label: `${m.name} · ${perMillion(m.pricing.prompt)}/${perMillion(m.pricing.completion)} per M tokens`, group: 'Paid, from your credits: priciest first' })),
  ];
}

/** Parameter count from a model ID like `…-120b-a12b`, for sorting; 0 when unknown. */
const size = (id) => Number(id.match(/(\d+(?:\.\d+)?)b\b/i)?.[1] ?? 0);

/** Model lists per endpoint, from its OpenAI-compatible `GET /models`; `null` = not available. */
const modelLists = new Map();

function loadModels(baseUrl, { key, freeOnly } = {}) {
  if (!baseUrl) return Promise.resolve(null);
  if (!modelLists.has(baseUrl)) {
    const list = fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (Array.isArray(data?.data) && data.data.length ? rankModels(data.data, { freeOnly }) : null))
      .catch(() => null); // no list: the text field stays
    modelLists.set(baseUrl, { list, value: undefined });
    list.then((value) => (modelLists.get(baseUrl).value = value));
  }
  return modelLists.get(baseUrl).list;
}

const SYSTEM_PROMPT = `You are connected to a browser overlay of a small static website.
The site's source files live in the browser's storage; list_files shows them
(there may be folders, several pages and images).
The user points at an element on the rendered page and asks for a change.
Each message carries the element's source location (file:line:col), the CSS
selector, its text and an HTML excerpt.
Use the tools: read the file first, then change it with edit_file (exact text
replacement, keep the edit minimal and in the style of the surrounding code).
Put styles into the site's stylesheet, not inline. Binary files (images) can't
be read, only referenced. Links, src and CSS url() are relative to the file
that contains them: from pages/about.html an image in img/ is ../img/logo.png.
For a new image: search_images, pick the best match by title and size, then
add_image to save it into the site (e.g. img/hero.jpg). add_image returns an
HTML snippet: insert it (adjust the alt text and classes if needed), and keep
its credit caption: the image's license requires it.
The page re-renders after every edit.
When done, answer briefly (one or two sentences) in the user's language,
saying what you changed and where.`;

const TOOLS = [
  tool('list_files', 'List the site files with their sizes.', {}),
  tool('read_file', 'Read a file. Each line is prefixed with its number and a tab, which are not part of the content.', { path: { type: 'string' } }, ['path']),
  tool(
    'edit_file',
    'Replace an exact, unique piece of text in a file. Include enough surrounding text to make old_text unique.',
    { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
    ['path', 'old_text', 'new_text'],
  ),
  tool('write_file', 'Create or overwrite a whole text file. Paths may contain folders, e.g. pages/about.html.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('delete_file', 'Delete a file.', { path: { type: 'string' } }, ['path']),
  tool(
    'search_images',
    'Search openly licensed photos and illustrations (Openverse; only ones that may be used on commercial sites and resized or cropped). Returns id, title, creator, license and size of each.',
    { query: { type: 'string', description: 'A few English words, e.g. "mountain lake sunrise".' } },
    ['query'],
  ),
  tool(
    'add_image',
    'Save an image from search_images into the site and get its credit line.',
    { id: { type: 'string' }, path: { type: 'string', description: 'Where to save it, e.g. img/hero.jpg.' } },
    ['id', 'path'],
  ),
];

const TOOL_LABELS = { list_files: 'LS', read_file: 'Read', edit_file: 'Edit', write_file: 'Write', delete_file: 'Delete', search_images: 'Search images', add_image: 'Add image' };

// ---------------------------------------------------------------- images

// Openverse: openly licensed images, no key, limits per visitor (20 a minute, 200 a day).
const OPENVERSE = 'https://api.openverse.org/v1/images/';
const NO_ATTRIBUTION = new Set(['cc0', 'pdm']);

/** Results for the model, plus the full records kept for add_image. */
export async function searchImages(query, fetchImpl = fetch) {
  const url = `${OPENVERSE}?${new URLSearchParams({ q: query, page_size: '8', license_type: 'commercial,modification', mature: 'false' })}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(res.status === 429 ? 'Image search limit reached, try again later.' : `Image search failed (${res.status}).`);
  return ((await res.json()).results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    creator: r.creator,
    license: `${r.license === 'pdm' || r.license === 'cc0' ? r.license.toUpperCase() : `CC ${r.license.toUpperCase()}`} ${r.license_version ?? ''}`.trim(),
    size: r.width && r.height ? `${r.width}×${r.height}` : undefined,
    url: r.url,
    page: r.foreign_landing_url,
    thumbnail: r.thumbnail,
    attribution: NO_ATTRIBUTION.has(r.license) ? null : r.attribution,
  }));
}

/** `<figure>` with the image and, when the license asks for it, a credit caption. */
export function imageSnippet(src, image) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
  const credit = image.attribution
    ? `\n  <figcaption class="credit">Photo: <a href="${esc(image.page ?? image.url)}">${esc(image.title)}</a>${image.creator ? ` by ${esc(image.creator)}` : ''}, ${esc(image.license)}</figcaption>`
    : '';
  return `<figure>\n  <img src="${esc(src)}" alt="${esc(image.title)}">${credit}\n</figure>`;
}

/** The image itself, or Openverse's smaller copy when its host doesn't allow downloads from a page. */
async function downloadImage(image) {
  for (const url of [image.url, image.thumbnail]) {
    try {
      const res = await fetch(url);
      const blob = res.ok ? await res.blob() : null;
      if (blob?.type.startsWith('image/') && blob.size <= MAX_FILE_BYTES) return blob;
    } catch {
      // CORS or network: try the next one
    }
  }
  return null;
}

// ---------------------------------------------------------------- storage

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

async function originalFiles() {
  const entries = await Promise.all(
    ORIGINAL_FILES.map(async (f) => [f, await (await fetch(new URL(`site/${f}`, import.meta.url))).text()]),
  );
  return Object.fromEntries(entries);
}

/** Site files: text as a string, everything else (images, fonts…) as a Blob. */
export const isText = (path) => TEXT_EXT.test(path);

/** Relative path inside the site, or `null` (empty, absolute outside the site, `..`, hidden files). */
export function cleanPath(p) {
  if (typeof p !== 'string') return null;
  const parts = p.trim().replace(/^\.?\/+/, '').split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.') || x.includes('\\'))) return null;
  return parts.join('/');
}

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', xml: 'application/xml', webmanifest: 'application/manifest+json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', pdf: 'application/pdf',
};
const mimeType = (path) => {
  const type = MIME[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
  return isText(path) ? `${type}; charset=utf-8` : type;
};

const sizeOf = (content) => (typeof content === 'string' ? new Blob([content]).size : content.size);
const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const fileKey = (path) => new URL(`files/${encodeURI(path)}`, import.meta.url).href;
const previewUrl = (path) => new URL(`preview/${encodeURI(path)}`, import.meta.url).href;

async function loadFiles() {
  const cache = await caches.open(CACHE.files);
  const files = {};
  for (const req of await cache.keys()) {
    // By the marker, not the prefix: files saved under …/demo/files/ before the rename count too.
    const path = decodeURI(req.url.slice(req.url.indexOf('/files/') + '/files/'.length));
    const res = await cache.match(req);
    files[path] = isText(path) ? await res.text() : await res.blob();
  }
  return files;
}

/** Background writes in the order the changes came in; `null` deletes the file. */
let writes = Promise.resolve();
function persist(path, content) {
  writes = writes
    .then(async () => {
      const cache = await caches.open(CACHE.files);
      if (content == null) await cache.delete(fileKey(path));
      else await cache.put(fileKey(path), new Response(content));
    })
    .catch((err) => console.error('[webai] saving file', path, err));
  return writes;
}

async function persistAll(files) {
  await writes;
  await caches.delete(CACHE.files);
  await Promise.all(Object.entries(files).map(([p, c]) => persist(p, c)));
}

// ---------------------------------------------------------------- versions

const versionKey = (hash) => new URL(`versions/${hash}`, import.meta.url).href;

/** A version's content by its hash, wherever the page was when it was saved (…/demo/versions/ before the rename). */
async function versionContent(cache, hash) {
  const exact = await cache.match(versionKey(hash));
  if (exact) return exact;
  const key = (await cache.keys()).find((req) => req.url.endsWith(`/versions/${hash}`));
  return key ? cache.match(key) : null;
}

/**
 * Versions of the site, as in the Astro integration's history: one per agent
 * answer and one for your own changes in between (uploads, edits elsewhere).
 * A version is a list of paths with content hashes (localStorage); the contents
 * are stored once per hash in Cache Storage.
 */
export class Versions {
  constructor() {
    this.state = load(STORE.versions, { versions: [], current: -1 });
  }

  /** `{path: hash}` for the files, storing contents not seen before. */
  async manifest(files) {
    const cache = await caches.open(CACHE.versions);
    const out = {};
    for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : await content.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (!(await versionContent(cache, hash))) await cache.put(versionKey(hash), new Response(content));
      out[path] = hash;
    }
    return out;
  }

  /** A new version when the files differ from the current one; null when they don't. */
  async snapshot(files, label, { keep = false } = {}) {
    const files_ = await this.manifest(files);
    const current = this.state.versions[this.state.current];
    if (current && JSON.stringify(current.files) === JSON.stringify(files_)) return null;
    const kept = keep ? this.state.versions : this.state.versions.slice(0, this.state.current + 1);
    const versions = [...kept, { files: files_, label: String(label).slice(0, 200), ts: Date.now() }].slice(-MAX_VERSIONS);
    this.state = { versions, current: versions.length - 1 };
    save(STORE.versions, this.state);
    await this.prune();
    return this.list();
  }

  /** The files of version `index`; changes since the current version are kept as a version first. */
  async restore(index, files) {
    const target = this.state.versions[index];
    if (!target) throw new Error(`No version ${index}.`);
    const cache = await caches.open(CACHE.versions);
    const out = {};
    for (const [path, hash] of Object.entries(target.files)) {
      const res = await versionContent(cache, hash);
      // A version with missing contents is not restored: that would quietly delete files.
      if (!res) throw new Error(`Version ${index + 1} can't be restored: the browser no longer has ${path}.`);
      out[path] = isText(path) ? await res.text() : await res.blob();
    }
    await this.snapshot(files, 'Your edits', { keep: true });
    this.state.current = index;
    save(STORE.versions, this.state);
    return out;
  }

  /** Forgets all versions (a reset or a new site starts the history over). */
  async clear() {
    this.state = { versions: [], current: -1 };
    save(STORE.versions, this.state);
    await caches.delete(CACHE.versions);
  }

  /** Drops contents no version refers to any more. */
  async prune() {
    const used = new Set(this.state.versions.flatMap((v) => Object.values(v.files)));
    const cache = await caches.open(CACHE.versions);
    for (const req of await cache.keys()) if (!used.has(req.url.split('/').pop())) await cache.delete(req);
  }

  list() {
    return {
      enabled: true,
      current: this.state.current,
      versions: this.state.versions.map(({ label, ts }, i) => ({ index: i, label, ts })),
    };
  }
}

// ---------------------------------------------------------------- harness

class Harness {
  constructor(files) {
    this.files = files;
    this.events = load(STORE.events, []);
    this.messages = load(STORE.messages, []);
    this.settings = { provider: DEFAULT_PROVIDER, ...load(STORE.settings, {}) };
    // OpenRouter without a key would only report an error: use the editor's proxy if there is one.
    if (PROVIDERS.webai && this.settings.provider === 'openrouter' && !this.settings.apiKey) this.settings = { provider: 'webai' };
    this.seq = this.events.at(-1)?.seq ?? 0;
    this.listeners = new Set();
    this.abort = null;
    this.onFilesChanged = () => {};
    this.onAction = async () => {}; // buttons in the settings, wired up by the page
    this.versions = new Versions();
    this.versioning = Promise.resolve(); // versions are taken one after another
  }

  /** A version of the files as they are now; tells the overlay when there is a new one. */
  version(label) {
    const files = { ...this.files };
    this.versioning = this.versioning
      .then(() => this.versions.snapshot(files, label))
      .then((list) => list && this.emit({ type: 'history', current: list.current, count: list.versions.length }))
      .catch((err) => console.error('[webai] version history', err));
    return this.versioning;
  }

  async clearVersions() {
    await this.versioning;
    await this.versions.clear();
    this.emit({ type: 'history', current: -1, count: 0 });
  }

  async restoreVersion(index) {
    if (this.busy) throw new Error('The agent is still working.');
    await this.versioning;
    await writes;
    const files = await this.versions.restore(Number(index), this.files);
    await this.replaceFiles(files);
    const list = this.versions.list();
    const v = list.versions[list.current];
    this.emit({ type: 'history', current: list.current, count: list.versions.length });
    this.emit({ type: 'status', text: `Version ${list.current + 1} of ${list.versions.length}: ${v.label}` });
    return list;
  }

  get busy() {
    return this.abort != null;
  }

  get provider() {
    return PROVIDERS[this.settings.provider] ?? PROVIDERS[DEFAULT_PROVIDER];
  }

  emit(ev) {
    ev = { ...ev, seq: ++this.seq, ts: Date.now() };
    if (ev.type !== 'delta') {
      this.events.push(ev);
      if (this.events.length > MAX_EVENTS) this.events.shift();
      save(STORE.events, this.events);
    }
    for (const fn of this.listeners) fn(ev);
    // After the agent's answer, what it changed is a version named after your message.
    if (ev.type === 'done' && this.pendingVersion) {
      const label = this.pendingVersion;
      this.pendingVersion = null;
      this.version(label);
    }
  }

  writeFile(path, content) {
    if (content == null) delete this.files[path];
    else this.files[path] = content;
    persist(path, content);
    this.onFilesChanged(path);
  }

  /** The whole site at once (upload, reset). */
  async replaceFiles(files) {
    if (this.busy) this.stop();
    this.files = files;
    await persistAll(files);
    this.onFilesChanged(null);
  }

  snapshot() {
    const p = this.provider;
    return {
      agent: 'Browser agent',
      agents: [{ name: 'browser', label: 'Browser agent', version: 'browser', settings: this.settingSpecs() }],
      settings: { agent: 'browser', browser: this.settings },
      session: { id: 'demo', started: this.messages.length > 0, totalCostUsd: this.events.reduce((s, e) => s + (e.costUsd ?? 0), 0) },
      busy: this.busy,
      provider: p.label,
    };
  }

  settingSpecs() {
    const p = this.provider;
    const signedIn = !!this.settings.apiKey?.trim();
    return {
      provider: Object.entries(PROVIDERS).map(([value, { label }]) => ({ value, label })),
      // Right under the provider, where it's expected: no account and no key means no answers.
      ...(this.settings.provider === 'openrouter'
        ? {
            account: signedIn
              ? { type: 'action', action: 'signout', label: 'Sign out of OpenRouter', hint: 'Removes the key from this browser.' }
              : { type: 'action', action: 'signin', label: 'Sign in with OpenRouter', hint: 'A free account; :free models cost nothing. Or paste a key below.' },
          }
        : {}),
      model: this.modelSpec(),
      ...(this.settings.provider === 'custom'
        ? { baseUrl: { type: 'text', label: 'Endpoint URL', placeholder: p.baseUrl, default: '', hint: 'OpenAI-compatible API. Ollama: run it with OLLAMA_ORIGINS=* to allow calls from the browser.' } }
        : {}),
      ...(p.keyless
        ? {}
        : {
            apiKey: {
              type: 'text',
              secret: true,
              label: 'API key',
              default: '',
              hint: 'Filled in by "Sign in with OpenRouter" above, or paste one from openrouter.ai/keys. Stays only in this browser\'s localStorage and is sent only to the provider.',
            },
          }),
    };
  }

  get baseUrl() {
    return (this.settings.baseUrl?.trim() || this.provider.baseUrl).replace(/\/$/, '');
  }

  /** Starts loading the chosen provider's model list; resolves when it's there (or isn't available). */
  loadModels() {
    // Without a key the proxy serves only free models; a local endpoint has no prices.
    return loadModels(this.baseUrl, { key: this.provider.keyless ? undefined : this.settings.apiKey?.trim(), freeOnly: this.provider.keyless && !!this.provider.fallbacks });
  }

  /** A select of the provider's models when it lists them, otherwise a text field for the model ID. */
  modelSpec() {
    const p = this.provider;
    const choices = modelLists.get(this.baseUrl)?.value;
    if (!choices?.length) return { type: 'text', label: 'Model', placeholder: p.model, default: '', hint: `Empty = ${p.model}.` };
    const current = this.settings.model?.trim();
    return [
      { value: '', label: p.fallbacks ? `Default: ${p.model}, switching to other free models when busy` : `Default: ${p.model}` },
      ...(current && !choices.some((c) => c.value === current) ? [{ value: current, label: current }] : []),
      ...choices,
    ];
  }

  setSettings(input) {
    const next = { ...this.settings, ...(input.browser ?? {}) };
    for (const [k, v] of Object.entries(next)) if (typeof v !== 'string') delete next[k];
    if (!PROVIDERS[next.provider]) next.provider = DEFAULT_PROVIDER;
    if (next.provider !== this.settings.provider) delete next.model; // the model belongs to the provider
    this.settings = next;
    save(STORE.settings, next);
    return { agent: 'browser', browser: next };
  }

  reset() {
    this.stop();
    this.messages = [];
    this.events = [];
    save(STORE.messages, []);
    this.emit({ type: 'reset' });
  }

  stop() {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  send({ message, element, page }) {
    if (this.busy) throw new Error('The agent is still working on the previous message.');
    // The preview's URL (…/preview/pages/about.html) would send the model looking for that path: give it the file.
    if (page?.url?.includes('/preview/')) page = { ...page, url: decodeURI(page.url.split('/preview/').pop().split(/[?#]/)[0]) || 'index.html' };
    const p = this.provider;
    // A keyless provider has no key field: a key saved for OpenRouter must not leak to it (the proxy's CORS rejects Authorization).
    const key = p.keyless ? undefined : this.settings.apiKey?.trim();
    if (!p.keyless && !key) {
      throw new Error('Sign in with OpenRouter in ⚙ (a free account, free models), or set a custom endpoint such as a local Ollama there.');
    }
    if (!(this.settings.baseUrl?.trim() || p.baseUrl)) throw new Error('The WebAI server is not configured. In ⚙, choose OpenRouter with a key or a custom endpoint.');
    const model = this.settings.model?.trim() || p.model;
    // The files before the agent touches them: the first version, or your changes since the last.
    this.version(this.versions.state.versions.length ? 'Your edits' : 'Start');
    this.pendingVersion = message;
    this.emit({ type: 'user', text: message, element, page, agent: this.settings.provider, settings: { model } });
    this.messages.push({ role: 'user', content: buildPrompt({ message, element, page }) });
    this.run({ baseUrl: (this.settings.baseUrl?.trim() || p.baseUrl).replace(/\/$/, ''), model, key });
  }

  async run({ baseUrl, model, key }) {
    // `model` changes when a fallback takes over.
    const abort = (this.abort = new AbortController());
    const started = Date.now();
    let costUsd = 0;
    this.emit({ type: 'status', text: `${model} is working…`, busy: true });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        // Free models are often overloaded or answer with nothing: then the
        // next free model takes over (and stays, so one task isn't split across
        // models). A model the user picked gets one more try instead.
        const fallbacks = this.settings.model?.trim() ? [model] : (this.provider.fallbacks ?? []).filter((m) => m !== model);
        let msg;
        for (const candidate of [model, ...fallbacks]) {
          if (candidate !== model) {
            this.emit({ type: 'status', text: `${model} is busy, switching to ${candidate}…`, busy: true });
            model = candidate;
          }
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            signal: abort.signal,
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.messages],
              tools: TOOLS,
              tool_choice: 'auto',
              // OpenRouter returns the request's cost in usage.cost.
              ...(baseUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
            }),
          });
          const data = await res.json().catch(() => ({}));
          msg = res.ok ? data.choices?.[0]?.message : null;
          if (msg) {
            costUsd += data.usage?.cost ?? 0;
            break;
          }
          // Overloaded upstream (429 mentioning it), server errors and empty answers are worth
          // another model; other errors (a key, our own rate limit) are not.
          const busy = res.status >= 500 || (res.status === 429 && /upstream|overload|temporarily/i.test(JSON.stringify(data)));
          if (!res.ok && !busy) throw new Error(apiError(res.status, data));
          if (candidate === fallbacks.at(-1) || !fallbacks.length) {
            throw new Error(res.ok ? 'The model returned no response.' : apiError(res.status, data));
          }
        }
        const calls = msg.tool_calls ?? [];
        this.messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        save(STORE.messages, this.messages);
        if (msg.content?.trim()) this.emit({ type: 'text', text: msg.content.trim() });
        if (!calls.length) {
          this.emit({ type: 'done', ok: true, durationMs: Date.now() - started, costUsd });
          return;
        }
        for (const call of calls) {
          const result = await this.execute(call);
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        save(STORE.messages, this.messages);
      }
      this.emit({ type: 'done', ok: false, error: `The agent did not finish the task within ${MAX_STEPS} steps.` });
    } catch (err) {
      const error =
        err.name === 'AbortError' ? 'Stopped.' : err instanceof TypeError ? `The model server is not responding (${baseUrl}). Try again in a moment.` : err.message;
      this.emit({ type: 'done', ok: false, error, durationMs: Date.now() - started });
    } finally {
      this.abort = null;
      // The conversation must stay valid: a tool call without a result would make the next request fail.
      this.repairMessages();
    }
  }

  /** Runs one tool and returns the result for the model; errors go to the model as text. */
  async execute(call) {
    const name = call.function?.name;
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      return this.toolError(call, name, 'Arguments are not valid JSON.');
    }
    this.emit({ type: 'tool', id: call.id, name: TOOL_LABELS[name] ?? name, summary: args.path ?? args.query ?? '' });
    const path = cleanPath(args.path);
    const content = path == null ? undefined : this.files[path];
    const missing = () => this.toolError(call, name, `No such file: ${args.path}`);
    const binary = () => `Binary file (${mimeType(path)}, ${formatSize(content.size)}). Reference it relative to the file that uses it, e.g. in <img src> or CSS url().`;
    switch (name) {
      case 'list_files':
        return Object.entries(this.files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([p, c]) => `${p}\t${formatSize(sizeOf(c))}${typeof c === 'string' ? '' : ' (binary)'}`)
          .join('\n');
      case 'read_file': {
        if (content == null) return missing();
        if (typeof content !== 'string') return binary();
        return content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      }
      case 'edit_file': {
        const text = content;
        if (text == null) return missing();
        if (typeof text !== 'string') return this.toolError(call, name, binary());
        if (!args.old_text) return this.toolError(call, name, 'old_text is empty.');
        const edit = matchEdit(text, args.old_text, args.new_text ?? '');
        if (edit.count === 0) return this.toolError(call, name, 'old_text not found. Read the file again and copy the text exactly.');
        if (edit.count > 1) return this.toolError(call, name, `old_text occurs ${edit.count} times. Include more surrounding text.`);
        this.writeFile(path, text.replace(edit.old, () => edit.new));
        return 'OK';
      }
      case 'write_file': {
        if (path == null || !isText(path)) return this.toolError(call, name, `Invalid path. Use a relative path to a text file (${TEXT_EXT.source}).`);
        this.writeFile(path, String(args.content ?? ''));
        return 'OK';
      }
      case 'delete_file': {
        if (content == null) return missing();
        this.writeFile(path, null);
        return 'OK';
      }
      case 'search_images': {
        let found;
        try {
          found = await searchImages(String(args.query ?? ''));
        } catch (err) {
          return this.toolError(call, name, err.message);
        }
        this.images ??= new Map();
        for (const image of found) this.images.set(image.id, image);
        if (!found.length) return 'No images found. Try other, more general words.';
        return JSON.stringify(found.map(({ id, title, creator, license, size }) => ({ id, title, creator, license, size })));
      }
      case 'add_image': {
        const image = this.images?.get(args.id);
        if (!image) return this.toolError(call, name, 'Unknown id. Use an id from search_images.');
        if (path == null || !/\.(jpe?g|png|webp|gif|avif)$/i.test(path)) return this.toolError(call, name, 'Use a path like img/name.jpg.');
        const blob = await downloadImage(image);
        if (!blob) return this.toolError(call, name, 'This image could not be downloaded. Pick another one.');
        this.writeFile(path, blob);
        return `Saved ${path} (${formatSize(blob.size)}). Insert this, with src relative to the page that uses it:\n${imageSnippet(path, image)}`;
      }
      default:
        return this.toolError(call, name, `Unknown tool: ${name}`);
    }
  }

  toolError(call, name, text) {
    this.emit({ type: 'tool-error', id: call.id, text: `${TOOL_LABELS[name] ?? name}: ${text}` });
    return `Error: ${text}`;
  }

  /** After an interruption: fills in missing tool results so the conversation can continue. */
  repairMessages() {
    const answered = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const fixed = [];
    for (const m of this.messages) {
      fixed.push(m);
      for (const call of m.tool_calls ?? []) {
        if (!answered.has(call.id)) fixed.push({ role: 'tool', tool_call_id: call.id, content: 'Error: interrupted.' });
      }
    }
    this.messages = fixed;
    save(STORE.messages, fixed);
  }

  /** Transport for the overlay (same interface as the HTTP variant in overlay.js). */
  transport() {
    return {
      request: async (method, path, body) => {
        // The settings show the provider's models: wait a moment for the list (it's cached after that).
        const models = () => Promise.race([this.loadModels(), new Promise((r) => setTimeout(r, 4000))]);
        if (method === 'GET' && path === '/state') return await models(), this.snapshot();
        if (path === '/send') return this.send(body), { ok: true };
        if (path === '/settings') {
          const settings = this.setSettings(body);
          await models();
          return { settings };
        }
        if (path === '/stop') return { stopped: this.stop() };
        if (path === '/action') return await this.onAction(body.action), { ok: true };
        if (path === '/reset') return this.reset(), { ok: true };
        if (method === 'GET' && path === '/history') return await this.versioning, this.versions.list();
        if (path === '/history/restore') return await this.restoreVersion(body.index);
        throw new Error(`Unknown request ${method} ${path}`);
      },
      subscribe: ({ onEvent, onReady }) => {
        for (const ev of this.events) onEvent(ev);
        onReady({ busy: this.busy });
        this.listeners.add(onEvent);
        return () => this.listeners.delete(onEvent);
      },
    };
  }
}

/**
 * Exact match first. Weaker models often get the whitespace or quotes of
 * old_text slightly wrong (extra indentation from the line-number format,
 * tabs instead of spaces, “ ” typed as "), so then it matches whole lines
 * ignoring indentation and quote style. new_text is re-indented to the file:
 * lines copied from old_text keep their original form, new lines are shifted
 * by however much the model's indentation was off.
 */
export function matchEdit(text, oldText, newText) {
  const exact = text.split(oldText).length - 1;
  if (exact) return { count: exact, old: oldText, new: newText };

  const norm = (l) => l.trim().replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
  const fileLines = text.split('\n');
  const oldLines = oldText.split('\n');
  while (oldLines.length && !oldLines.at(-1).trim()) oldLines.pop();
  while (oldLines.length && !oldLines[0].trim()) oldLines.shift();
  if (!oldLines.length) return { count: 0 };
  const want = oldLines.map(norm);
  const starts = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    if (want.every((w, j) => norm(fileLines[i + j]) === w)) starts.push(i);
  }
  if (starts.length !== 1) return { count: starts.length };

  const at = starts[0];
  const matched = fileLines.slice(at, at + want.length);
  const width = (l) => l.match(/^\s*/)[0].replace(/\t/g, '  ').length;
  const unit = matched.find((l) => /^\t/.test(l)) ? '\t' : ' ';
  const pad = (n) => (unit === '\t' ? '\t'.repeat(Math.round(n / 2)) : ' '.repeat(n));
  // How far off the model's indentation is: the most common difference, not
  // counting the first line (models often start old_text mid-line).
  const diffs = (oldLines.length > 1 ? oldLines.slice(1) : oldLines).map((l, j) => width(matched[j + (oldLines.length > 1)]) - width(l));
  const shift = diffs.sort((x, y) => diffs.filter((d) => d === y).length - diffs.filter((d) => d === x).length)[0];
  const byText = new Map(matched.map((l) => [norm(l), l]));
  const out = newText.split('\n').map((l) => {
    if (!l.trim()) return '';
    return byText.get(norm(l)) ?? pad(Math.max(0, width(l) + shift)) + l.trim();
  });
  return { count: 1, old: matched.join('\n'), new: out.join('\n') };
}

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

function apiError(status, data) {
  const detail = data.error?.message ?? data.error ?? data.message ?? '';
  if (status === 401) return `The provider rejected the key (401). ${detail}`.trim();
  if (status === 429) return `The provider is rate limiting requests (429), try again in a moment. ${detail}`.trim();
  return `API error ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600);
}

// ---------------------------------------------------------------- rendering

/** `data-webai-src="file:line:column"` on every element, as the CLI does for static sites. */
export const annotate = annotateHtml;

/** Page HTML for the preview: annotations plus the overlay wired to the harness in the parent page. */
export function withOverlay(html, file) {
  html = annotate(html, file);
  const cfg = JSON.stringify({ srcAttr: SRC_ATTR, triggers: ['shift-click'], fab: true });
  const boot = `<script type="module">
    import { start } from ${JSON.stringify(OVERLAY_URL)};
    start({ ...${cfg}, transport: parent.webaiDemo.transport });
  </script>`;
  return injectHtml(html, boot);
}

/** Prepares files for the service worker; `paths` = only the changed ones, `null` = the whole site. */
async function publishPreview(files, paths) {
  const cache = await caches.open(CACHE.preview);
  if (paths == null) {
    for (const req of await cache.keys()) await cache.delete(req);
    paths = Object.keys(files);
  }
  await Promise.all(
    paths.map((path) => {
      const content = files[path];
      if (content == null) return cache.delete(previewUrl(path));
      const body = /\.html?$/i.test(path) ? withOverlay(content, path) : content;
      return cache.put(previewUrl(path), new Response(body, { headers: { 'Content-Type': mimeType(path) } }));
    }),
  );
}

async function startPreviewWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers (e.g. in a Firefox private window), so the site preview cannot start.');
  const reg = await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {
    scope: new URL('preview/', import.meta.url).href,
    updateViaCache: 'none',
  });
  // `navigator.serviceWorker.ready` would never resolve: this page is outside the preview/ scope.
  const sw = reg.active ?? reg.waiting ?? reg.installing;
  if (sw.state !== 'activated') {
    await new Promise((resolve) => sw.addEventListener('statechange', () => sw.state === 'activated' && resolve()));
  }
}

// ---------------------------------------------------------------- upload and ZIP

/** Dropped files: whole folders too (recursively), with their inner paths. */
async function droppedFiles(dataTransfer) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      out.push({ path: prefix + entry.name, blob: await new Promise((res, rej) => entry.file(res, rej)) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) {
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((f) => ({ path: f.name, blob: f }));
  for (const entry of entries) await walk(entry, '');
  return out;
}

/**
 * Unpacks ZIPs and normalizes paths. If the upload contains `index.html`
 * (possibly inside a single top-level folder, as is common in ZIPs), it is a
 * whole site and replaces the current one; otherwise the files are added.
 * @param {{ path: string, blob: Blob }[]} items
 */
export async function prepareUpload(items) {
  let list = [];
  for (const { path, blob } of items) {
    if (/\.zip$/i.test(path)) {
      for (const e of await readZip(blob)) list.push({ path: e.path, blob: new Blob([e.data]) });
    } else list.push({ path, blob });
  }
  const skipped = list.filter((f) => cleanPath(f.path) == null || f.path.startsWith('__MACOSX/')).map((f) => f.path);
  list = list.filter((f) => !skipped.includes(f.path));
  // The site's root is the folder of the topmost index.html (ZIPs often wrap the
  // site in a folder or two, e.g. project/dist/); files outside it are skipped.
  const index = list.map((f) => f.path).filter((p) => /(^|\/)index\.html?$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (index?.includes('/')) {
    const root = index.slice(0, index.lastIndexOf('/') + 1);
    for (const f of list) if (!f.path.startsWith(root)) skipped.push(f.path);
    list = list.filter((f) => f.path.startsWith(root)).map((f) => ({ ...f, path: f.path.slice(root.length) }));
  }
  const files = {};
  let total = 0;
  for (const { path, blob } of list) {
    if (blob.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${formatSize(MAX_FILE_BYTES)}.`);
    total += blob.size;
    files[path] = isText(path) ? await blob.text() : blob;
  }
  return { files, replace: 'index.html' in files, total, skipped };
}

// ---------------------------------------------------------------- OpenRouter sign-in

// OAuth PKCE without a server: OpenRouter redirects back with `?code=`, the
// browser exchanges it for a key that belongs to the visitor's account.
const OAUTH_VERIFIER = 'webai-demo:oauth-verifier';
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const callbackUrl = () => location.origin + location.pathname;

async function signIn() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(OAUTH_VERIFIER, verifier);
  const url = new URL('https://openrouter.ai/auth');
  url.search = new URLSearchParams({ callback_url: callbackUrl(), code_challenge: challenge, code_challenge_method: 'S256', key_label: 'WebAI Editor' });
  location.assign(url);
}

/** After the redirect back: the key, or `null` when this isn't a sign-in. */
async function finishSignIn() {
  const code = new URLSearchParams(location.search).get('code');
  const verifier = sessionStorage.getItem(OAUTH_VERIFIER);
  if (!code) return null;
  history.replaceState(null, '', callbackUrl()); // the code is single-use, don't keep it in the address bar
  sessionStorage.removeItem(OAUTH_VERIFIER);
  if (!verifier) throw new Error('Sign-in expired, try again.');
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(apiError(res.status, data));
  return data.key;
}

// ---------------------------------------------------------------- start

export async function main() {
  const frame = document.querySelector('#site');
  const source = document.querySelector('#source');
  const status = document.querySelector('#status');

  await startPreviewWorker();
  let files = await loadFiles();
  const legacy = load(STORE.files, null); // earlier versions of the editor kept files in localStorage
  if (!Object.keys(files).length) files = legacy ?? (await originalFiles());
  if (legacy) localStorage.removeItem(STORE.files);
  await persistAll(files);

  const harness = new Harness(files);
  // Sign in / out from the panel's settings, under the provider.
  harness.onAction = async (action) => {
    if (action === 'signin') return signIn();
    if (action === 'signout') return harness.setSettings({ browser: { apiKey: '' } });
    throw new Error(`Unknown action: ${action}`);
  };
  window.webaiDemo = { transport: harness.transport() };

  const say = (text) => {
    status.textContent = text;
    clearTimeout(say.timer);
    say.timer = setTimeout(() => (status.textContent = ''), 6000);
  };

  finishSignIn()
    .then((key) => {
      if (!key) return;
      harness.setSettings({ browser: { provider: 'openrouter', apiKey: key } });
      say('Signed in with OpenRouter.');
    })
    .catch((err) => say(`Sign-in failed: ${err.message}`));

  // Refresh the preview after changes: collect the changed files and re-render once.
  let pending;
  let changed = new Set();
  let all = true;
  const render = async () => {
    const paths = all ? null : [...changed];
    changed = new Set();
    all = false;
    await publishPreview(harness.files, paths);
    const win = frame.contentWindow;
    const here = frame.src && win?.location.href.startsWith(previewUrl('')) && paths != null;
    if (here) {
      const scroll = win.scrollY;
      frame.addEventListener('load', () => frame.contentWindow.scrollTo(0, scroll), { once: true });
      win.location.reload();
    } else {
      frame.src = previewUrl('index.html' in harness.files ? 'index.html' : Object.keys(harness.files).find((p) => /\.html?$/i.test(p)) ?? 'index.html');
    }
    if (!source.hidden) showSource();
  };
  harness.onFilesChanged = (path) => {
    if (path == null) all = true;
    else changed.add(path);
    clearTimeout(pending);
    pending = setTimeout(render, 150);
  };

  const showSource = () => {
    source.querySelector('pre').textContent = Object.entries(harness.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, c]) => (typeof c === 'string' ? `/* ${f} */\n${c}` : `/* ${f} (${formatSize(c.size)}, binary) */`))
      .join('\n\n');
  };
  document.querySelector('#toggle-source').onclick = (e) => {
    source.hidden = !source.hidden;
    e.currentTarget.setAttribute('aria-pressed', String(!source.hidden));
    if (!source.hidden) showSource();
  };
  document.querySelector('#reset-site').onclick = async () => {
    await harness.replaceFiles(await originalFiles());
    await harness.clearVersions();
    harness.emit({ type: 'status', text: 'Site reset to its original state.' });
    say('Site reset to its original state.');
  };
  document.querySelector('#download').onclick = async () => {
    await writes;
    const zip = await createZip(Object.entries(harness.files).sort(([a], [b]) => a.localeCompare(b)));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(zip), download: 'web.zip' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const upload = async (items) => {
    try {
      const { files: incoming, replace, total, skipped } = await prepareUpload(items);
      const count = Object.keys(incoming).length;
      if (!count) return say('Nothing to upload.');
      const next = replace ? incoming : { ...harness.files, ...incoming };
      const size = Object.values(next).reduce((s, c) => s + sizeOf(c), 0);
      if (size > MAX_SITE_BYTES) return say(`The site would be ${formatSize(size)}; the editor's limit is ${formatSize(MAX_SITE_BYTES)}.`);
      if (replace) {
        await harness.replaceFiles(next);
        await harness.clearVersions(); // the versions of the previous site don't apply to this one
      } else for (const [p, c] of Object.entries(incoming)) harness.writeFile(p, c);
      const text = `${replace ? 'Uploaded new site' : 'Added'}: ${count} ${count === 1 ? 'file' : 'files'} (${formatSize(total)})${skipped.length ? `, skipped ${skipped.length} hidden or outside the site folder` : ''}.${replace ? '' : ' No index.html in the upload, so the page itself stays the same.'}`;
      harness.emit({ type: 'status', text });
      say(text);
    } catch (err) {
      say(`Upload failed: ${err.message}`);
    }
  };
  const picker = document.querySelector('#upload-input');
  // Usable only now: before this, a click would do nothing.
  document.querySelector('#upload').onclick = () => picker.click();
  picker.onchange = () => {
    upload([...picker.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f })));
    picker.value = '';
  };

  // Dragging files and folders. Over the iframe the preview would get the event,
  // so on the first dragenter (even from the preview) a zone covers everything.
  const zone = document.querySelector('#drop');
  const isFiles = (e) => e.dataTransfer?.types.includes('Files');
  const show = (e) => isFiles(e) && (zone.hidden = false);
  document.addEventListener('dragenter', show);
  frame.addEventListener('load', () => frame.contentDocument?.addEventListener('dragenter', show));
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('dragleave', (e) => e.target === zone && (zone.hidden = true));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.hidden = true;
    upload(await droppedFiles(e.dataTransfer));
  });

  render();
  for (const b of document.querySelectorAll('.bar button[disabled]')) b.disabled = false;
}
