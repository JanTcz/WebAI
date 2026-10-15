---
name: element-edit
description: Use when a request comes from the webai overlay with a [Selected element] block (selector, text, html, and a source file:line:col when the framework provides one). Explains how to find where the element's content and styles really live and how to make a minimal, safe edit.
---

# Editing an element selected in the overlay

The message starts with a `[Selected element]` block: the CSS selector, the
element's text and an HTML excerpt. With Astro and static HTML it also has
`source: <file>:LINE:COLUMN`, the location of the element's opening tag.

## Finding the element

1. **With `source:`** open that file at that line. `inside:` lists the files
   the component is nested in (parents), which helps when the props passed in
   need to change.
2. **Without `source:`** (React, Vue, Svelte, Next.js, server templates) search
   the sources for the most specific piece first: a distinctive phrase of the
   text, then class names from the selector or the HTML, then the component
   structure around it. Ignore build output. If several places match, pick the
   one whose surrounding markup matches the HTML excerpt.

## Where the content really lives

**The text is often not in the template.** When the element renders an
expression (`{…}` in Astro/JSX/Svelte, `{{ … }}` in Vue and most server
templates), find the source:
- props → where the component is used (`inside:` or grep for the component name),
- the same file's script part (Astro frontmatter `---`, `<script setup>`, top of a JSX module),
- content and data folders (`src/content/**`, Markdown with frontmatter, `src/data/**`,
  `src/config/**`, `src/i18n/**`, JSON/YAML, a CMS export).
Edit the data source, not the template, otherwise the change drifts from the other places.

## Making the change

1. **Component used more than once.** A template change shows up everywhere the
   component is used. Grep for its name. If the user clearly wants the change in
   one place only, add a prop or variant instead of changing it for all, and
   mention it in your answer.
2. **Styles.** First the component's own styles (Astro/Vue/Svelte `<style>`,
   CSS modules next to it), then the project's global CSS or Tailwind classes,
   whatever the project already uses. See the `web-styling` skill.
3. `data-webai-src`, `data-astro-cid-*` and framework-generated class names in
   the HTML are dev server artifacts. Never write them into source files.
4. Do not edit build output or dependencies: `dist/`, `build/`, `.next/`,
   `.astro/`, `node_modules/`.

## When the request is unclear

For changes that alter the page structure, ask briefly (one question) instead of guessing.
For small things (text, color, spacing), make the most likely choice and say what you chose.
