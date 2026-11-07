import type { Meta, StoryObj } from '@storybook/react-vite';
import 'maplibre-gl/dist/maplibre-gl.css';
import { expect, waitFor, within } from 'storybook/test';

import { MapPane } from '@/components/kit/map-controls';
import { MAP_CONTAINER_CLASS } from '@/lib/mapCanvas';

/**
 * **A measurement story, not a picture** (D234's junctions): it holds the one rule every MapLibre
 * container in this app obeys — size it with a height, never with `absolute inset-0`.
 *
 * It belongs in a browser, because the bug it guards is a cascade order. MapLibre's stylesheet
 * (imported here, exactly as the canvas chunk imports it) declares
 * `.maplibregl-map { position: relative }`. That is one class, and so is Tailwind's `.absolute`,
 * so whichever sheet is loaded later wins — and MapLibre's is, because it rides a lazy chunk. A
 * container asking for `absolute inset-0` is quietly put back into the normal flow with its insets
 * ignored, which leaves it **zero tall**; MapLibre reads `height || 300` and draws a 300 px strip
 * or nothing. No error, no warning, just a blank map (B03: Explore shipped that way).
 *
 * jsdom has no cascade and no layout, so a unit test cannot see any of this. The assertion is the
 * measurement: the container fills the pane it is given, both ways.
 */
const PANE = { width: 420, height: 260 };

function Harness() {
  return (
    <MapPane data-testid="pane" style={{ width: PANE.width, height: PANE.height }}>
      {/* Exactly what `SkaterMapCanvas` and `InstrumentMapCanvas` hand MapLibre, plus the class
          MapLibre itself puts on that element once it takes it over. */}
      <div data-testid="container" className={`${MAP_CONTAINER_CLASS} maplibregl-map`} />
    </MapPane>
  );
}

const meta = {
  title: 'Skater/Map/Container',
  component: Harness,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The MapLibre container fills its pane. MapLibre’s own CSS forces `position: relative` on it, so it must be sized by height and width, never by `absolute inset-0`.',
      },
    },
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FillsItsPane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const container = await canvas.findByTestId('container');

    await waitFor(() => {
      const box = container.getBoundingClientRect();
      // The whole pane, not MapLibre's 300 px fallback and not a collapsed zero.
      expect(Math.round(box.height)).toBe(PANE.height);
      expect(Math.round(box.width)).toBe(PANE.width);
    });

    // And the reason it works: nothing in the app's class list fights MapLibre's `position`.
    expect(getComputedStyle(container).position).toBe('relative');
    expect(MAP_CONTAINER_CLASS).not.toMatch(/\babsolute\b|\binset-0\b|\bfixed\b/);
  },
};
