---
name: verify-change
description: Use after editing source files from the webai overlay, before answering. How to check the change without starting servers, and how to report what was and was not verified.
---

# Verifying a change

The dev server is running and reloads the change on its own. **Do not run**
`npm run dev`, `astro dev`, `vite`, `next dev` or a build.

1. Re-read the edited section: the template's syntax (closed tags, `{}`
   expressions, Astro frontmatter between `---`, JSX attribute names).
2. If you have shell access and the project has a quick check (`npm run check`,
   `astro check`, `tsc`, lint), run it only for edits that could break types or
   imports. Skip it for text or color changes.
3. The shell is often disabled in the overlay. If you cannot run a check, do not
   work around it. Say in your answer what you did not verify.
4. Answer: one or two sentences on what changed and where (`file:line`), plus
   anything left unverified or affecting other parts of the site.
