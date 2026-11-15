import { describe, expect, it } from 'vitest';

import { MASCOMA_SCENE } from '../frame/bodyFixtures';
import { shapeMapScene } from '../tabs/shape/shapeModel';
import { drawScene, layerSwitches } from './bodyScene';
import { glLayerIds } from './glLayers';

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
