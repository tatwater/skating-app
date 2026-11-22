import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../.storybook/theme';
import { InboxMapStill } from './InboxMap';
import {
  ACCESS,
  ADMIT,
  ADMIT_NO_MATCH,
  ALERT,
  DRAWN,
  LOOKALIKE,
  REPORT_POINT,
} from './inboxMapFixtures';
import {
  accessScene,
  admitScene,
  alertScene,
  drawnScene,
  type InboxMapView,
  lookalikeScene,
  reportPointScene,
} from './inboxMapScene';

/**
 * The Inbox's map embed on each board, at the board's size, in both modes — over the still (the
 * automated browser can't load the basemap's tiles, so the live canvas is the app's to show).
 */
const meta = {
  title: 'Admin/Inbox/Map',
  component: InboxMapStill,
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta<typeof InboxMapStill>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One embed per mode, each at the board's width and height. */
function Pair({ view, width, height }: { view: InboxMapView; width: number; height: number }) {
  return (
    <ThemePair surface="admin" columns="one">
      {() => (
        <InboxMapStill view={view} width={width} height={height} className="border border-line" />
      )}
    </ThemePair>
  );
}

const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];
const markIn = (q: ParentNode, mark: string) =>
  must(q.querySelector<HTMLElement>(`[data-slot="body-map-point"][data-mark="${mark}"]`));

/** 2.1 Safety · Unsafe report: the report point in the hazard red on Mascoma Lake. */
export const ReportPoint: Story = {
  args: { view: reportPointScene(REPORT_POINT), width: 280, height: 446 },
  render: (args) => <Pair {...args} height={args.height ?? 446} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const ring = must(markIn(q, 'reticle').querySelector('circle'));
      await expect(getComputedStyle(ring).stroke).toEqual(
        sameColor(computedColor(q, 'var(--bad)')),
      );
      await expect(q.querySelector('[data-slot="inbox-map-caption"]')).toHaveTextContent(
        'Report point · town beach',
      );
      await expect(q.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
      await expect(q.querySelector('[data-slot="map-key"]')).toBeNull();
    }
  },
};

/** The zoom pair from the keyboard: Tab reaches Zoom in, Enter zooms, ↓ and Enter zoom back out. */
export const KeyboardZoom: Story = {
  args: { view: reportPointScene(REPORT_POINT), width: 280, height: 360 },
  render: (args) => (
    <div className="bg-bg p-(--space-4)">
      <InboxMapStill {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const scale = () =>
      must(canvasElement.querySelector('[data-slot="map-scale"]')).getAttribute('aria-label');
    const framed = scale();
    await userEvent.tab();
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Zoom in'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(scale()).not.toBe(framed));
    // The pair is one tab stop (the kit's roving group): the arrow walks to its other member.
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Zoom out'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(scale()).toBe(framed));
  },
};

/** 2.2 Access reports · Dispute: Tomhannock Reservoir and its dam-road launch. */
export const Access: Story = {
  args: { view: accessScene(ACCESS), width: 336, height: 300 },
  render: (args) => <Pair {...args} height={args.height ?? 300} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) await expect(markIn(q, 'putIn')).toBeInTheDocument();
  },
};

/** 2.3 Requests · Admit: the catalog candidate, the skate, Ricker Pond and the rule to it. */
export const Admit: Story = {
  args: { view: admitScene(ADMIT), width: 788, height: 318 },
  render: (args) => <Pair {...args} height={args.height ?? 318} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q.querySelectorAll('[data-slot="map-legend-item"]')).toHaveLength(3);
      await expect(must(q.querySelector('[data-style="measure"]')).textContent).toMatch(/mi$/);
      // The distance rule is ticked at both ends, solid, over a dashed run.
      const rule = must(q.querySelector('[data-slot="body-map-dimension"][data-style="gap"]'));
      await expect(
        must(rule.querySelector('[data-slot="body-map-dimension-ticks"]')).getAttribute('d'),
      ).toMatch(/^M.* M/);
      await expect(q.querySelector('[data-slot="inbox-map-caption"]')).toHaveTextContent(
        'Unnamed · 41 ac',
      );
      // The candidate's dashed stroke on the map is the legend's first swatch.
      const onMap = must(q.querySelector('path[data-id="candidate:yq4k2"]'));
      const swatch = must(q.querySelector('[data-slot="map-legend-swatch"] path'));
      await expect(swatch.getAttribute('stroke')).toBe(onMap.getAttribute('stroke'));
      await expect(swatch.getAttribute('stroke-dasharray')).toBe(
        onMap.getAttribute('stroke-dasharray'),
      );
    }
  },
};

