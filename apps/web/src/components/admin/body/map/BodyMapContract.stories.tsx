import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { BodyMapStillView } from './BodyMap';
import { mergeScenes } from './bodyScene';
import type { BodyMapScene } from './mapDescriptors';

/**
 * The map contract's later members, drawn over the still (the live map's tiles answer only a local
 * dev address): a hazard's dot field fresh and stale, a dimension line with its measure, an
 * approach, a proposal, a captioned plate on the lit point, and a tab's dock in the foot slot.
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
