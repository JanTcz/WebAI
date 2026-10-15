/**
 * Acceptance suite over the generated dist/: tests what the visitor gets,
 * not the sources. Mainly guards that the webai integration leaks nothing into the build.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
if (!existsSync(DIST)) throw new Error('dist/ does not exist. Run "npm run build" first.');

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const ALL = walk(DIST);
const FEATURES = readdirSync(join(ROOT, 'src/content/features')).filter((f) => f.endsWith('.md')).length;

describe('webai in the build', () => {
  test('no JavaScript', () => {
    assert.deepEqual(ALL.filter((f) => extname(f) === '.js').map((f) => f.replace(DIST, 'dist')), []);
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html), 'The HTML contains a <script>.');
  });

  test('no source-path attributes and no mention of the overlay', () => {
    for (const f of ALL.filter((f) => extname(f) === '.html')) {
      const doc = readFileSync(f, 'utf8');
      assert.ok(!doc.includes('data-webai-src'), `${f}: data-webai-src in the build.`);
      assert.ok(!doc.includes('__webai'), `${f}: reference to /__webai in the build.`);
    }
  });
});

describe('Content', () => {
  test('all cards from the content collection are on the page', () => {
    const n = (html.match(/<li class="feature"/g) ?? []).length;
    assert.equal(n, FEATURES);
  });

  test('exactly one H1 and the heading hierarchy skips no level', () => {
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i++) {
      assert.ok(levels[i] <= levels[i - 1] + 1, `H${levels[i - 1]} → H${levels[i]}`);
    }
  });

  test('anchor links point to existing ids', () => {
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(anchors.length > 0);
    for (const id of anchors) assert.ok(html.includes(`id="${id}"`), `#${id} does not exist.`);
  });

  test('meta description is 120 to 170 characters', () => {
    const m = html.match(/<meta name="description" content="([^"]+)"/);
    assert.ok(m, 'Missing meta description.');
    assert.ok(m[1].length >= 120 && m[1].length <= 170, `It has ${m[1].length} characters.`);
  });
});