/** An admit no catalog feature matched: the asked point alone, and its caption. */
export const AdmitNoMatch: Story = {
  args: { view: admitScene(ADMIT_NO_MATCH), width: 788, height: 318 },
  render: (args) => <Pair {...args} height={args.height ?? 318} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) await expect(markIn(q, 'asked')).toBeInTheDocument();
  },
};

/** 2.4 Places asked · Lookalike: the asked point, The Narrows 0.4 mi north, the rule between. */
export const Lookalike: Story = {
  args: { view: lookalikeScene(LOOKALIKE), width: 380, height: 290 },
  render: (args) => <Pair {...args} height={args.height ?? 290} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const ring = must(markIn(q, 'lookalike').querySelector('circle'));
      await expect(getComputedStyle(ring).stroke).toEqual(
        sameColor(computedColor(q, 'var(--warn)')),
      );
      await expect(must(q.querySelector('[data-style="measure"]'))).toHaveTextContent('0.4 mi');
    }
  },
};

/** 2.5 Drawn bodies · Merge: the drawing dashed over Caspian Lake, and the skate. */
export const Drawn: Story = {
  args: { view: drawnScene(DRAWN), width: 788, height: 336 },
  render: (args) => <Pair {...args} height={args.height ?? 336} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q.querySelectorAll('[data-slot="map-legend-item"]')).toHaveLength(3);
      await expect(q.querySelector('path[data-id="drawn:drawn-kd"]')).toBeInTheDocument();
    }
  },
};

/**
 * 2.5 with its Aerial switch: the body's pass (painted only on the live map — a still has no
 * archive) under the outlines, on by default, switched from the keyboard.
 */
export const DrawnAerialSwitch: Story = {
  args: { view: drawnScene(DRAWN), width: 788, height: 336 },
  render: (args) => (
    <div className="bg-bg p-(--space-4)">
      <InboxMapStill {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const aerial = () => must(canvasElement.querySelector<HTMLElement>('[role="switch"]'));
    await expect(aerial()).toHaveAccessibleName(/Aerial/);
    await expect(aerial()).toBeChecked();
    // The switch sits in the foot's left corner, under the legend, clear of the zoom pair.
    const plate = must(canvasElement.querySelector('[data-slot="body-map-plate"]'));
    const zoom = must(canvasElement.querySelector('[data-map-zoom]'));
    const sw = aerial().getBoundingClientRect();
    await expect(sw.top).toBeGreaterThan(plate.getBoundingClientRect().bottom);
    await expect(sw.right).toBeLessThan(zoom.getBoundingClientRect().left);
    // The zoom pair is the first stop (one, a roving group); the switch the next.
    await userEvent.tab();
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Zoom in'));
    await userEvent.tab();
    await waitFor(() => expect(aerial()).toHaveFocus());
    await userEvent.keyboard(' ');
    await waitFor(() => expect(aerial()).not.toBeChecked());
  },
};

/** 2.6 Content flags · Access alert: the Fairlee launch lit and named, Bonnie Oaks beside. */
export const Alert: Story = {
  args: { view: alertScene(ALERT), width: 300, height: 305 },
  render: (args) => <Pair {...args} height={args.height ?? 305} />,
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(must(q.querySelector('[data-slot="inbox-map-caption"]'))).toHaveTextContent(
        'Fairlee town launch',
      );
      await expect(
        must(q.querySelector('[data-slot="body-map-point"][data-id="putIn:fairlee"]')),
      ).toHaveAttribute('data-lit');
    }
  },
};

/**
 * A phone, under the console's narrow rule: the inspector is the page, the embed its full width
 * (360 less the 16 px gutters) and view only — nothing overflows, the legend included.
 */
export const Narrow: Story = {
  args: { view: admitScene(ADMIT), width: 328, height: 240, viewOnly: true },
  render: (args) => (
    <div
      data-narrow-page=""
      className="w-[360px] overflow-hidden bg-bg px-(--space-4) py-(--space-4)"
    >
      <InboxMapStill {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const page = must(canvasElement.querySelector<HTMLElement>('[data-narrow-page]'));
    const embed = must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-map"]'));
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
    await expect(embed.scrollWidth).toBeLessThanOrEqual(embed.clientWidth);
    const plate = must(canvasElement.querySelector<HTMLElement>('[data-map-legend]'));
    await expect(plate.getBoundingClientRect().right).toBeLessThanOrEqual(
      embed.getBoundingClientRect().right + 0.5,
    );
    // View only: the zoom pair is gone, the scale stays.
    await expect(canvasElement.querySelector('[data-map-zoom]')).not.toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="map-scale"]')).toBeVisible();
  },
};
