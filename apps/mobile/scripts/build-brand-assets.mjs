/**
 * Rasterizes the Gli wordmark into the PNGs Expo needs (splash, icon, Android adaptive
 * foreground). Run after changing either `assets/gli-*-duotone.svg`:
 *
 *   node scripts/build-brand-assets.mjs
 *
 * Expo's splash/icon config takes PNG only — it will not accept an SVG — so these are
 * generated artifacts that have to be committed alongside their source.
 *
 * Rather than composite PNGs together, each output is authored as a single wrapper SVG
 * (background + the mark's own path data, transformed) and rasterized in one pass. That
 * keeps padding and the Android safe zone exact instead of approximate, and it means the
 * paths are read from the source marks every run, so the outputs cannot drift from them.
 *
 * `sharp` is invoked through `pnpm dlx` on purpose: this runs a handful of times a year,
 * and a native image dependency in apps/mobile would be installed on every EAS build and
 * folded into the fingerprint for no reason.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** The mark's intrinsic viewBox, from the source SVGs. */
const MARK_W = 303;
const MARK_H = 118;

/** The app's dark chrome — matches the splash `backgroundColor` in app.config.ts. */
const NAVY = '#0b1620';

/**
 * Reads the path geometry out of a source mark. Both duotone files carry identical
 * geometry and differ only in the wordmark fill, so the accent (`#8FD3EE`) survives
 * untouched and only the non-accent fills are re-colored per output.
 */
function readMark(file) {
  const svg = readFileSync(join(ASSETS, file), 'utf8');
  const paths = [...svg.matchAll(/<path[^>]*d="([^"]+)"[^>]*fill="([^"]+)"[^>]*\/>/g)].map(
    ([, d, fill]) => ({ d, fill }),
  );
  if (paths.length !== 6) {
    throw new Error(`${file}: expected 6 paths, found ${paths.length} — did the logo change?`);
  }
  return paths;
}

/** Re-colors the wordmark (leaving the duotone accent alone) and emits the path elements. */
function paint(paths, wordmarkFill) {
  return paths
    .map(({ d, fill }) => {
      const isAccent = fill.toLowerCase() === '#8fd3ee';
      return `  <path d="${d}" fill="${isAccent ? fill : wordmarkFill}"/>`;
    })
    .join('\n');
}

/**
 * Composes a square canvas with the wordmark centered at `markWidth`, optionally over a
 * solid background. Centering is computed from the scaled height so the mark sits on the
 * true optical center rather than being top-aligned.
 */
function square({ paths, wordmarkFill, size, markWidth, background }) {
  const scale = markWidth / MARK_W;
  const x = (size - markWidth) / 2;
  const y = (size - MARK_H * scale) / 2;
  const bg = background ? `  <rect width="${size}" height="${size}" fill="${background}"/>\n` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
${bg}  <g transform="translate(${x} ${y}) scale(${scale})">
${paint(paths, wordmarkFill)}
  </g>
</svg>
`;
}

/** The bare wordmark on transparency, for the splash. */
function wordmark({ paths, wordmarkFill, width }) {
  const scale = width / MARK_W;
  return `<svg width="${width}" height="${Math.round(MARK_H * scale)}" viewBox="0 0 ${MARK_W} ${MARK_H}" xmlns="http://www.w3.org/2000/svg">
${paint(paths, wordmarkFill)}
</svg>
`;
}

const tmp = mkdtempSync(join(tmpdir(), 'gli-brand-'));
const geometry = readMark('gli-black-duotone.svg');

/**
 * Icon sizes. 1024 is the canvas Expo expects.
 *
 * ICON_MARK (70% of the canvas) leaves room for the iOS squircle's corner radius.
 *
 * ADAPTIVE_MARK is tighter because Android may mask the foreground to a *circle*: the
 * largest 303x118 rectangle that fits inside the 66%-of-1024 (676px) safe circle is
 * ~630px wide by Pythagoras, so 600 keeps the wordmark's corners clear of the crop on
 * every launcher shape rather than only on rounded squares.
 */
const CANVAS = 1024;
const ICON_MARK = 716;
const ADAPTIVE_MARK = 600;

/** 4x the intrinsic width, so the densest Android bucket still has real pixels to scale from. */
const SPLASH_MARK = MARK_W * 4;

const outputs = [
  {
    name: 'splash-icon-light.png',
    svg: wordmark({ paths: geometry, wordmarkFill: 'black', width: SPLASH_MARK }),
  },
  {
    name: 'splash-icon-dark.png',
    svg: wordmark({ paths: geometry, wordmarkFill: 'white', width: SPLASH_MARK }),
  },
  {
    name: 'icon.png',
    svg: square({
      paths: geometry,
      wordmarkFill: 'white',
      size: CANVAS,
      markWidth: ICON_MARK,
      background: NAVY,
    }),
    // The navy rect already covers the canvas, so this drops a fully-opaque alpha channel
    // rather than changing any pixel: iOS rejects an app icon that carries one at all.
    flatten: true,
  },
  {
    name: 'adaptive-icon.png',
    svg: square({
      paths: geometry,
      wordmarkFill: 'white',
      size: CANVAS,
      markWidth: ADAPTIVE_MARK,
    }),
  },
];

for (const { name, svg, flatten } of outputs) {
  const src = join(tmp, `${name}.svg`);
  writeFileSync(src, svg);
  const args = ['dlx', 'sharp-cli', '-i', src, '-o', join(ASSETS, name)];
  if (flatten) args.push('--background', NAVY, 'flatten');
  execFileSync('pnpm', args, { stdio: 'inherit' });
  console.log(`wrote assets/${name}`);
}
