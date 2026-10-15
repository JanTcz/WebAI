---
name: web-styling
description: Use when changing colors, spacing, typography, layout or responsiveness of a web page element. Covers reusing design tokens, keeping WCAG AA contrast, responsive breakpoints and avoiding specificity hacks.
---

# Styling without breaking the site

- **Tokens, not values.** Before writing a color, size or spacing, look for
  custom properties (`grep -n -- '--' src/styles` / `:root`). Use an existing token;
  add a new one only when none fits, and name it by purpose, not by color.
- **WCAG AA contrast:** body text ≥ 4.5 : 1, large text (≥ 24 px, or 18.66 px bold)
  and icons ≥ 3 : 1. When you change a text or background color, compute the contrast and state it in your answer.
- **Responsiveness:** use the breakpoints the project already has (grep `@media`). Do not introduce new
  values. Think the change through for mobile too.
- **Specificity:** no `!important` and no ID selectors to win overrides. Prefer editing
  the original rule. In a scoped Astro `<style>`, styles apply only to that component;
  reaching children of other components needs `:global()`.
- **Motion:** wrap animations in `@media (prefers-reduced-motion: no-preference)`.
- **Hiding content:** `display: none` on content is often a mistake. Make sure the user really wants
  to hide the element, not just move it.
