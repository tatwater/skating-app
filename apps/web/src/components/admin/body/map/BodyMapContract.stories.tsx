import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { hazardsMapScene } from '../tabs/hazards/hazardsMap';
import { BodyMapStillView } from './BodyMap';
import { mergeScenes } from './bodyScene';
import type { BodyMapScene } from './mapDescriptors';

/**
 * The map contract's later members, drawn over the still (the live map's tiles answer only a local
 * dev address): a hazard's dot field fresh and stale, a dimension line with its measure, an
 * approach, a proposal, a captioned plate on the lit point, a tab's dock in the foot slot, and a
 * hazard whose shape can't be drawn, pinned.
 */
const meta = {
  title: 'Admin/Body/Map contract',
  component: BodyMapStillView,
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof BodyMapStillView>;

export default meta;
type Story = StoryObj<typeof meta>;

const { minLng: w, maxLng: e, minLat: s, maxLat: n } = MASCOMA_BOUNDS;
const at = (fx: number, fy: number) => [w + (e - w) * fx, s + (n - s) * fy] as const;
const box = (fx: number, fy: number, size: number): GeoJSON.Polygon => {
  const [x, y] = at(fx, fy);
  const d = (e - w) * size;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + d, y],
        [x + d, y + d],
        [x, y + d],
        [x, y],
      ],
    ],
  };
};

const TAB: BodyMapScene = {
  items: [
    {
      kind: 'outline',
      id: 'hazard:fresh',
      layer: 'hazards',
      style: 'footprint',
      geometry: box(0.45, 0.55, 0.06),
      field: { freshness: 'fresh', tone: 'hazard', provisional: false },
    },
    {
      kind: 'outline',
      id: 'hazard:stale',
      layer: 'hazards',
      style: 'footprint',
      geometry: box(0.6, 0.3, 0.06),
      field: { freshness: 'stale', tone: 'healing', provisional: true },
    },
    {
      kind: 'line',
      id: 'dim:ew',
      layer: 'samples',
      path: [at(0, -0.06), at(1, -0.06)],
      style: 'dimension',
    },
    {
      kind: 'label',
      id: 'dim:ew:len',
      layer: 'samples',
      at: at(0.5, -0.06),
      text: '4.9 KM',
      style: 'measure',
    },
    {
      kind: 'line',
      id: 'walk:1',
      layer: 'putIns',
      path: [at(0.05, 0.9), at(0.1, 0.8)],
      style: 'approach',
    },
    {
      kind: 'point',
      id: 'proposal:1',
      layer: 'marks',
      at: at(0.3, 0.4),
      mark: 'proposal',
      name: 'the flats',
    },
    {
      kind: 'point',
      id: 'interior:point',
      layer: 'samples',
      at: at(0.5, 0.5),
      mark: 'sample',
      hoverKicker: 'Interior point',
      name: '43.63° N, 72.15° W',
      caption: 'Windy and Copernicus open here',
    },
  ],
  lit: 'interior:point',
  layers: { hazards: true, samples: true },
};

/**
 * Hazards whose shape can't be drawn, as the Hazards tab hands them (`hazardsMapScene`): a stale,
 * unconfirmed one pinned beside a field of the same freshness, a healing one, and a known feature —
 * each its own mark at its reported point, at the fade its field would have had, and the lit one's
 * plate saying the shape is unknown.
 */
const lostRadius = (fx: number, fy: number) => ({
  geometryKind: 'point_radius' as const,
  geometry: { type: 'Point', coordinates: [...at(fx, fy)] },
  radiusMeters: Number.NaN,
});
const SHAPE_UNKNOWN = hazardsMapScene(
  {
    season: 2025,
    current: 2025,
    hazards: [
      {
        _id: 'stale-field',
        type: 'thin_ice',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [...at(0.4, 0.6)] },
        radiusMeters: 120,
        freshness: 'stale',
        provisional: true,
      },
      {
        _id: 'stale-pin',
        type: 'thin_ice',
        ...lostRadius(0.6, 0.6),
        freshness: 'stale',
        provisional: true,
      },
      {
        _id: 'healing-pin',
        type: 'wet_crack',
        ...lostRadius(0.55, 0.35),
        freshness: 'fresh',
        provisional: false,
        healingState: 'healing_unsafe',
      },
    ],
    features: [{ _id: 'feature-pin', type: 'spring_current', ...lostRadius(0.3, 0.3) }],
  },
  'hazard:stale-pin',
);

