import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** "Features" cards. The schema keeps the copy short and prevents an empty card. */
const features = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/features' }),
  schema: z.object({
    order: z.number().int().min(1).max(99),
    title: z.string().min(3).max(40),
    description: z.string().min(60).max(260),
  }),
});

export const collections = { features };
