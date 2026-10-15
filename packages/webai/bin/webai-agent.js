#!/usr/bin/env node
// The built-in agent: a small loop over an OpenAI-compatible /chat/completions
// with file tools on the project (cwd), for when no coding CLI is at hand. Runs
// one turn per call: the prompt on stdin, the conversation in
// .webai/agent/<session>.json, events as JSON lines on stdout (the shape the
// overlay's session expects: status, text, tool, tool-error, done).
//
// usage: webai-agent --session <id> [--resume] --base-url <url> --model <id>
//                    [--fallbacks a,b,c] [--system <text>]
// The key comes from WEBAI_API_KEY (or OPENROUTER_API_KEY for openrouter.ai).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const MAX_STEPS = 25;
const MAX_READ_BYTES = 200_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.webai', '.agents', '.codex', '.gemini', '.claude', '.vercel', '.netlify']);
const TEXT_EXT = /\.(astro|html?|css|scss|sass|less|m?[jt]sx?|json|ya?ml|toml|md|mdx|svg|txt|xml|webmanifest|vue|svelte)$/i;

function parseOpts(argv) {
  return parseArgs({
    args: argv,
    strict: false,
    options: {
      session: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      fallbacks: { type: 'string', default: '' },
      system: { type: 'string', default: '' },
    },
  }).values;
}

// Set per run by `runAgent`; the defaults are the real process.
let root = process.cwd();
let out;

const TOOLS = [
  tool('list_files', 'List the project files (without node_modules, dist and similar), optionally under a folder.', { dir: { type: 'string' } }),
  tool('search_files', 'Find lines matching a regular expression in the project text files. Returns path:line: text.', { pattern: { type: 'string' }, dir: { type: 'string' } }, ['pattern']),
  tool('read_file', 'Read a text file. Each line is prefixed with its number and a tab, which are not part of the content.', { path: { type: 'string' } }, ['path']),
  tool(
    'edit_file',
    'Replace an exact, unique piece of text in a file. Include enough surrounding text to make old_text unique.',
    { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
    ['path', 'old_text', 'new_text'],
  ),
  tool('write_file', 'Create or overwrite a whole text file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('delete_file', 'Delete a file.', { path: { type: 'string' } }, ['path']),
  tool(
    'search_images',
    'Search openly licensed photos and illustrations (Openverse; only ones that may be used on commercial sites and resized). Returns id, title, creator, license and size.',
    { query: { type: 'string', description: 'A few English words.' } },
    ['query'],
  ),
  tool(
    'add_image',
    "Save an image from search_images into the project (e.g. public/images/hero.jpg, or src/assets/ when the site uses astro:assets) and get an HTML snippet with its credit.",
    { id: { type: 'string' }, path: { type: 'string' } },
    ['id', 'path'],
  ),
];

const TOOL_LABELS = { list_files: 'LS', search_files: 'Grep', read_file: 'Read', edit_file: 'Edit', write_file: 'Write', delete_file: 'Delete', search_images: 'Search images', add_image: 'Add image' };

const TOOLS_PROMPT = `You work on a website project through these tools (no shell). Read a file
before editing it; keep edits minimal and in the style of the code around them.
Text and styles often live elsewhere than the element's own file: props from a
parent, content collections (src/content), data files (src/data, src/config).
For a new image: search_images, then add_image, and insert the snippet it returns
with its credit caption.`;

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

// ---------------------------------------------------------------- files

/** A path inside the project, or null (outside, hidden folders like .git, node_modules). */
export function inside(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(root, p.trim().replace(/^\/+/, ''));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((x) => SKIP_DIRS.has(x)) || parts.at(-1) === '.env' || parts.at(-1).startsWith('.env.')) return null;
  return { abs, rel: parts.join('/') };
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return files;
}

/**
 * Exact match first; then whole lines, ignoring indentation and quote style
 * (weaker models get those wrong), new_text re-indented to the file.
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
  const matched = fileLines.slice(starts[0], starts[0] + want.length);
  const width = (l) => l.match(/^\s*/)[0].replace(/\t/g, '  ').length;
  const unit = matched.find((l) => /^\t/.test(l)) ? '\t' : ' ';
  const pad = (n) => (unit === '\t' ? '\t'.repeat(Math.round(n / 2)) : ' '.repeat(n));
  const diffs = (oldLines.length > 1 ? oldLines.slice(1) : oldLines).map((l, j) => width(matched[j + (oldLines.length > 1)]) - width(l));
  const shift = diffs.sort((x, y) => diffs.filter((d) => d === y).length - diffs.filter((d) => d === x).length)[0];
  const byText = new Map(matched.map((l) => [norm(l), l]));
  const lines = newText.split('\n').map((l) => (l.trim() ? byText.get(norm(l)) ?? pad(Math.max(0, width(l) + shift)) + l.trim() : ''));
  return { count: 1, old: matched.join('\n'), new: lines.join('\n') };
}

