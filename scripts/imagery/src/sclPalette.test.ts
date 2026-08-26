import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCL_LEGEND } from '@skating/core';
import { describe, expect, it } from 'vitest';

/**
 * The legend a skater reads and the palette the cutter applies are two copies of one decision, in
 * two languages, applied months apart — a `gdaldem` colour table baked into tiles on a Fly Machine,
 * and a list of hexes rendered in a panel. **Nothing at runtime can reconcile them**, so the only
 * thing standing between us and a legend that confidently mislabels an entire season is this file.
 *
 * The failure it guards is silent and total: change one hex on either side and every frame in the
 * archive is captioned wrong, with no error anywhere and nothing on screen looking broken.
 */
const PALETTE = resolve(dirname(fileURLToPath(import.meta.url)), '../scl-palette.txt');

/** `<class> <r> <g> <b> <a>` — comments and blanks skipped, as `color-relief` reads it. */
function parsePalette(): Map<number, { hex: string; alpha: number }> {
  const entries = new Map<number, { hex: string; alpha: number }>();
  for (const raw of readFileSync(PALETTE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [cls, r, g, b, a] = line.split(/\s+/).map(Number);
    if (cls === undefined || r === undefined || g === undefined || b === undefined) continue;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    entries.set(cls, { hex, alpha: a ?? 255 });
  }
  return entries;
}

describe('the SCL palette and the legend that explains it', () => {
  const palette = parsePalette();

  it('covers every class ESA publishes, so no pixel falls through to a default', () => {
    // `color-relief -nearest_color_entry` will happily snap an unlisted class to whichever entry is
    // numerically closest, which is a silent mislabel rather than an error.
    for (let cls = 0; cls <= 11; cls++) {
      expect(palette.has(cls), `SCL class ${cls} has no palette entry`).toBe(true);
    }
  });

  it('⚠ paints each legend colour with at least one class, and invents none', () => {
    const painted = new Set([...palette.values()].filter((e) => e.alpha > 0).map((e) => e.hex));
    const legend = new Set(SCL_LEGEND.map((e) => e.color.toUpperCase()));
    expect(painted).toEqual(legend);
  });

  it('⚠ keeps the four questions mapped to the classes that answer them', () => {
    // Written out rather than derived, because the collapse IS the product decision: eleven is
    // snow, six is water, everything cloud-shaped or unclassifiable is "cannot see", and the two
    // land classes are land. A future edit that moves a class between groups should have to change
    // this line and think about it.
    const hex = (cls: number) => palette.get(cls)?.hex;
    expect(hex(11)).toBe('#22D3EE');
    expect(hex(6)).toBe('#1D4ED8');
    for (const cls of [2, 3, 7, 8, 9, 10]) expect(hex(cls)).toBe('#A8A29E');
    for (const cls of [4, 5]) expect(hex(cls)).toBe('#3F6212');
  });

  it('⚠ leaves "no observation" transparent rather than colouring it', () => {
    // Class 0 is no-data and class 1 is a sensor defect. Both are the absence of a measurement, and
    // painting them would put a category on screen where nothing was seen — the basemap has to show
    // through instead.
    expect(palette.get(0)?.alpha).toBe(0);
    expect(palette.get(1)?.alpha).toBe(0);
  });
});
