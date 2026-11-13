import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { FONT_PRELOADS } from './fontPreloads';

// Read off the installed packages (pinned by the lockfile) rather than imported: the unit project
// processes CSS imports to nothing, `?raw` included.
const require = createRequire(import.meta.url);
const stylesheet = (pkg: string) => readFileSync(require.resolve(`${pkg}/index.css`), 'utf8');
const sairaCss = stylesheet('@fontsource-variable/saira');
const martianMonoCss = stylesheet('@fontsource-variable/martian-mono');

/** The `url()` file each `@font-face` block whose `unicode-range` opens on Basic Latin points at. */
function latinFiles(css: string): string[] {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
    .map((m) => m[1] ?? '')
    .filter((block) => /unicode-range:\s*U\+0000-00FF\b/.test(block))
    .map((block) => block.match(/url\(\.\/files\/([^)]+)\)/)?.[1] ?? '');
}

describe('FONT_PRELOADS', () => {
  test('preloads exactly the files Fontsource gives the Latin range, one per face', () => {
    const expected = [...latinFiles(sairaCss), ...latinFiles(martianMonoCss)];
    // One Latin block per face — a second would mean a page needs two files and we preload one.
    expect(expected).toEqual([
      'saira-latin-wght-normal.woff2',
      'martian-mono-latin-wght-normal.woff2',
    ]);
    const preloaded = FONT_PRELOADS.map((link) => link.href.split('/').pop() ?? '');
    // Vite's dev and test servers keep the file's own name; a build adds a content hash before
    // the extension (`saira-latin-wght-normal-<hash>.woff2`), the same one the CSS's url() gets.
    expected.forEach((file, i) => {
      const stem = file.replace(/\.woff2$/, '');
      expect(preloaded[i]).toMatch(new RegExp(`^${stem}(-[\\w-]+)?\\.woff2(\\?.*)?$`));
    });
  });

  test('every link is a CORS font preload, or the font load would fetch the file again', () => {
    for (const link of FONT_PRELOADS) {
      expect(link).toMatchObject({
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      });
    }
  });
});