// ---------------------------------------------------------------- images (Openverse, no key)

const images = new Map();

async function searchImages(query) {
  const url = `https://api.openverse.org/v1/images/?${new URLSearchParams({ q: query, page_size: '8', license_type: 'commercial,modification', mature: 'false' })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 429 ? 'Image search limit reached, try again later.' : `Image search failed (${res.status}).`);
  const found = ((await res.json()).results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    creator: r.creator,
    license: `${['cc0', 'pdm'].includes(r.license) ? r.license.toUpperCase() : `CC ${r.license.toUpperCase()}`} ${r.license_version ?? ''}`.trim(),
    size: r.width && r.height ? `${r.width}×${r.height}` : undefined,
    url: r.url,
    page: r.foreign_landing_url,
    thumbnail: r.thumbnail,
    credit: !['cc0', 'pdm'].includes(r.license),
  }));
  for (const f of found) images.set(f.id, f);
  return found;
}

function imageSnippet(src, image) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
  const credit = image.credit
    ? `\n  <figcaption>Photo: <a href="${esc(image.page ?? image.url)}">${esc(image.title)}</a>${image.creator ? ` by ${esc(image.creator)}` : ''}, ${esc(image.license)}</figcaption>`
    : '';
  return `<figure>\n  <img src="${esc(src)}" alt="${esc(image.title)}">${credit}\n</figure>`;
}

// ---------------------------------------------------------------- tools

async function execute(call) {
  const name = call.function?.name;
  let args;
  try {
    args = JSON.parse(call.function?.arguments || '{}');
  } catch {
    return fail('Arguments are not valid JSON.');
  }
  out({ type: 'tool', id: call.id, name: TOOL_LABELS[name] ?? name, summary: String(args.path ?? args.pattern ?? args.query ?? args.dir ?? '').slice(0, 160) });
  function fail(text) {
    out({ type: 'tool-error', id: call.id, text: `${TOOL_LABELS[name] ?? name}: ${text}` });
    return `Error: ${text}`;
  }
  const file = args.path === undefined ? null : inside(args.path);
  if (args.path !== undefined && !file) return fail(`Not a project path: ${args.path}`);
  try {
    switch (name) {
      case 'list_files': {
        const base = args.dir ? inside(args.dir) : { abs: root };
        if (!base) return fail(`Not a project folder: ${args.dir}`);
        return walk(base.abs).sort().join('\n') || '(empty)';
      }
      case 'search_files': {
        const re = new RegExp(args.pattern, 'i');
        const base = args.dir ? inside(args.dir) : { abs: root };
        if (!base) return fail(`Not a project folder: ${args.dir}`);
        const hits = [];
        for (const rel of walk(base.abs).filter((f) => TEXT_EXT.test(f))) {
          fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
            if (hits.length < 100 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return hits.join('\n') || 'No matches.';
      }
      case 'read_file': {
        if (!fs.existsSync(file.abs)) return fail(`No such file: ${file.rel}`);
        if (!TEXT_EXT.test(file.rel)) return `Binary or non-text file (${fs.statSync(file.abs).size} bytes). Reference it by its path.`;
        const text = fs.readFileSync(file.abs, 'utf8');
        if (text.length > MAX_READ_BYTES) return fail(`File too large to read (${text.length} chars).`);
        return text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      }
      case 'edit_file': {
        if (!fs.existsSync(file.abs)) return fail(`No such file: ${file.rel}`);
        const text = fs.readFileSync(file.abs, 'utf8');
        if (!args.old_text) return fail('old_text is empty.');
        const edit = matchEdit(text, args.old_text, args.new_text ?? '');
        if (edit.count === 0) return fail('old_text not found. Read the file again and copy the text exactly.');
        if (edit.count > 1) return fail(`old_text occurs ${edit.count} times. Include more surrounding text.`);
        fs.writeFileSync(file.abs, text.replace(edit.old, () => edit.new));
        return 'OK';
      }
      case 'write_file': {
        if (!TEXT_EXT.test(file.rel)) return fail('Only text files (source, styles, content, config).');
        fs.mkdirSync(path.dirname(file.abs), { recursive: true });
        fs.writeFileSync(file.abs, String(args.content ?? ''));
        return 'OK';
      }
      case 'delete_file': {
        if (!fs.existsSync(file.abs)) return fail(`No such file: ${file.rel}`);
        fs.rmSync(file.abs);
        return 'OK';
      }
      case 'search_images': {
        const found = await searchImages(String(args.query ?? ''));
        if (!found.length) return 'No images found. Try other, more general words.';
        return JSON.stringify(found.map(({ id, title, creator, license, size }) => ({ id, title, creator, license, size })));
      }
      case 'add_image': {
        const image = images.get(args.id);
        if (!image) return fail('Unknown id. Use an id from search_images (in this message).');
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(file.rel)) return fail('Use a path like public/images/name.jpg.');
        let data;
        for (const url of [image.url, image.thumbnail]) {
          const res = await fetch(url).catch(() => null);
          const buf = res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
          if (buf && buf.length <= MAX_IMAGE_BYTES) {
            data = buf;
            break;
          }
        }
        if (!data) return fail('This image could not be downloaded. Pick another one.');
        fs.mkdirSync(path.dirname(file.abs), { recursive: true });
        fs.writeFileSync(file.abs, data);
        const src = file.rel.startsWith('public/') ? `/${file.rel.slice('public/'.length)}` : file.rel;
        return `Saved ${file.rel} (${Math.round(data.length / 1024)} kB). Insert this (for src/assets, import the file and use <Image> instead):\n${imageSnippet(src, image)}`;
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err.message);
  }
}

// ---------------------------------------------------------------- the loop

function apiError(status, data) {
  const detail = data?.error?.message ?? data?.message ?? '';
  if (status === 401) return `The provider rejected the key (401). Set WEBAI_API_KEY (or OPENROUTER_API_KEY) where the dev server runs. ${detail}`.trim();
  if (status === 429) return `The provider is rate limiting requests (429), try again in a moment. ${detail}`.trim();
  return `API error ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600);
}

