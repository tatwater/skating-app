/**
 * The two faces' Latin files, preloaded from the document head (founder, 2026-11-11), so a first
 * visit doesn't paint in the system stack and then swap to Saira.
 *
 * `app.css` imports Fontsource's stylesheets, which split each face by `unicode-range`; an
 * English page uses only the `latin` file of each, and the browser asks for it only once layout
 * meets text, late in the load. These links ask for the same two files as the head is parsed.
 *
 * **The URL has to be the one the stylesheet asks for**, or the face downloads twice. Both go
 * through Vite: the CSS's `url(./files/…)` and the `?url` import below resolve to one emitted,
 * content-hashed asset. A production build is what proves it (the built HTML's preload `href` and
 * the built CSS's `url()` name the same file), and `fontPreloads.test.ts` holds that these are
 * still the files Fontsource's stylesheets give the Latin range.
 *
 * `crossOrigin` is required even on our own origin: fonts are always fetched in CORS mode, and a
 * preload made without it is a different request, which the font load would not reuse.
 */
import martianMonoLatin from '@fontsource-variable/martian-mono/files/martian-mono-latin-wght-normal.woff2?url';
import sairaLatin from '@fontsource-variable/saira/files/saira-latin-wght-normal.woff2?url';
import type { LinkHTMLAttributes } from 'react';

export const FONT_PRELOADS = [sairaLatin, martianMonoLatin].map(
  (href) =>
    ({
      rel: 'preload',
      href,
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    }) satisfies LinkHTMLAttributes<HTMLLinkElement>,
);
