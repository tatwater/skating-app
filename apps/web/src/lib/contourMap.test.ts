import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToRgb, hueDistance } from '@skating/design';
import { describe, expect, it } from 'vitest';
import { CONTOUR_BEFORE_LAYER_ID, CONTOUR_PALETTE } from './contourMap';
import { HAZARD_PALETTE } from './hazardMap';

/**
 * Web's contour palette. The layer transforms are tested in `@skating/core`
 * (`contourLayer.test.ts`) and the hue math in `@skating/design` (`hue.test.ts`); what is web-specific
 * — and the only reason this file exists on both clients — is that *these* tokens still satisfy D82
 * against *this* app's hazard palette.
 */
describe('CONTOUR_PALETTE', () => {
  const themes = ['white', 'dark'] as const;

  it('is defined for both themes', () => {
    for (const theme of themes) {
      expect(CONTOUR_PALETTE[theme].shallow).toMatch(/^#[0-9a-f]{6}$/i);
      expect(CONTOUR_PALETTE[theme].deep).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('varies only in lightness — one hue, never a multi-hue severity ramp', () => {
    // D82's one styling rule with real weight. A green→yellow→red depth scale would be far more
    // legible, and that is exactly the problem: the most readable version of this layer is the one
    // that most looks like a severity scale, which reintroduces through colour the claim we declined
    // to make in words.
    for (const theme of themes) {
      const { shallow, deep } = CONTOUR_PALETTE[theme];
      expect(hueDistance(shallow, deep)).toBeLessThan(40);
    }
  });

  it('cannot be mistaken for any hazard colour', () => {
    // The hazard palette is danger/warning/success — red, amber, green. A contour must not land on
    // that scale at either end of its ramp, in either theme.
    for (const theme of themes) {
      const contour = CONTOUR_PALETTE[theme];
      const hazards = HAZARD_PALETTE[theme];
      for (const line of [contour.shallow, contour.deep]) {
        for (const role of ['danger', 'healing', 'passage'] as const) {
          expect(hueDistance(line, hazards[role])).toBeGreaterThan(45);
        }
      }
    }
  });

  it('flips ramp direction with the basemap, so the deepest line is always the prominent one', () => {
    // Lightness encodes PROMINENCE, not depth, and the basemap decides which way that runs. A dark
    // line is prominent on a pale basemap and invisible on a dark one; a layer that ignores this
    // disappears in one of the two themes.
    const light = (hex: string) => hexToRgb(hex).reduce((a, b) => a + b, 0);
    expect(light(CONTOUR_PALETTE.white.deep)).toBeLessThan(light(CONTOUR_PALETTE.white.shallow));
    expect(light(CONTOUR_PALETTE.dark.deep)).toBeGreaterThan(light(CONTOUR_PALETTE.dark.shallow));
  });
});

/**
 * The z-order, which is a string convention between two files and fails silently.
 *
 * D82 puts hazards above contours: contours are decoration, hazards are the product, and if the two
 * ever compete for legibility the contour is the one that loses. The map expresses that by inserting
 * the contour layer *before* a layer it added at init — so if that layer is ever renamed, MapLibre's
 * `addLayer` falls back to appending, the contours land on top of every hazard, and nothing anywhere
 * says so.
 */
describe('the layer contours are inserted beneath', () => {
  it('is a layer MapView actually adds', () => {
    const mapView = readFileSync(
      join(import.meta.dirname, '..', 'components', 'MapView.tsx'),
      'utf8',
    );
    expect(mapView).toContain(`id: '${CONTOUR_BEFORE_LAYER_ID}'`);
  });
});

/**
 * What triggers the read that reveals the layer — the bug that shipped and had to be rendered to be
 * found.
 *
 * The contour layer mounts at `line-opacity: 0` and fades only once its own lines can be read back
 * off the tile, so **the trigger is the whole feature**: get it wrong and every surveyed lake draws
 * perfectly and invisibly, with no credit row and no error in any console.
 *
 * `idle` is the intuitive choice and it is wrong. It reads correctly — *"all requested tiles have
 * loaded, no transitions in flight"* — but a source added *after* the map's `load` leaves MapLibre in
 * a state where `idle` is simply never emitted again, verified against a real archive in a real
 * browser. The only read that ever ran was the synchronous one at mount, before a single tile
 * existed. `sourcedata` for this source fires on every tile that arrives, which is both the reveal
 * and the pan-keeps-the-ramp-honest case `idle` was chosen for.
 */
describe('the event the contour read is wired to', () => {
  const mapView = () =>
    readFileSync(join(import.meta.dirname, '..', 'components', 'MapView.tsx'), 'utf8');

  it("subscribes to 'sourcedata'", () => {
    expect(mapView()).toContain("map.on('sourcedata', onContourSourceData)");
  });

  it("never goes back to 'idle', which does not arrive for a post-load source", () => {
    expect(mapView()).not.toContain("map.on('idle'");
  });
});
