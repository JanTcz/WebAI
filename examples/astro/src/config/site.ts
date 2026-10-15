/** Single source of truth for the site: name, description and links are not written anywhere else. */
export const site = {
  name: 'webai',
  title: 'webai | click an element on your site and tell the AI what to change',
  description:
    'Shift+click any element to chat with an AI agent that edits your source files directly. Any dev server: Astro, Vite, Next.js, static HTML. Your own coding CLI.',
  repo: 'https://github.com/JanTcz/WebAI',
} as const;

// Fail the build before a truncated or overlong description ends up in the output.
if (site.description.length < 120 || site.description.length > 170) {
  throw new Error(`site.description has ${site.description.length} characters, allowed 120 to 170.`);
}
