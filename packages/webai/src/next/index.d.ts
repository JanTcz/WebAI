import type { WebAiOptions } from '../index';

/** Only in `next dev`. `port`: the overlay's server beside Next.js, default 4399. */
export function withWebai<C extends object>(
  nextConfig?: C | ((phase: string, ctx: object) => C | Promise<C>),
  options?: WebAiOptions & { port?: number },
): (phase: string, ctx: object) => Promise<C>;
export const DEFAULT_PORT: number;
