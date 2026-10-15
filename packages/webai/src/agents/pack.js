import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pack of skills and subagents (`@jantcz/webai/agents`), shared by all CLIs. */
export const PACK_DIR = fileURLToPath(new URL('../../agents/', import.meta.url));

/**
 * Codex and Gemini look for skills only in the project (`.agents/skills/`), not in
 * an arbitrary folder, so we link them there. An existing file with the same name
 * is not overwritten, it belongs to the user.
 *
 * @returns {string[]} relative paths of newly created links
 */
export function linkSkills(root, targetDir = '.agents/skills') {
  const created = [];
  const src = path.join(PACK_DIR, 'skills');
  for (const name of fs.readdirSync(src)) {
    const dest = path.join(root, targetDir, name);
    if (exists(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(relativeTo(dest, path.join(src, name)), dest, 'dir');
    created.push(path.relative(root, dest));
  }
  return created;
}

/** Subagents in Markdown + frontmatter format (Claude Code, Gemini CLI). */
export function linkMarkdownAgents(root, targetDir) {
  const created = [];
  for (const { file } of readAgents()) {
    const dest = path.join(root, targetDir, path.basename(file));
    if (exists(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(relativeTo(dest, file), dest);
    created.push(path.relative(root, dest));
  }
  return created;
}

/** Codex wants subagents in TOML (`name`, `description`, `developer_instructions`). */
export function writeCodexAgents(root, targetDir = '.codex/agents') {
  const created = [];
  for (const { name, description, body } of readAgents()) {
    const dest = path.join(root, targetDir, `${name}.toml`);
    if (exists(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const toml = [
      '# Generated from @jantcz/webai/agents, edit the source there.',
      `name = ${tomlString(name)}`,
      `description = ${tomlString(description)}`,
      `developer_instructions = ${tomlString(body)}`,
      '',
    ].join('\n');
    fs.writeFileSync(dest, toml);
    created.push(path.relative(root, dest));
  }
  return created;
}

function readAgents() {
  const dir = path.join(PACK_DIR, 'agents');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = path.join(dir, f);
      const text = fs.readFileSync(file, 'utf8');
      const [, front = '', body = text] = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ?? [];
      const field = (key) => front.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
      return { file, name: field('name') || path.basename(f, '.md'), description: field('description'), body: body.trim() };
    });
}

/** A JSON string is a valid TOML basic string (escapes \n, \", \\, \uXXXX). */
export function tomlString(s) {
  return JSON.stringify(s);
}

/**
 * A relative link works in a container and in another clone of the repo too. It is
 * computed from the folder's real path: if the path to the project goes through a symlink,
 * the system resolves ".." from the symlink target, not from the path we gave.
 */
function relativeTo(link, target) {
  return path.relative(fs.realpathSync(path.dirname(link)), fs.realpathSync(target));
}

/** Exists, or is a link that still points somewhere. A broken link gets replaced. */
function exists(p) {
  try {
    fs.lstatSync(p);
  } catch {
    return false;
  }
  if (fs.existsSync(p)) return true;
  fs.rmSync(p, { force: true });
  return false;
}
