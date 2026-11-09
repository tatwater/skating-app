import { namedFlavor } from '@protomaps/basemaps';
import { hueDistance } from '@skating/design';
import { nativeThemes } from '@skating/design/native';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mapEarth } from '@/lib/waterMap';
import {
  type MapPalette,
  mapPalette,
  SHORE_OPACITY_BY_ZOOM,
  shoreOpacityByZoom,
} from './mapPalette';

const FLAVORS = ['dark', 'white'] as const;

/** `rgba(r, g, b, a)` or `#rrggbb` → channels and alpha. */
function parse(color: string): { r: number; g: number; b: number; a: number } {
  const rgba = color.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/);
  if (rgba) {
    const [, r = '0', g = '0', b = '0', a = '1'] = rgba;
    return { r: +r, g: +g, b: +b, a: +a };
  }
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (!hex) throw new Error(`not a color: ${color}`);
  const [, r = '0', g = '0', b = '0'] = hex;
  return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16), a: 1 };
}

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** The color as it lands over the map's ground. */
function over(color: string, ground: string): string {
  const c = parse(color);
  const g = parse(ground);
  const mix = (a: number, b: number) => Math.round(a * c.a + b * (1 - c.a));
  return hex({ r: mix(c.r, g.r), g: mix(c.g, g.g), b: mix(c.b, g.b) });
}

const luminance = (color: string) => {
  const c = parse(color);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every color string a palette holds, by its path. */
function colorsOf(palette: MapPalette): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') out.push([path, value]);
    else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
    } else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(palette, '');
  return out.filter(([path]) => path !== 'flavor');
}

