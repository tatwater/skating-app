import { describe, expect, it } from 'vitest';

import { MASCOMA_SCENE } from '../frame/bodyFixtures';
import { MASCOMA_MAP_DATA } from '../tabs/hazards/hazardsFixtures';
import { hazardsMapScene } from '../tabs/hazards/hazardsMap';
import { MASCOMA_PASSES } from '../tabs/imagery/imageryFixtures';
import { imageryMapScene } from '../tabs/imagery/imageryMap';
import { shapeMapScene } from '../tabs/shape/shapeModel';
import { drawScene, layerSwitches } from './bodyScene';
import { glLayerIds, rasterAnchor } from './glLayers';

/**
 * Each tab's scene, with its default rack, leaves its own subject visible under the layer contract
 * (`MAP_BANDS`): the subject is drawn, and drawn in a band above the body's opaque fill. This proves
 * the order and the paint the GL style is given; how a pass, a field or a line actually reads on a
 * real map — tiles, blending, the basemap's own labels — still needs eyes on the live preview.
 * Imagery's and Hazards' scenes are held to the same rule beside their tabs.
 */

const ids = glLayerIds();
const fill = ids.indexOf('body-console-fill-body');

describe('Shape’s scene keeps its bays visible', () => {
  it('draws every bay as an outline over the body’s fill, under the DOM’s labels', () => {
    const scene = { ...MASCOMA_SCENE, ...shapeMapScene(null, null), items: MASCOMA_SCENE.items };
    const drawn = drawScene(scene, layerSwitches(scene.layers));
    const bays = drawn.outlines.features.filter((f) => f.properties.style === 'bay');
    expect(bays.length).toBeGreaterThan(0);
    expect(ids.indexOf('body-console-outline-bay')).toBeGreaterThan(fill);
  });
});

describe('Imagery’s scene keeps its pass visible', () => {
  it('draws the lit pass with the Aerial layer on, placed over the body’s opaque fill', () => {
    const band = MASCOMA_PASSES[0]?.band ?? 'visual';
    const scene = imageryMapScene({ rows: MASCOMA_PASSES, band, season: 'winter-2026-27' }, null);
    const drawn = drawScene(scene, layerSwitches(scene.layers));
    expect(drawn.raster).not.toBeNull();
    // The reveal inserts the pass before this layer: above the fill, never under it.
    const before = rasterAnchor(ids);
    expect(ids.indexOf(before as string)).toBeGreaterThan(fill);
  });
});

describe('Hazards’ scene keeps its fields visible', () => {
  it('draws each hazard’s dot field, over the body’s opaque fill', () => {
    const scene = hazardsMapScene(
      {
        ...MASCOMA_MAP_DATA,
        hazards: [
          {
            _id: 'h1',
            geometryKind: 'point_radius',
            geometry: { type: 'Point', coordinates: [-72.15, 43.63] },
            radiusMeters: 60,
            freshness: 'fresh',
            provisional: false,
          },
        ],
      },
      null,
    );
    const drawn = drawScene(scene, layerSwitches(scene.layers));
    expect(drawn.dots.features.length).toBeGreaterThan(0);
    expect(ids.indexOf('body-console-field-dots')).toBeGreaterThan(fill);
  });
});
