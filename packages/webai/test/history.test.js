import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { History } from '../src/history.js';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-history-'));
  fs.mkdirSync(path.join(root, '.webai'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'dependency');
  return root;
}
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const write = (root, f, s) => fs.writeFileSync(path.join(root, f), s);

test('history: back and forward through versions, your edits kept', () => {
  const root = project();
  const h = new History(root, path.join(root, '.webai'));
  write(root, 'index.html', 'one');
  assert.equal(h.snapshot('Start').current, 0);
  assert.equal(h.snapshot('nothing changed'), null);
  write(root, 'index.html', 'two');
  write(root, 'new.css', 'a {}');
  assert.equal(h.snapshot('Make it two').current, 1);

  h.restore(0);
  assert.equal(read(root, 'index.html'), 'one');
  assert.equal(fs.existsSync(path.join(root, 'new.css')), false);
  assert.equal(read(root, 'node_modules/x.js'), 'dependency'); // left alone

  h.restore(1);
  assert.equal(read(root, 'index.html'), 'two');
  assert.equal(read(root, 'new.css'), 'a {}');

  // Edits by hand before going back become a version of their own at the end.
  write(root, 'index.html', 'by hand');
  const list = h.restore(0);
  assert.deepEqual(list.versions.map((v) => v.label), ['Start', 'Make it two', 'Your edits']);
  h.restore(2);
  assert.equal(read(root, 'index.html'), 'by hand');

  // After going back, a new answer drops the versions after the current one.
  h.restore(0);
  write(root, 'index.html', 'three');
  assert.deepEqual(h.snapshot('Make it three').versions.map((v) => v.label), ['Start', 'Make it three']);

  // The state survives a restart.
  assert.equal(new History(root, path.join(root, '.webai')).list().current, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('history: without git there is no history', () => {
  const root = project();
  const path_ = process.env.PATH;
  let h;
  process.env.PATH = '';
  try {
    h = new History(root, path.join(root, '.webai'));
  } finally {
    process.env.PATH = path_;
  }
  assert.equal(h.enabled, false);
  assert.equal(h.snapshot('x'), null);
  assert.throws(() => h.restore(0), /git is not available/);
  assert.deepEqual(h.list(), { enabled: false, current: -1, versions: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

test('history: restore validates the index and skips the edits version when nothing changed', () => {
  const root = project();
  const h = new History(root, path.join(root, '.webai'));
  write(root, 'a.txt', '1');
  h.snapshot(''); // label falls back to "version" in the commit
  assert.throws(() => h.restore(5), /No version 5/);
  assert.equal(h.restore(0).versions.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('history: keeps at most 200 versions, dropping the oldest', () => {
  const root = project();
  const dir = path.join(root, '.webai');
  const first = new History(root, dir);
  write(root, 'a.txt', '1');
  first.snapshot('real');
  const real = first.state.versions[0];
  const fake = Array.from({ length: 199 }, (_, i) => ({ sha: 'x', tree: 'x', label: `old ${i}`, ts: 0 }));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ versions: [...fake, real], current: 199 }));
  const h = new History(root, dir);
  write(root, 'a.txt', '2');
  const list = h.snapshot('newest');
  assert.equal(list.versions.length, 200);
  assert.equal(list.current, 199);
  assert.equal(list.versions[0].label, 'old 1');
  assert.equal(list.versions[199].label, 'newest');
  fs.rmSync(root, { recursive: true, force: true });
});
