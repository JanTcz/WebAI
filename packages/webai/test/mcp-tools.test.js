import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { PageHub } from '../src/pages.js';

function setup() {
  const pages = new PageHub({ timeoutMs: 200 });
  const sent = [];
  pages.hello({ tab: 't', url: 'http://x/', title: 'X', visible: true });
  pages.attach('t', (c) => sent.push(c));
  return { session: { pages, history: { list: () => ({ enabled: true, current: 0, versions: [] }) } }, pages, sent };
}
const call = (s, name, args) => callTool(s.session, name, args);

test('tools: every tool has a name, a description and an object schema', () => {
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  for (const t of TOOLS) assert.ok(t.name.startsWith('webai_') && t.description.length > 40 && t.inputSchema.type === 'object');
});

test('tools: unknown tool and non-object arguments are refused', async () => {
  const s = setup();
  await assert.rejects(call(s, 'nope', {}), (e) => e.status === 404);
  await assert.rejects(call(s, 'webai_history', []), /arguments is an object/);
  await assert.rejects(call(s, 'webai_history', 'x'), /arguments is an object/);
  assert.deepEqual(await call(s, 'webai_history', null), { enabled: true, current: 0, versions: [] });
});

test('tools: webai_get_selection returns the pick, or says nothing is selected', async () => {
  const s = setup();
  const none = await call(s, 'webai_get_selection');
  assert.equal(none.element, null);
  assert.match(none.hint, /Shift\+click/);
  s.pages.selection('t', { src: 'a.astro:3:1', selector: 'h1', text: 'Hi' }, { url: '/', title: 'X' });
  const got = await call(s, 'webai_get_selection', { tab: 't' });
  assert.equal(got.element.src, 'a.astro:3:1');
  assert.deepEqual(got.page, { url: '/', title: 'X' });
  assert.match(got.selectedAgo, /^\d+s ago$/);
  await assert.rejects(call(s, 'webai_get_selection', { tab: 'zz' }), /No tab zz/);
  await assert.rejects(call(s, 'webai_get_selection', { tab: 5 }), /tab is a non-empty string/);
  await assert.rejects(call(s, 'webai_get_selection', { tab: '' }), /tab is a non-empty string/);
});

test('tools: webai_console filters by level, kind, age and limit; oldest first', async () => {
  const s = setup();
  s.pages.log('t', [
    { text: 'd', level: 'debug' },
    { text: 'l', level: 'log' },
    { text: 'w', level: 'warn', stack: 'st' },
    { text: 'boom', level: 'error', kind: 'error' },
    { text: 'GET /x → 404', level: 'error', kind: 'network' },
  ]);
  const all = await call(s, 'webai_console');
  assert.deepEqual(all.entries.map((e) => e.text), ['l', 'w', 'boom', 'GET /x → 404']);
  assert.equal(all.matching, 4);
  assert.equal(all.url, 'http://x/');
  assert.equal(all.entries[1].stack, 'st');
  assert.match(all.entries[0].age, /s ago$/);
  assert.equal((await call(s, 'webai_console', { level: 'debug' })).matching, 5);
  assert.deepEqual((await call(s, 'webai_console', { level: 'error', kind: 'network' })).entries.map((e) => e.text), ['GET /x → 404']);
  assert.equal((await call(s, 'webai_console', { limit: 2 })).entries.length, 2);
  assert.equal((await call(s, 'webai_console', { limit: 2 })).matching, 4);
  assert.equal((await call(s, 'webai_console', { since_seconds: 60 })).matching, 4);
  s.pages.tabs.get('t').logs.forEach((e) => (e.at -= 120000));
  const old = await call(s, 'webai_console', { since_seconds: 60 });
  assert.equal(old.matching, 0);
  assert.match((await call(s, 'webai_console')).entries[0].age, /^2m \d+s ago$/);
  await assert.rejects(call(s, 'webai_console', { level: 'loud' }), /level is/);
  await assert.rejects(call(s, 'webai_console', { kind: 'x' }), /kind is/);
  await assert.rejects(call(s, 'webai_console', { limit: 0 }), /limit is an integer/);
  await assert.rejects(call(s, 'webai_console', { limit: 1.5 }), /limit is an integer/);
  await assert.rejects(call(s, 'webai_console', { since_seconds: 'a' }), /since_seconds/);
});

test('tools: webai_query_dom validates, sends the command, returns the page\'s answer', async () => {
  const s = setup();
  const p = call(s, 'webai_query_dom', { selector: 'nav a', limit: 2, styles: ['color', 'font-size'] });
  assert.deepEqual(s.sent[0].args, { selector: 'nav a', limit: 2, styles: ['color', 'font-size'] });
  s.pages.result('t', { id: s.sent[0].id, ok: true, data: { count: 5, elements: [] } });
  assert.deepEqual(await p, { count: 5, elements: [] });
  const d = call(s, 'webai_query_dom', { selector: 'p' });
  assert.deepEqual(s.sent[1].args, { selector: 'p', limit: 3, styles: undefined });
  s.pages.result('t', { id: s.sent[1].id, ok: true, data: {} });
  await d;
  await assert.rejects(call(s, 'webai_query_dom', {}), /selector is a non-empty string/);
  await assert.rejects(call(s, 'webai_query_dom', { selector: 'x'.repeat(601) }), /selector is a non-empty string/);
  await assert.rejects(call(s, 'webai_query_dom', { selector: 'p', limit: 11 }), /limit is an integer/);
  await assert.rejects(call(s, 'webai_query_dom', { selector: 'p', styles: 'color' }), /styles is a list/);
  await assert.rejects(call(s, 'webai_query_dom', { selector: 'p', styles: ['a;b'] }), /styles is a list/);
  await assert.rejects(call(s, 'webai_query_dom', { selector: 'p', styles: Array(21).fill('color') }), /styles is a list/);
});

test('tools: webai_page_info lists tabs with live details, and survives a silent page', async () => {
  const s = setup();
  const p = call(s, 'webai_page_info');
  s.pages.result('t', { id: s.sent[0].id, ok: true, data: { url: 'http://x/now' } });
  const info = await p;
  assert.equal(info.selectedTab, 't');
  assert.equal(info.tabs[0].active, true);
  assert.deepEqual(info.live, { url: 'http://x/now' });
  const silent = await call(s, 'webai_page_info'); // no answer: timeout is reported, not thrown
  assert.match(silent.live.unavailable, /did not answer/);
  s.pages.tabs.get('t').send = null;
  assert.equal((await call(s, 'webai_page_info')).live, null);
});

test('tools: with no page at all the tools say what to do', async () => {
  const s = { session: { pages: new PageHub(), history: { list: () => ({}) } } };
  await assert.rejects(call(s, 'webai_console'), (e) => e.status === 404 && /Open the site/.test(e.message));
});
