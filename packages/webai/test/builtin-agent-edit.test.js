import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inside, matchEdit } from '../bin/webai-agent.js';

const apply = (text, o, n) => {
  const e = matchEdit(text, o, n);
  return e.count === 1 ? text.replace(e.old, () => e.new) : e;
};

test('matchEdit: exact, empty and ambiguous matches', () => {
  assert.deepEqual(matchEdit('a b a', 'a', 'z'), { count: 2, old: 'a', new: 'z' });
  assert.deepEqual(matchEdit('a', '\n  \n', 'z'), { count: 0 });
  assert.equal(matchEdit('  x\n  x\n', ' x ', 'y').count, 2);
  assert.equal(matchEdit('x\n', 'nothing', 'y').count, 0);
});

test('matchEdit: re-indents spaces, reuses known lines, drops blank lines edges', () => {
  const src = 'a\n    <div>\n      <p>1</p>\n    </div>\nb\n';
  // old text indented less than the file; new text gets the file's shift; "<p>1</p>" is kept as in file
  const out = apply(src, '\n<div>\n  <p>1</p>\n</div>\n\n', '<div>\n  <p>1</p>\n\n  <span>2</span>\n</div>');
  assert.equal(out, 'a\n    <div>\n      <p>1</p>\n\n      <span>2</span>\n    </div>\nb\n');
});

test('matchEdit: single line, tabs, and unequal shifts', () => {
  assert.equal(apply('\t\tfoo(“a”)\n', 'foo("a")', 'bar("a")\nbaz()'), '\t\tbar("a")\n\t\tbaz()\n');
  assert.equal(apply('x\n\t<b>\n\t\t<i>\n\t</b>\n', '<b>\n<i>\n</b>', '<b>\n<i>\n<u>\n</b>').includes('<u>'), true);
});

test('inside: rejects non-strings, blanks, the root itself and .env files', () => {
  for (const bad of [null, undefined, 5, '', '   ', '.', 'a/.env', 'a/.env.production', 'x/.git/y']) assert.equal(inside(bad), null, String(bad));
  assert.equal(inside('  src/a.css ').rel, 'src/a.css');
  assert.equal(inside('.envrc').rel, '.envrc');
});
