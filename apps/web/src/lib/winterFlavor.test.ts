import { namedFlavor } from '@protomaps/basemaps';
import { NO_PUBLIC_ACCESS_OPACITY_SCALE } from '@skating/core';
import {
  composite,
  contrastOklch,
  deltaE,
  hexToOklch,
  rgbToOklch,
  withAlpha,
} from '@skating/design/tokens';
import { describe, expect, it } from 'vitest';
import { mapPalette, SHORE_OPACITY_BY_ZOOM } from '@/components/skater/map/mapPalette';
import type { MapFlavor } from './waterMap';
import {
  mapEarth,
  mapListedWater,
  mapUnknownWater,
  winterFlavor,
  winterOverrides,
} from './winterFlavor';

const FLAVORS = ['white', 'dark'] as const;

/** Every color a flavor holds, nested maps flattened, by the path it sits at. */
function flatten(flavor: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(flavor)) {
    if (typeof value === 'string') out.push([key, value]);
    else
      for (const [sub, c] of Object.entries(value as object))
        out.push([`${key}.${sub}`, c as string]);
  }
  return out;
}

/** What the map paints from: the stock flavor with ours on top. */
const colorsOf = (flavor: MapFlavor) => flatten(winterFlavor(flavor));

const contrast = (color: string, ground: string) =>
  contrastOklch(hexToOklch(color), hexToOklch(ground));

