import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Coverage counts only the files a test loads: load them all, so none is missed.
// The overlay (src/client/) runs in the browser and is left out.
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'client' ? [] : files(p);
  return e.name.endsWith('.js') ? [p] : [];
});

test('every module of the core loads', async () => {
  const all = [...files(path.join(pkg, 'src')), ...files(path.join(pkg, 'bin'))].filter((f) => !f.endsWith('/next/script.js'));
  for (const f of all.filter((f) => !f.includes(`${path.sep}bin${path.sep}`))) assert.ok(await import(pathToFileURL(f).href), f);
});
