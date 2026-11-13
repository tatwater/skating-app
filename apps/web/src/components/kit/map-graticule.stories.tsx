import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties } from 'react';
import { expect } from 'storybook/test';
import { fitCamera, stillSurface } from '@/lib/mapSurface';
import { graticuleLayout, type Rect } from './graticule';
import { MapGraticule } from './map-graticule';
import { PLACE_KEY_LABELS, PlaceMark, type PlaceMarkKind } from './map-marks';
import { computedColor, sameColor } from './measure';
import { faceLoaded, must } from './storyKit';

/** Mascoma Lake's bounds (the Body console boards' lake): real geography for the drawing. */
const MASCOMA_BOUNDS = {
  maxLat: 43.6497901,
  maxLng: -72.1206902,
  minLat: 43.6061979,
  minLng: -72.1819521,
};

/**
 * From the Body console's map (board 5.4.1): the graticule labeled at a pane's edges,
 * and the place marks. Each in all four maps.
 */
const meta = {
  title: 'Kit/MapGraticule',
  component: MapGraticule,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MapGraticule>;

export default meta;
type Story = StoryObj<typeof meta>;

const W = 440;
const H = 300;
const surface = stillSurface(
  W,
  H,
  fitCamera(MASCOMA_BOUNDS, W, H, { top: 20, right: 70, bottom: 30, left: 20 }),
);
/** A keep-out where a dock would sit: no label is set on it. */
const DOCK: Rect = { left: W - 60, top: H - 90, right: W - 10, bottom: H - 40 };
const layout = graticuleLayout({ ...surface, minSpacing: 40, keepouts: [DOCK] });

function Pane() {
  return (
    <div
      data-testid="pane"
      className="relative overflow-hidden bg-map-earth"
      style={{ width: W, height: H } as CSSProperties}
    >
      <MapGraticule layout={layout} width={W} height={H} />
      <div
        className="absolute border border-dashed border-line2"
        style={{
          left: DOCK.left,
          top: DOCK.top,
          width: DOCK.right - DOCK.left,
          height: DOCK.bottom - DOCK.top,
        }}
      />
    </div>
  );
}

/** The graticule over Mascoma's frame, with a dock's keep-out drawn dashed. */
export const FourUp: Story = {
  args: { layout, width: W, height: H },
  render: () => <Pane />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const label = must(q.querySelector<SVGTextElement>('[data-slot="map-graticule-label"]'));
      await faceLoaded(label);
      await expect(getComputedStyle(label).fill).toEqual(sameColor(computedColor(q, 'var(--fg3)')));
      const lines = must(q.querySelector<SVGGElement>('[data-slot="map-graticule-lines"]'));
      await expect(getComputedStyle(lines).stroke).toEqual(
        sameColor(computedColor(q, 'var(--lift-05)')),
      );
      // Re-queried on each pass: no label box crosses the keep-out.
      const pane = must(
        q.querySelector<HTMLElement>('[data-testid="pane"]'),
      ).getBoundingClientRect();
      for (const t of q.querySelectorAll<SVGTextElement>('[data-slot="map-graticule-label"]')) {
        const r = t.getBoundingClientRect();
        const hit =
          r.left - pane.left < DOCK.right &&
          r.right - pane.left > DOCK.left &&
          r.top - pane.top < DOCK.bottom &&
          r.bottom - pane.top > DOCK.top;
        await expect(hit).toBe(false);
      }
    }
  },
};

const KINDS = Object.keys(PLACE_KEY_LABELS) as PlaceMarkKind[];

/** Every place mark at mark size (at rest, highlighted, dimmed) and at key size, in all four maps. */
export const PlaceMarks: Story = {
  args: { layout, width: W, height: H },
  render: () => (
    <div
      className="flex flex-col gap-(--space-3)"
      style={{ '--map-ground': 'var(--map-earth)' } as CSSProperties}
    >
      {KINDS.map((kind) => (
        <div
          key={kind}
          data-kind-row={kind}
          className="flex items-center gap-(--space-3) text-kick text-fg2 uppercase"
        >
          <PlaceMark kind={kind} />
          <PlaceMark kind={kind} highlight />
          <PlaceMark kind={kind} fade />
          <PlaceMark kind={kind} glyph />
          {PLACE_KEY_LABELS[kind]}
        </div>
      ))}
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(q.querySelectorAll('[data-slot="place-mark"]')).toHaveLength(KINDS.length * 4);
      await expect(q.querySelectorAll('[data-slot="place-mark-brackets"]')).toHaveLength(
        KINDS.length,
      );
      // A hover elsewhere fades a place to the fade step (Review 13).
      const faded = must(q.querySelector<SVGElement>('[data-slot="place-mark"][data-fade]'));
      await expect(Number(getComputedStyle(faded).opacity)).toBeCloseTo(0.38, 2);
      // A river is water you can name: the dim ice; a town is land: gray.
      const river = must(
        q.querySelector('[data-kind-row="waterway"] [data-slot="place-mark"] g rect'),
      );
      await expect(getComputedStyle(river).fill).toEqual(
        sameColor(computedColor(q, 'var(--acc-dim)')),
      );
    }
  },
};
