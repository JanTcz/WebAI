import type { Plugin } from 'vite';
import type { WebAiOptions } from './index';

/** Vite plugin, only in `vite dev`. `root`: the project the agent edits, default Vite's root. */
export default function webai(options?: WebAiOptions & { root?: string }): Plugin;