/** After a stop mid-turn: every tool call gets a result, or the API refuses the conversation. */
function repaired(messages) {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  return messages.flatMap((m) => [m, ...(m.tool_calls ?? []).filter((c) => !answered.has(c.id)).map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'Error: interrupted.' }))]);
}

async function main(opts, env, readPrompt) {
  const baseUrl = (opts['base-url'] ?? '').replace(/\/$/, '');
  if (!baseUrl || !opts.model || !opts.session) throw new Error('usage: webai-agent --session <id> --base-url <url> --model <id> < prompt');
  const key = env.WEBAI_API_KEY || (baseUrl.includes('openrouter.ai') ? env.OPENROUTER_API_KEY : '') || '';
  const store = path.join(root, '.webai', 'agent', `${opts.session.replace(/[^\w-]/g, '')}.json`);
  const messages = opts.resume && fs.existsSync(store) ? repaired(JSON.parse(fs.readFileSync(store, 'utf8'))) : [];
  const save = () => {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(messages));
  };
  const prompt = readPrompt();
  messages.push({ role: 'user', content: prompt });
  const system = [opts.system, TOOLS_PROMPT].filter(Boolean).join('\n\n');
  const fallbacks = opts.fallbacks.split(',').map((m) => m.trim()).filter(Boolean);
  let model = opts.model;
  let costUsd = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let msg;
    const candidates = [model, ...fallbacks.filter((m) => m !== model)];
    for (const candidate of candidates) {
      if (candidate !== model) out({ type: 'status', text: `${model} is busy, switching to ${candidate}…` });
      model = candidate;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), 'X-Title': 'webai' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: TOOLS,
          tool_choice: 'auto',
          ...(baseUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      msg = res.ok ? data.choices?.[0]?.message : null;
      if (msg) {
        costUsd += data.usage?.cost ?? 0;
        break;
      }
      const busy = res.status >= 500 || (res.status === 429 && /upstream|overload|temporarily/i.test(JSON.stringify(data)));
      if (!res.ok && !busy) throw new Error(apiError(res.status, data));
      if (candidate === candidates.at(-1)) throw new Error(res.ok ? 'The model returned no response.' : apiError(res.status, data));
    }
    const calls = msg.tool_calls ?? [];
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (msg.content?.trim()) out({ type: 'text', text: msg.content.trim() });
    if (!calls.length) {
      save();
      out({ type: 'done', ok: true, costUsd });
      return;
    }
    for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: await execute(call) });
    save();
  }
  save();
  out({ type: 'done', ok: false, error: `The agent didn't finish within ${MAX_STEPS} steps.`, costUsd });
}

/** One turn. Injectable for tests: argv, working folder, environment, prompt reader and event writer. */
export async function runAgent(argv = process.argv.slice(2), io = {}) {
  const { cwd = process.cwd(), env = process.env, readPrompt = () => fs.readFileSync(0, 'utf8'), write = (s) => process.stdout.write(s) } = io;
  const saved = { root, out };
  root = cwd;
  out = (ev) => write(`${JSON.stringify(ev)}\n`);
  let code = 0;
  try {
    await main(parseOpts(argv), env, readPrompt);
  } catch (err) {
    out({ type: 'done', ok: false, error: err.message });
    code = 1;
  }
  ({ root, out } = saved);
  return code;
}

// Only true when executed as a script (covered by the child-process test, which node's coverage does not see).
/* node:coverage ignore next 3 */
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  runAgent().then((code) => { process.exitCode = code; });
}
