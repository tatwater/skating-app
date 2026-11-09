import { namedFlavor } from '@protomaps/basemaps';
import { contrastOklch, hexToOklch } from '@skating/design/tokens';
import { describe, expect, it } from 'vitest';
import { mapPalette, SHORE_OPACITY_BY_ZOOM } from '@/components/skater/map/mapPalette';
import type { MapFlavor } from './waterMap';
import { mapEarth, mapWater, winterFlavor } from './winterFlavor';

const FLAVORS = ['white', 'dark'] as const;

/** Every color the flavor holds, nested maps flattened, by the path it sits at. */
function colorsOf(flavor: MapFlavor): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(winterFlavor(flavor))) {
    if (typeof value === 'string') out.push([key, value]);
    else for (const [sub, c] of Object.entries(value as object)) out.push([`${key}.${sub}`, c]);
  }
  return out;
}

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
    // Every color is one we solved. A key Protomaps adds in a future version arrives with its own
    // default and fails here rather than quietly painting a summer color on a winter map.
    for (const flavor of FLAVORS) {
      const ours = new Set(colorsOf(flavor).map(([, color]) => color));
      const stock = new Set<string>();
      for (const [, value] of Object.entries(
        namedFlavor(flavor) as unknown as Record<string, unknown>,
      )) {
        if (typeof value === 'string') stock.add(value);
        else for (const c of Object.values(value as object)) stock.add(c as string);
      }
      const leaked = [...ours].filter((color) => stock.has(color));
      expect(leaked, `${flavor} kept stock colors`).toEqual([]);
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

  it('draws all water in one color — the shallowest depth band', () => {
    for (const flavor of FLAVORS) {
      const f = winterFlavor(flavor) as Record<string, string>;
      expect(f.water).toBe(mapWater(flavor));
      expect(f.water).toBe(mapPalette(flavor).depth.fills[0]);
      expect(f.water).toBe(mapPalette(flavor).water.fill);
    }
  });

  it('never outshouts the water: every painted role sits under the shoreline', () => {
    for (const flavor of FLAVORS) {
      const land = mapEarth(flavor);
      const p = mapPalette(flavor);
      // What the shore measures where it is faintest — the region view, which is the zoom with the
      // most basemap on screen and the one where a lake has to be findable.
      const shore = contrast(p.water.shore, land) * SHORE_OPACITY_BY_ZOOM.far;
      const f = winterFlavor(flavor) as Record<string, string>;
      for (const key of ['buildings', 'highway', 'major', 'minor_a', 'railway', 'boundaries']) {
        expect(contrast(f[key] as string, land), `${flavor} ${key}`).toBeLessThan(shore);
      }
      // And the loudest road stays under the water itself on dark, where the water has the room to
      // say so. A highway that reads as loud as a river is the map arguing with its own subject.
      if (flavor === 'dark') {
        expect(contrast(f.highway as string, land)).toBeLessThan(contrast(f.water as string, land));
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
