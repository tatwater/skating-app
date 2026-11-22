import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { MASCOMA_BOUNDS } from '../frame/bodyFixtures';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyMapStillView } from './BodyMap';
import { BodyMapKey, PointFace } from './BodyMapMarks';
import { BodyMapPane } from './BodyMapPane';
import { LINE_STYLES, OUTLINE_STYLES } from './bodyMapPalette';
import { drawScene, LINE_ORDER, layerSwitches, OUTLINE_ORDER, PIXEL_RULES } from './bodyScene';
import { glLayerIds } from './glLayers';
import type { BodyMapScene, MapPointMark } from './mapDescriptors';

/**
 * The Inbox's additions to the console map (B01's Inbox, the map seam): an outline `candidate`, a
 * line `gap`, the points `reticle`, `asked` and `lookalike`, and a pane with no rack and a plate.
 * Every existing member keeps its look and place — the Body console's own tests say so unchanged.
 */

beforeAll(stubJsdomAnimations);

const { minLng: w, maxLng: e, minLat: s, maxLat: n } = MASCOMA_BOUNDS;
const at = (fx: number, fy: number) => [w + (e - w) * fx, s + (n - s) * fy] as const;
const square: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[...at(0.4, 0.4)], [...at(0.6, 0.4)], [...at(0.6, 0.6)], [...at(0.4, 0.4)]]],
};

describe('the new styles', () => {
  it('draw a candidate dashed in the bright ink, over the shore', () => {
    expect(OUTLINE_STYLES.candidate).toEqual({ fill: null, line: 'fg', width: 1.5, dash: [3, 2] });
    expect(OUTLINE_ORDER.indexOf('candidate')).toBeGreaterThan(OUTLINE_ORDER.indexOf('body'));
    const ids = glLayerIds();
    expect(ids.indexOf('body-console-outline-candidate')).toBeGreaterThan(
      ids.indexOf('body-console-outline-body'),
    );
    // No fill layer: a candidate never hides the shore under it.
    expect(ids).not.toContain('body-console-fill-candidate');
  });

  it('draw a gap as a quiet dashed rule in pixels, ticked at both ends, never a map layer', () => {
    expect(LINE_STYLES.gap).toEqual({ fill: null, line: 'fg2', width: 1, dash: [2, 3] });
    expect(PIXEL_RULES).toContain('gap');
    expect(LINE_ORDER).not.toContain('gap');
    expect(glLayerIds()).not.toContain('body-console-line-gap');
  });

  it('reach the still as their style says', () => {
    const scene: BodyMapScene = {
      items: [
        { kind: 'outline', id: 'cand', layer: 'outline', geometry: square, style: 'candidate' },
        {
          kind: 'line',
          id: 'gap',
          layer: 'marks',
          path: [at(0.1, 0.1), at(0.3, 0.3)],
          style: 'gap',
        },
      ],
    };
    const { container } = render(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={scene}
        resetKey="k"
        width={400}
        height={300}
      />,
    );
    const cand = container.querySelector('path[data-id="cand"]');
    expect(cand?.getAttribute('stroke')).toBe('var(--fg)');
    expect(cand?.getAttribute('stroke-dasharray')).toBe('4.5 3');
    // No fill plate under it (a fill is the still's one path without an id).
    expect(
      container.querySelectorAll('[data-slot="body-map-still"] path:not([data-id])'),
    ).toHaveLength(0);
    expect(cand?.getAttribute('fill')).toBe('none');
    // The gap is the pane's, in pixels: a dashed run and two solid ticks, nothing in the still.
    expect(container.querySelector('[data-slot="body-map-still"] [data-id="gap"]')).toBeNull();
    const gap = container.querySelector('[data-slot="body-map-dimension"][data-id="gap"]');
    const run = gap?.querySelector('[data-slot="body-map-dimension-run"]');
    expect(run?.getAttribute('stroke-dasharray')).toBe('2 3');
    expect(run?.getAttribute('stroke')).toBe('var(--fg2)');
    const ticks = gap?.querySelector('[data-slot="body-map-dimension-ticks"]');
    expect(ticks?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(ticks).not.toHaveAttribute('stroke-dasharray');
  });
});

describe('the new points', () => {
  const faces: [MapPointMark, string, string | null][] = [
    ['reticle', 'reticle-mark', 'bad'],
    ['asked', 'reticle-mark', 'fg'],
    ['lookalike', 'lookalike-mark', null],
  ];

  it.each(faces)('draw %s with its own face', (mark, slot, tone) => {
    const { container } = render(<PointFace mark={mark} />);
    const svg = container.querySelector(`[data-slot="${slot}"]`);
    expect(svg).not.toBeNull();
    if (tone) expect(svg?.getAttribute('data-tone')).toBe(tone);
  });

  it('are never listed in the key — they point at a place, they are not a kind of thing', () => {
    const { container } = render(<BodyMapKey kinds={['reticle', 'asked', 'lookalike', 'putIn']} />);
    const keys = [...container.querySelectorAll('[data-key]')].map((k) =>
      k.getAttribute('data-key'),
    );
    expect(keys).toEqual(['putIn']);
    const none = render(<BodyMapKey kinds={['reticle', 'lookalike']} />);
    expect(none.container.querySelector('[data-slot="map-key"]')).toBeNull();
  });
});

describe('the pane without a rack', () => {
  const drawn = drawScene({ items: [] }, layerSwitches({}));

  it('draws no rack at all, and puts the plate in the rack’s corner', () => {
    const { container } = render(
      <BodyMapPane surface={null} ground={null} drawn={drawn} rack={false} plate={<b>Legend</b>} />,
    );
    expect(container.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
    const plate = container.querySelector('[data-slot="body-map-plate"]');
    expect(plate).toHaveTextContent('Legend');
    expect(plate).toHaveAttribute('data-map-ui');
    expect(plate?.className).toContain('left-(--space-3)');
  });

  it('beside a rack, puts the plate top right; with no plate, draws none', () => {
    const rack = [{ layer: 'outline' as const, on: true, available: true }];
    const { container } = render(
      <BodyMapPane surface={null} ground={null} drawn={drawn} rack={rack} plate="Legend" />,
    );
    expect(container.querySelector('[data-slot="map-layer-rack"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="body-map-plate"]')?.className).toContain(
      'right-(--space-3)',
    );
    const bare = render(<BodyMapPane surface={null} ground={null} drawn={drawn} rack={rack} />);
    expect(bare.container.querySelector('[data-slot="body-map-plate"]')).toBeNull();
  });
});