describe('the winter flavor', () => {
  it('has no green on it anywhere, nested maps included (founder, 2026-11-09)', () => {
    for (const flavor of FLAVORS) {
      for (const [path, color] of colorsOf(flavor)) {
        const { c, h } = hexToOklch(color);
        if (c < 0.002) continue; // a neutral has no hue to judge
        // One cold family, the depth ramp's. Green lives around 120–160 and can't reach this band.
        expect(h, `${flavor} ${path} = ${color}`).toBeGreaterThan(200);
        expect(h, `${flavor} ${path} = ${color}`).toBeLessThan(290);
      }
    }
  });

  it('leaves the stock flavor nothing to leak through', () => {
    // Every color is one we assign. A key Protomaps adds in a future version arrives with its own
    // default and fails here rather than quietly painting a summer color on a winter map.
    //
    // By **path**, not by value, and against `winterOverrides` rather than the flavor the map
    // paints from. Two corrections, in that order:
    //
    // - Values stopped working when the land moved a quarter of the way to band 0 (founder,
    //   2026-11-10): the solved `map-water-inactive-light` landed on #efefef, which is also stock
    //   `white`'s `runway`, `pier` and `buildings` — three keys we do assign. It could never have
    //   held either way, since a solved value is free to collide with a default and a key we had
    //   genuinely forgotten would pass the moment Protomaps' default for it differed from every
    //   color of ours.
    // - Paths against `winterFlavor` then made the test **vacuous** (Greptile, #104): that function
    //   spreads the whole stock flavor before ours, so every stock path is in the result by
    //   construction and `leaked` could only ever be empty. Only the overrides know what we decided.
    for (const flavor of FLAVORS) {
      const ours = new Set(flatten(winterOverrides(flavor)).map(([path]) => path));
      const stock = flatten(namedFlavor(flavor) as unknown as Record<string, unknown>);
      const leaked = stock.map(([path]) => path).filter((path) => !ours.has(path));
      expect(leaked, `${flavor} left stock colors in place`).toEqual([]);
    }
  });

  it('collapses every landuse class to the land: under snow, land has no categories', () => {
    for (const flavor of FLAVORS) {
      const earth = mapEarth(flavor);
      const f = winterFlavor(flavor) as Record<string, string>;
      for (const key of [
        'background',
        'earth',
        'park_a',
        'park_b',
        'wood_a',
        'wood_b',
        'scrub_a',
        'scrub_b',
        'glacier',
        'sand',
        'beach',
        'zoo',
        'military',
        'school',
        'hospital',
        'industrial',
        'pedestrian',
        'aerodrome',
      ]) {
        expect(f[key], `${flavor} ${key}`).toBe(earth);
      }
      for (const [cls, color] of Object.entries(f.landcover as unknown as Record<string, string>)) {
        expect(color, `${flavor} landcover.${cls}`).toBe(earth);
      }
      // A road casing is the land too, so a road reads as cut into it rather than laid on it.
      expect(f.minor_casing).toBe(earth);
      expect(f.highway_casing_late).toBe(earth);
    }
  });

  it('draws water it knows nothing about in gray, under the water it does (#102)', () => {
    for (const flavor of FLAVORS) {
      const land = mapEarth(flavor);
      const f = winterFlavor(flavor) as Record<string, string>;
      // A river, an unlisted pond and a retired body all say the same thing, and none of them may
      // carry the app's hue.
      expect(f.water).toBe(mapUnknownWater(flavor));
      expect(f.water).toBe(mapPalette(flavor).inactive.fill);
      const { c } = hexToOklch(f.water as string);
      expect(c).toBe(0);
      // Quieter than a body we can speak for — in both modes, by construction.
      expect(contrast(f.water as string, land)).toBeLessThan(
        contrast(mapListedWater(flavor), land),
      );
    }
  });

  it('leaves the access dim something to say: the basemap is never band 0 (#102)', () => {
    for (const flavor of FLAVORS) {
      const f = winterFlavor(flavor) as Record<string, string>;
      const listed = hexToOklch(mapListedWater(flavor));
      // The basemap paints its own water under ours. `withAccessDim` halves our fill's opacity to
      // say "no public access", so if the two colors matched, half of a color over the same color
      // would be that color and the dim would say nothing at all. It did.
      expect(f.water).not.toBe(mapListedWater(flavor));
      const dimmed = rgbToOklch(
        composite(withAlpha(listed, NO_PUBLIC_ACCESS_OPACITY_SCALE), hexToOklch(f.water as string)),
      );
      expect(deltaE(dimmed, listed), `${flavor} dim is imperceptible`).toBeGreaterThan(1);
    }
  });

  it('never outshouts the water: every painted role sits under the shoreline', () => {
    for (const flavor of FLAVORS) {
      const land = mapEarth(flavor);
      const p = mapPalette(flavor);
      // What the shore measures where it is faintest — the region view, which is the zoom with the
      // most basemap on screen and the one where a lake has to be findable.
      // Composited, not scaled: a contrast ratio is not linear in opacity, so multiplying one by
      // an alpha gives a number that describes nothing (#102).
      const shore = contrastOklch(
        withAlpha(hexToOklch(p.water.shore), SHORE_OPACITY_BY_ZOOM.far),
        hexToOklch(land),
      );
      const f = winterFlavor(flavor) as Record<string, string>;
      for (const key of ['buildings', 'highway', 'major', 'minor_a', 'railway', 'boundaries']) {
        expect(contrast(f[key] as string, land), `${flavor} ${key}`).toBeLessThan(shore);
      }
      // And the loudest road stays under a lake we can speak for, on dark, where the water has the
      // room to say so. A highway that reads as loud as a lake is the map arguing with its subject.
      // Light cannot be held to this: its band 0 measures 1.11:1 on the land, under a hairline, so
      // there is no ordering to enforce — in light a lake is found by its shore, not by its fill.
      if (flavor === 'dark') {
        expect(contrast(f.highway as string, land)).toBeLessThan(
          contrast(mapListedWater(flavor), land),
        );
      }
      // And every basemap name stays under our own place labels.
      const ours = contrast(p.places.label, land);
      for (const key of ['city_label', 'subplace_label', 'roads_label_major', 'state_label']) {
        expect(contrast(f[key] as string, land), `${flavor} ${key}`).toBeLessThan(ours);
      }
    }
  });

  it('is the same map twice: light and dark solve to the same shape', () => {
    const shape = (flavor: MapFlavor) => {
      const earth = mapEarth(flavor);
      const colors = colorsOf(flavor);
      return {
        keys: colors.length,
        distinct: new Set(colors.map(([, c]) => c)).size,
        land: colors.filter(([, c]) => c === earth).length,
      };
    };
    expect(shape('white')).toEqual(shape('dark'));
  });
});
