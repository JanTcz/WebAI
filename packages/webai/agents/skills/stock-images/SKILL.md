---
name: stock-images
description: Use when the user asks for a photo, illustration or other image that the project doesn't have yet. Covers finding openly licensed images on Openverse, saving them into the project, alt text and the credit line their licenses require.
---

# Free images with the right credit

- **Search Openverse** (no key needed), only images that may be used on a
  commercial site and resized or cropped:
  `https://api.openverse.org/v1/images/?q=<a few English words>&license_type=commercial,modification&mature=false&page_size=8`.
  Each result has `title`, `creator`, `license`, `license_version`, `width`,
  `height`, `url` (the file) and `foreign_landing_url` (its page). You can't
  see the images: pick by title and size, and prefer landscape images at least
  1200 px wide for wide spots.
- **Save it into the project**, don't hotlink: where the project keeps images
  (`src/assets/` with `astro:assets`' `<Image>`, or `public/images/`). If you
  have no tool to download a binary file, tell the user the URL and the path to
  save it to, and write the markup for that path.
- **Alt text** says what the image shows in this page's context, not the file
  name. Purely decorative images get `alt=""`.
- **Credit:** licenses other than CC0 and Public Domain Mark (`cc0`, `pdm`)
  require one. Put it right under the image or in the footer:
  `Photo: <a href="{foreign_landing_url}">{title}</a> by {creator}, CC {LICENSE} {version}`.
  Never drop or shorten it when restyling.
- Say in your answer which image you chose, from where and under which license.
