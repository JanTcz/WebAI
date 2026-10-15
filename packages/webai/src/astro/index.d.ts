import type { AstroIntegration } from 'astro';
import type { WebAiOptions } from '../index';

/** Astro integration, only in `astro dev`. */
export default function webai(options?: WebAiOptions): AstroIntegration;
