import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt.js';

test('prompt: no element is just the message', () => {
  assert.equal(buildPrompt({ message: 'hi' }), 'hi');
});

test('prompt: minimal element', () => {
  assert.equal(buildPrompt({ message: 'go', element: { tag: 'p' } }), '[Selected element]\nelement: p\n\n[Request]\ngo');
});

test('prompt: full element and page', () => {
  const out = buildPrompt({
    message: 'make it red',
    page: { url: 'http://x/', title: 'Home' },
    element: { src: 'a.html:1:2', chain: ['div', 'main'], testId: 't', tag: 'h1', selector: 'h1.a', text: 'He"llo', html: '<h1>x</h1>' },
  });
  assert.equal(
    out,
    [
      '[Selected element]',
      'page: http://x/ (“Home”)',
      'source: a.html:1:2',
      'inside: div ← main',
      'data-testid: t',
      'element: h1',
      'selector: h1.a',
      'text: "He\\"llo"',
      'html:',
      '```html',
      '<h1>x</h1>',
      '```',
      '',
      '[Request]',
      'make it red',
    ].join('\n'),
  );
  assert.match(buildPrompt({ message: 'm', page: { url: 'u' }, element: { tag: 'a', chain: [] } }), /^\[Selected element\]\npage: u\nelement: a/);
});
