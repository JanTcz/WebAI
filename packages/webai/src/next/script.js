// No import from the rest of the package: this file ends up in the page's bundle.
import { createElement } from 'react';

/**
 * The overlay's script for the root layout (`app/layout`, inside `<body>`) or
 * `pages/_document`. Renders nothing outside `next dev`.
 */
export function WebaiScript() {
  if (process.env.NODE_ENV !== 'development') return null;
  return createElement('script', { type: 'module', src: '/__webai/boot.js', async: true });
}

export default WebaiScript;