describe('mapPalette', () => {
  it('is skater tokens all the way down, the land included (D232)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      const c = nativeThemes.skater[flavor === 'dark' ? 'dark' : 'light'].color;
      expect(p.ground).toBe(c['map-earth']);
      expect(p.places.halo).toBe(p.ground);
      // Nothing on the map is a hex of its own any more — the ground stopped being the one exception
      // when the land became a token (founder, 2026-11-09).
      const tokens = new Set<string>(Object.values(c));
      for (const [path, color] of colorsOf(p)) {
        expect(tokens.has(color), `${flavor} ${path} = ${color}`).toBe(true);
      }
    }
    // Dark's land is where Protomaps already had it; light's is not — its `white` earth is #ffffff,
    // the skater field exactly, which left the map pane with no edge against the sidebar at all.
    expect(mapEarth('dark')).toBe('#1f1f1f');
    expect(mapEarth('white')).toBe('#f2f2f2');
    expect(mapEarth('white')).not.toBe(
      (namedFlavor('white') as unknown as { earth: string }).earth,
    );
  });

  it('draws every listed body in the shallowest depth band, opaque (founder, 2026-11-09)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      // One language for every body: an unchosen lake is band 0 and its contour, so opening a lake
      // adds the deeper bands rather than changing the color of the water it already showed.
      expect(p.water.fill).toBe(p.depth.fills[0]);
      expect(p.water.shore).toBe(p.depth.indexes[0]);
      // Opaque, not a wash: the depth ramp is a reading, and a reading can't be diluted by whatever
      // the basemap happens to draw under it.
      expect(parse(p.water.fill).a).toBe(1);
      expect(parse(p.water.shore).a).toBe(1);
      // And it is the ramp's own hue, never the accent's: ice is for paths and pins now.
      expect(hueDistance(p.water.fill, p.depth.fills[6] as string)).toBeLessThan(15);
    }
  });

  it('draws an inactive body gray, not ice (Review 2)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      for (const color of [p.inactive.fill, p.inactive.shore]) {
        const { r, g, b } = parse(color);
        expect(r).toBe(g);
        expect(g).toBe(b);
      }
      // And quieter than a listed body: its shore sits closer to the ground than the ice shore does.
      expect(contrast(over(p.inactive.shore, p.ground), p.ground)).toBeLessThan(
        contrast(over(p.water.shore, p.ground), p.ground),
      );
    }
  });

  it('lights the shore in steps, all three from band 0: contour, index, then the lit ink', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      const c = nativeThemes.skater[flavor === 'dark' ? 'dark' : 'light'].color;
      // A hover is a step further along the water's own ramp, not a jump to another hue.
      expect(p.hovered).toBe(c['map-shore-hover']);
      expect(hueDistance(p.hovered, p.water.shore)).toBeLessThan(15);
      expect(p.selected).toBe(c.fg);
      const rest = contrast(over(p.water.shore, p.ground), p.ground);
      const hover = contrast(p.hovered, p.ground);
      const chosen = contrast(p.selected, p.ground);
      expect(rest).toBeLessThan(hover);
      expect(hover).toBeLessThan(chosen);
      // A 1 px shore still reads on the ground in both modes.
      expect(rest).toBeGreaterThan(1.8);
    }
  });

  it('softens the shore at region zooms and never past half', () => {
    expect(shoreOpacityByZoom()).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      SHORE_OPACITY_BY_ZOOM.farZoom,
      SHORE_OPACITY_BY_ZOOM.far,
      SHORE_OPACITY_BY_ZOOM.nearZoom,
      SHORE_OPACITY_BY_ZOOM.near,
    ]);
    expect(SHORE_OPACITY_BY_ZOOM.far).toBeGreaterThanOrEqual(0.5);
    expect(SHORE_OPACITY_BY_ZOOM.near).toBe(1);
  });

  it('keeps the hazard colors off the water and off each other (D3, D82)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      const { danger, healing, passage, feature } = p.hazard;
      expect(new Set([danger, healing, passage]).size).toBe(3);
      // Danger and healing are hues of their own; the water's ice is never one of them.
      for (const warning of [danger, healing]) {
        expect(hueDistance(warning, p.accent)).toBeGreaterThan(60);
        for (const fill of [...p.depth.fills, over(p.water.fill, p.ground)]) {
          expect(hueDistance(warning, fill)).toBeGreaterThan(45);
        }
      }
      // A known feature is quiet ink: no chroma, so it can't be read as a warning.
      const f = parse(feature);
      expect(f.r).toBe(f.g);
      expect(f.g).toBe(f.b);
    }
  });

  it('draws the suggested crossing in ice, never green (D3)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      expect(p.hazard.passage).toBe(p.accent);
      expect(p.hazard.passage).toBe(p.track);
      // Green, the one hue that would read as a verdict, is nowhere on a body.
      for (const [, color] of colorsOf(p)) {
        const c = parse(color);
        const green = c.g > c.r * 1.3 && c.g > c.b * 1.3;
        expect(green, color).toBe(false);
      }
    }
  });

  it('keeps depth a single-hue ramp that darkens with depth on dark and on light', () => {
    for (const flavor of FLAVORS) {
      const { fills, lines, indexes } = mapPalette(flavor).depth;
      for (const ramp of [fills, lines, indexes]) {
        expect(ramp).toHaveLength(7);
        for (let i = 1; i < ramp.length; i++) {
          expect(luminance(ramp[i] as string)).toBeLessThan(luminance(ramp[i - 1] as string));
          expect(hueDistance(ramp[i] as string, ramp[0] as string)).toBeLessThan(15);
        }
      }
      // A line is brighter than its band's fill, and an index line brighter still: the ring reads.
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 6 }), (band) => {
          const lighter = (a: string, b: string) =>
            flavor === 'dark' ? luminance(a) > luminance(b) : luminance(a) < luminance(b);
          expect(lighter(lines[band] as string, fills[band] as string)).toBe(true);
          expect(lighter(indexes[band] as string, lines[band] as string)).toBe(true);
        }),
      );
    }
  });

  it('puts the names in body ink and the landmarks a step quieter (D202)', () => {
    for (const flavor of FLAVORS) {
      const p = mapPalette(flavor);
      const c = nativeThemes.skater[flavor === 'dark' ? 'dark' : 'light'].color;
      expect(p.places.label).toBe(c.fg2);
      expect(p.places.outline).toBe(c.fg2);
      expect(p.places.landmark).toBe(c.fg3);
      expect(contrast(p.places.label, p.ground)).toBeGreaterThan(
        contrast(p.places.landmark, p.ground),
      );
    }
  });
});
