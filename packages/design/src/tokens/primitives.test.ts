import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeMaps } from './maps';
import { deltaE, hexToOklch, inGamut, toNativeColor, withAlpha } from './oklch';
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
