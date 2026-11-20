import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanElement, failure, MAX_TABS, PageHub } from '../src/pages.js';

const rejects = (p, re) => assert.rejects(p, re);

test('pages: ids are validated, a tab is created on first sight', () => {
  const h = new PageHub();
  for (const bad of [undefined, '', 'a b', 'x'.repeat(65), 5]) assert.throws(() => h.tab(bad), /tab is an id/);
  assert.equal(PageHub.validId('ab_c-1'), true);
  assert.equal(h.tab('a'), h.tab('a'));
  assert.equal(failure('x').status, 400);
});

test('pages: hello records the page, reports a changed origin once, touches only visible tabs', () => {
  const origins = [];
  const h = new PageHub({ onOrigin: (o) => origins.push(o) });
  h.hello({ tab: 'a', url: 'http://x/a', title: 'A', nav: 2, origin: 'http://x', viewport: { width: 800, height: 600 }, visible: true });
  h.hello({ tab: 'b', url: 5, viewport: 'wide', origin: 'http://x' });
  h.hello({ tab: 'c', origin: 'http://y', nav: 'many' });
  assert.deepEqual(origins, ['http://x', 'http://y']);
  assert.equal(h.tabs.get('a').nav, 2);
  assert.deepEqual(h.tabs.get('a').viewport, { width: 800, height: 600 });
  assert.equal(h.tabs.get('b').url, undefined);
  assert.equal(h.tabs.get('b').viewport, undefined);
  assert.equal(h.tabs.get('c').nav, 0);
  assert.ok(h.tabs.get('a').touched > 0 && h.tabs.get('b').touched === 0);
  new PageHub().hello({ tab: 'z' }); // no onOrigin callback, no origin: nothing to report
  new PageHub().hello({ tab: 'z', origin: 'http://q' }); // callback is optional
});

test('pages: the active tab is the connected one used last', () => {
  const h = new PageHub();
  assert.throws(() => h.resolve(), /No page with the WebAI overlay/);
  assert.deepEqual(h.list(), []);
  h.hello({ tab: 'a', visible: true });
  h.hello({ tab: 'b', visible: true });
  assert.equal(h.resolve().id, 'b');
  h.focus('a');
  assert.equal(h.resolve().id, 'a');
  h.attach('b', () => {}); // a connected tab beats a more recently touched one that is not
  assert.equal(h.resolve().id, 'b');
  assert.equal(h.resolve('a').id, 'a');
  assert.throws(() => h.resolve('nope'), /No tab nope/);
  const list = h.list();
  assert.equal(list.find((t) => t.tab === 'b').active, true);
  assert.equal(list.find((t) => t.tab === 'b').connected, true);
  assert.equal(list.find((t) => t.tab === 'a').connected, false);
});

test('pages: selection is cleaned, null clears it, a bad one is ignored', () => {
  const h = new PageHub();
  h.selection('a', { src: 'a.astro:1:1', tag: '<p>', chain: ['x', 5, 'y'], html: '<p/>', exact: true, evil: 'dropped' }, { url: '/p', title: 'T' });
  const t = h.tabs.get('a');
  assert.deepEqual(t.selection.chain, ['x', 'y']);
  assert.equal(t.selection.evil, undefined);
  assert.deepEqual(t.selectionPage, { url: '/p', title: 'T' });
  assert.equal(h.list()[0].selected, 'a.astro:1:1');
  h.selection('a', { selector: '#x' }, 'not an object');
  assert.equal(h.tabs.get('a').selectionPage, undefined);
  assert.equal(h.list()[0].selected, '#x');
  h.selection('a', null);
  assert.equal(h.tabs.get('a').selection, null);
  assert.equal(h.list()[0].selected, null);
  assert.equal(cleanElement('x'), null);
  assert.equal(cleanElement({ chain: 'no' }).chain, undefined);
  assert.equal(cleanElement({ exact: 'yes' }).exact, undefined);
});

test('pages: log keeps valid entries, caps the buffer, falls back for unknown level and kind', () => {
  const h = new PageHub({ maxLog: 3 });
  h.hello({ tab: 'a', nav: 4 });
  h.log('a', [
    { text: 'one', level: 'warn', kind: 'network', stack: 's', nav: 1 },
    { text: 'two', level: 'loud', kind: 'weird' },
    null,
    { text: 5 },
    { text: 'x'.repeat(5000) },
    { text: 'four' },
  ]);
  const logs = h.tabs.get('a').logs;
  assert.equal(logs.length, 3);
  assert.equal(logs[0].text, 'two');
  assert.equal(logs[0].level, 'log');
  assert.equal(logs[0].kind, 'console');
  assert.equal(logs[0].nav, 4);
  assert.equal(logs[1].text.length, 4000);
  assert.throws(() => h.log('a', 'nope'), /entries is a list/);
});

test('pages: at most MAX_TABS, the oldest unconnected one goes first, connected ones stay', () => {
  const h = new PageHub();
  h.attach('keep', () => {});
  for (let i = 0; i < MAX_TABS + 3; i++) h.hello({ tab: `t${i}`, visible: true });
  assert.equal(h.tabs.size, MAX_TABS);
  assert.ok(h.tabs.has('keep'));
  assert.ok(!h.tabs.has('t0'));
  const all = new PageHub();
  for (let i = 0; i < MAX_TABS + 2; i++) all.attach(`c${i}`, () => {});
  assert.equal(all.tabs.size, MAX_TABS + 2); // nothing to drop: all connected
});

test('pages: attach/detach, and a late detach of an old stream does not close the new one', () => {
  const h = new PageHub();
  const a = () => {};
  const b = () => {};
  const detachA = h.attach('t', a);
  h.attach('t', b);
  detachA();
  assert.equal(h.tabs.get('t').send, b);
  h.tabs.get('t').send = null;
});

test('pages: a command goes to the page and resolves with its answer', async () => {
  const h = new PageHub();
  const sent = [];
  h.attach('t', (c) => sent.push(c));
  const p = h.command('t', 'query', { selector: 'p' });
  assert.deepEqual(sent, [{ id: '1', cmd: 'query', args: { selector: 'p' } }]);
  assert.equal(h.result('other', { id: '1', ok: true }), false); // from another tab
  assert.equal(h.result('t', { id: 99, ok: true }), false); // nobody waits
  assert.equal(h.result('t', { id: 1, ok: true, data: { n: 1 } }), true);
  assert.deepEqual(await p, { n: 1 });
  const bad = h.command('t', 'info');
  h.result('t', { id: '2', ok: false, error: 'boom' });
  await rejects(bad, /boom/);
  const vague = h.command('t', 'info');
  h.result('t', { id: '3', ok: false });
  await rejects(vague, /The page reported an error/);
  assert.equal(h.pending.size, 0);
});

test('pages: a command fails fast without a connection, times out, and is rejected on dispose', async () => {
  const h = new PageHub({ timeoutMs: 20 });
  h.hello({ tab: 't', visible: true });
  await rejects(h.command('t', 'info'), /not connected/);
  h.attach('t', () => {});
  await rejects(h.command('t', 'info'), /did not answer in 0.02 s/);
  assert.equal(h.pending.size, 0);
  const slow = new PageHub({ timeoutMs: 5000 });
  slow.attach('t', () => {});
  const p = slow.command('t', 'info');
  slow.dispose();
  await rejects(p, /shutting down/);
});
