// Shared with the web demo (demo/): no Node dependencies.

/** Message for the agent: the selected element (file:line, selector, text, HTML) and the request. */
export function buildPrompt({ message, element, page }) {
  if (!element) return message;
  const lines = ['[Selected element]'];
  if (page) lines.push(`page: ${page.url}${page.title ? ` (“${page.title}”)` : ''}`);
  if (element.src) lines.push(`source: ${element.src}`);
  if (element.chain?.length) lines.push(`inside: ${element.chain.join(' ← ')}`);
  if (element.testId) lines.push(`data-testid: ${element.testId}`);
  lines.push(`element: ${element.tag}`);
  if (element.selector) lines.push(`selector: ${element.selector}`);
  if (element.text) lines.push(`text: ${JSON.stringify(element.text)}`);
  if (element.html) lines.push('html:', '```html', element.html, '```');
  lines.push('', '[Request]', message);
  return lines.join('\n');
}