export const ShapeUnknown: Story = {
  args: {
    bbox: MASCOMA_BOUNDS,
    scene: mergeScenes(MASCOMA_SCENE, SHAPE_UNKNOWN),
    resetKey: 'shape-unknown',
    width: 656,
    height: 830,
  },
  play: async ({ canvasElement }) => {
    const pin = (id: string) =>
      must(
        canvasElement.querySelector<HTMLElement>(`[data-slot="body-map-point"][data-id="${id}"]`),
      );
    // Each is its own hazard's mark: the warning, the healing one, the feature's.
    await expect(pin('hazard:stale-pin')).toHaveAttribute('data-mark', 'hazard');
    await expect(pin('hazard:healing-pin')).toHaveAttribute('data-mark', 'healing');
    await expect(pin('feature:feature-pin')).toHaveAttribute('data-mark', 'feature');
    // Never a lesser hazard: the pin fades exactly as far as a field of the same freshness.
    const dot = must(
      canvasElement.querySelector('[data-slot="body-map-dot"][data-id="hazard:stale-field"]'),
    );
    await expect(Number(getComputedStyle(pin('hazard:stale-pin')).opacity)).toBeCloseTo(
      Number(dot.getAttribute('fill-opacity')),
    );
    await expect(Number(getComputedStyle(pin('hazard:healing-pin')).opacity)).toBe(1);
    await expect(Number(getComputedStyle(pin('feature:feature-pin')).opacity)).toBe(1);
    // The lit pin's plate names the hazard and says its shape is unknown — never the hazard.
    const plate = must(canvasElement.querySelector('[data-slot="map-hover-plate"]'));
    await expect(plate).toHaveTextContent('Thin ice');
    await expect(
      must(canvasElement.querySelector('[data-slot="map-hover-plate-caption"]')),
    ).toHaveTextContent('Shape unknown');
    await expect(must(canvasElement.querySelector('[data-slot="map-key"]'))).toHaveTextContent(
      'Hazard',
    );
  },
};

/** Everything the tabs asked of the map, drawn at once. */
export const Members: Story = {
  args: {
    bbox: MASCOMA_BOUNDS,
    scene: mergeScenes(MASCOMA_SCENE, TAB),
    resetKey: 'contract',
    width: 656,
    height: 830,
    foot: <div className="h-(--space-8) bg-map-plate text-row text-fg">The tab’s dock</div>,
  },
  play: async ({ canvasElement }) => {
    const dots = canvasElement.querySelectorAll<SVGCircleElement>('[data-slot="body-map-dot"]');
    await expect(dots.length).toBeGreaterThan(0);
    // The stale, unconfirmed field is faded and still drawn — never gone (D3).
    const stale = [...dots].filter((d) => d.dataset.id === 'hazard:stale');
    await expect(stale.length).toBeGreaterThan(0);
    for (const d of stale)
      await expect(Number(d.getAttribute('fill-opacity'))).toBeGreaterThan(0.2);
    // The dimension line wears its two ticks; its measure sits on it.
    const dim = must(canvasElement.querySelector('[data-slot="body-map-dimension"]'));
    await expect((dim.getAttribute('d') ?? '').match(/M/g)).toHaveLength(3);
    await expect(must(canvasElement.querySelector('[data-style="measure"]'))).toHaveTextContent(
      '4.9 KM',
    );
    await expect(
      must(canvasElement.querySelector('[data-slot="body-map-point"][data-mark="proposal"]')),
    ).toBeInTheDocument();
    // The lit point's plate shows, with its caption, and every other mark steps back.
    const caption = must(canvasElement.querySelector('[data-slot="map-hover-plate-caption"]'));
    await expect(caption).toHaveTextContent('Windy and Copernicus open here');
    await expect(must(canvasElement.querySelector('[data-mark="proposal"] svg'))).toHaveAttribute(
      'data-fade',
    );
    // The dock sits in the foot slot, over the key.
    const foot = must(canvasElement.querySelector<HTMLElement>('[data-slot="body-map-foot"]'));
    const key = must(canvasElement.querySelector<HTMLElement>('[data-slot="map-key"]'));
    await expect(foot.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      key.getBoundingClientRect().top + 0.5,
    );
    await expect(key).toHaveTextContent('Proposal');
  },
};
