import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeMaps } from './maps';
import {
  contrastOklch,
  deltaE,
  hexToOklch,
  inGamut,
  solveForContrast,
  toNativeColor,
  withAlpha,
} from './oklch';
import { overlays, primitives } from './primitives';
import { colorSpecs } from './semantic';

/** The audited palette, as audited (the conversion's input, kept for provenance). */
const audit = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/audit-colors.json'), 'utf8'),
) as { colors: Record<string, string> };
const auditByName = Object.fromEntries(
  Object.entries(audit.colors).map(([path, hex]) => [path.replace(/\./g, '-'), hex.toLowerCase()]),
);

/** `#rrggbbaa` → the `rgba()` React Native gets, so audited translucent colors compare exactly. */
function rgbaOf(hex8: string): string {
  const n = (i: number) => Number.parseInt(hex8.slice(i, i + 2), 16);
  const alpha = n(7) / 255;
  return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${Math.round(alpha * 100) / 100})`;
}

describe('the OKLCH primitives reproduce the audited palette', () => {
  it('covers every audited color, opaque or translucent', () => {
    const covered = new Set([...Object.keys(primitives), ...Object.keys(overlays)]);
    expect(Object.keys(auditByName).filter((name) => !covered.has(name))).toEqual([]);
  });

  it.each(Object.entries(primitives))('%s converts back to its audited hex exactly', (name, c) => {
    expect(inGamut(c)).toBe(true);
    const audited = auditByName[name];
    if (audited === undefined) return; // white and black, the overlays' bases
    expect(toNativeColor(c)).toBe(audited);
    // And the stored (rounded) OKLCH is imperceptibly far from the unrounded conversion.
    expect(deltaE(c, hexToOklch(audited))).toBeLessThan(0.1);
  });

  it.each(Object.entries(overlays))('%s keeps its audited base and alpha', (name, overlay) => {
    const audited = auditByName[name] as string;
    const rebuilt = withAlpha(primitives[overlay.base], overlay.alpha);
    // The base's RGB is the audited RGB; the alpha encodes back to the audited byte.
    expect(toNativeColor(withAlpha(rebuilt, 1))).toBe(audited.slice(0, 7));
    expect(Math.round(overlay.alpha * 255)).toBe(Number.parseInt(audited.slice(7), 16));
  });
});

describe('admin dark is the audit', () => {
  const colors = themeMaps.admin.dark.colors;

  it('binds every opaque role to its audited primitive', () => {
    for (const [key, spec] of Object.entries(colorSpecs)) {
      if (spec.role === 'overlay' || spec.role === 'alias') continue;
      const name = spec.dark;
      expect(colors[key as keyof typeof colors], key).toEqual(primitives[name]);
    }
  });

  it('reproduces every audited overlay it names, to the byte', () => {
    for (const [key, spec] of Object.entries(colorSpecs)) {
      if (spec.role !== 'overlay' || spec.audit === undefined) continue;
      const audited = auditByName[spec.audit] as string;
      expect(toNativeColor(colors[key as keyof typeof colors]), key).toBe(rgbaOf(audited));
    }
  });
});

/**
 * The map's land sits exactly halfway, in lightness, between the skater field it is framed against
 * and the shallowest water drawn on it (founder, 2026-11-09): the pane parts from the sidebar by
 * the same step the water then takes away from the land, in both modes. Held here so an edit to the
 * field or to band 0 can't quietly leave the land where it was.
 */
describe('the map earth is midway between the field and band 0', () => {
  it.each([
    ['dark', 'void', 'depth-dark-0', 'map-earth-dark'],
    ['light', 'skater-light-bg', 'depth-light-0', 'map-earth-light'],
  ] as const)('%s', (_mode, field, water, earth) => {
    const midpoint = (primitives[field].l + primitives[water].l) / 2;
    expect(primitives[earth].l).toBeCloseTo(midpoint, 4);
    // A whisper of the depth ramp's hue and no more: snow in shade. Enough that the whole basemap
    // solves off a cold land, far too little to read as a blue in its own right.
    expect(primitives[earth].h).toBe(245);
    expect(primitives[earth].c).toBeGreaterThan(0);
    expect(primitives[earth].c).toBeLessThan(0.012);
  });
});

/**
 * Water the map has nothing to say about sits halfway, in contrast against the land, between that
 * land and the water it can speak for — so an unlisted pond is always the quieter of the two, in
 * either mode. It has to be a different color from band 0 at all: the basemap paints its own water
 * under ours, and the access dim is a halved opacity, so matching colors made the dim a no-op
 * (#102). Held here so a move to the land or to the ramp carries it rather than stranding it.
 */
describe('unlisted water is halfway between the land and the water we know', () => {
  it.each([
    ['dark', 'map-earth-dark', 'depth-dark-0', 'map-water-inactive-dark'],
    ['light', 'map-earth-light', 'depth-light-0', 'map-water-inactive-light'],
  ] as const)('%s', (_mode, earth, band0, unlisted) => {
    const land = primitives[earth];
    const half = 1 + (contrastOklch(primitives[band0], land) - 1) / 2;
    const solved = solveForContrast(
      { l: land.l, c: 0, h: 0 },
      land,
      half,
      land.l > 0.5 ? 'darker' : 'lighter',
    );
    expect(primitives[unlisted].l).toBeCloseTo(solved.l, 4);
    // Gray, never ice (Review 2): nothing receded carries the app's hue.
    expect(primitives[unlisted].c).toBe(0);
    expect(primitives[unlisted]).not.toEqual(primitives[band0]);
  });
});
