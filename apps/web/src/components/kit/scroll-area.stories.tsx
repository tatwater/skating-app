import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';

import { computedColor, resolvePx, sameColor } from './measure';
import { ScrollArea } from './scroll-area';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/ScrollArea',
  component: ScrollArea,
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const LANES = [
  'Weather',
  'Imagery',
  'Enrichment',
  'Rollovers',
  'Notifications',
  'Analytics',
  'Hygiene',
  'Health',
  'Cost ledger',
  'Season watch',
  'Corpus refits',
  'Place names',
  'Landmarks',
  'Access lots',
];

function Rows({ count = LANES.length }: { count?: number }) {
  return (
    <ul className="m-0 list-none p-0">
      {LANES.slice(0, count).map((lane, i) => (
        <li
          key={lane}
          data-row=""
          className="flex h-td items-center justify-between border-0 border-b border-dotted border-line text-row text-fg1"
        >
          <span>{lane}</span>
          <span className="font-(family-name:--family-mono) text-mono-sm text-fg3">
            {(i + 3) * 7} runs
          </span>
        </li>
      ))}
    </ul>
  );
}

const parts = (scope: Element) => ({
  root: must(scope.querySelector<HTMLElement>('[data-slot="scroll-area"]')),
  viewport: must(scope.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')),
  content: must(scope.querySelector<HTMLElement>('[data-slot="scroll-area-content"]')),
  bar: scope.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]'),
  thumb: scope.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]'),
});

const ms = (duration: string) =>
  duration.endsWith('ms') ? parseFloat(duration) : parseFloat(duration) * 1000;

/**
 * A pane's list: the bar is out of sight at rest and fades in while the pointer is over the
 * pane. Its thumb is a thin square bar, not a pill.
 */
export const Pane: Story = {
  render: () => (
    <ScrollArea className="h-[14rem] w-[20rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const { root, bar, thumb } = parts(canvasElement);
    await waitFor(() => expect(must(bar)).toBeInTheDocument());
    const b = must(bar);
    const t = must(thumb);
    await expect(getComputedStyle(b).opacity).toBe('0');
    const style = getComputedStyle(t);
    await expect(style.borderRadius).toBe('0px');
    await expect(t.getBoundingClientRect().width).toBeCloseTo(
      resolvePx(root, 'var(--stroke-run)'),
      1,
    );
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(t, 'var(--fg3)')));
    await userEvent.hover(root);
    await waitFor(() => expect(b).toHaveAttribute('data-hovering'));
    await waitFor(() => expect(getComputedStyle(b).opacity).toBe('1'));
    await userEvent.unhover(root);
    await waitFor(() => expect(b).not.toHaveAttribute('data-hovering'));
  },
};

/**
 * The gutter: an area with nothing to scroll and one with a long list lay their content out at
 * the same width — the bar's lane is reserved in both — and showing the bar moves nothing.
 */
export const StableGutter: Story = {
  render: () => (
    <div className="flex gap-(--space-6)">
      <div data-case="short">
        <p className={KICKER}>Fits</p>
        <ScrollArea className="h-[12rem] w-[16rem] border border-solid border-line">
          <Rows count={3} />
        </ScrollArea>
      </div>
      <div data-case="long">
        <p className={KICKER}>Scrolls</p>
        <ScrollArea className="h-[12rem] w-[16rem] border border-solid border-line">
          <Rows />
        </ScrollArea>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const short = parts(must(canvasElement.querySelector('[data-case="short"]')));
    const long = parts(must(canvasElement.querySelector('[data-case="long"]')));
    await waitFor(() => expect(long.bar).not.toBeNull());
    // Nothing to scroll: no bar at all — but the lane is still kept.
    await expect(short.bar).toBeNull();
    const row = (scope: { content: HTMLElement }) =>
      must(scope.content.querySelector('[data-row]')).getBoundingClientRect();
    const lane = resolvePx(long.root, 'var(--scroll-lane)');
    await expect(row(short).width).toBe(row(long).width);
    await expect(row(long).width).toBeCloseTo(long.viewport.clientWidth - lane, 1);
    // The lane is the bar: the bar fills exactly the space the content leaves.
    const bar = must(long.bar).getBoundingClientRect();
    await expect(bar.width).toBeCloseTo(lane, 1);
    await expect(Math.abs(bar.left - row(long).right)).toBeLessThanOrEqual(0.5);
    // Showing the bar shifts nothing.
    const before = row(long);
    await userEvent.hover(long.root);
    await waitFor(() => expect(getComputedStyle(must(long.bar)).opacity).toBe('1'));
    const after = row(long);
    await expect([after.left, after.width]).toEqual([before.left, before.width]);
    await userEvent.unhover(long.root);
  },
};

/** Scrolling shows the bar too, and the thumb travels the track's length, inset at its ends. */
export const Scrolling: Story = {
  render: () => (
    <ScrollArea className="h-[12rem] w-[18rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const { root, viewport } = parts(canvasElement);
    const bar = await waitFor(() => must(parts(canvasElement).bar));
    const thumb = must(parts(canvasElement).thumb);
    // A wheel first: Base UI shows the bar for a scroll the user makes, not a programmatic one.
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 }));
    viewport.scrollTop = viewport.scrollHeight;
    await waitFor(() => expect(bar).toHaveAttribute('data-scrolling'));
    await waitFor(() => expect(getComputedStyle(bar).opacity).toBe('1'));
    const end = resolvePx(root, 'var(--space-1_5)');
    await waitFor(() =>
      expect(
        Math.abs(bar.getBoundingClientRect().bottom - end - thumb.getBoundingClientRect().bottom),
      ).toBeLessThanOrEqual(1),
    );
    viewport.scrollTop = 0;
    await waitFor(() =>
      expect(
        Math.abs(thumb.getBoundingClientRect().top - bar.getBoundingClientRect().top - end),
      ).toBeLessThanOrEqual(1),
    );
  },
};

/**
 * From the keyboard: the viewport is a tab stop while it has something to scroll; focus shows the
 * bar and marks the viewport with an inset hairline.
 */
export const Keyboard: Story = {
  render: () => (
    <ScrollArea className="h-[12rem] w-[18rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const { viewport } = parts(canvasElement);
    const bar = await waitFor(() => must(parts(canvasElement).bar));
    await waitFor(() => expect(viewport.tabIndex).toBe(0));
    await userEvent.tab();
    await expect(viewport).toHaveFocus();
    await waitFor(() => expect(getComputedStyle(bar).opacity).toBe('1'));
    await expect(getComputedStyle(viewport).boxShadow).toMatch(/inset/);
    viewport.blur();
  },
};

/**
 * The log: its thumb stays in view, so a still render shows the box scrolls. Mono lines on the
 * panel ground, the box's edge in `line`.
 */
export const Always: Story = {
  render: () => (
    <ScrollArea
      always
      className="h-[10rem] w-[24rem] border border-solid border-line bg-panel"
      viewportClassName="py-(--space-2) pl-(--space-3_5)"
    >
      {Array.from({ length: 24 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample log
          key={i}
          className="font-(family-name:--family-mono) text-mono-sm leading-(--lead-list) text-fg2"
        >
          {`21:${String(4 + Math.floor(i / 6)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')} weather · fetched ${i + 1} of 24 bodies`}
        </div>
      ))}
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const bar = await waitFor(() => must(parts(canvasElement).bar));
    await expect(bar).not.toHaveAttribute('data-hovering');
    await expect(getComputedStyle(bar).opacity).toBe('1');
    // The track is drawn: the lane's content box, in `raise`.
    await expect(getComputedStyle(bar).backgroundColor).toEqual(
      sameColor(computedColor(bar, 'var(--raise)')),
    );
    await expect(getComputedStyle(bar).backgroundClip).toBe('content-box');
  },
};

const COLUMNS = ['Body', 'Town', 'Acres', 'Reports', 'Last report', 'Lane', 'Imagery', 'Names'];

function WideTable({ rows = 12 }: { rows?: number }) {
  return (
    <table className="border-collapse text-row whitespace-nowrap text-fg1">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c} className={`${KICKER} px-(--space-5) pb-(--space-2) text-left`}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample table
          <tr key={r} className="h-td border-0 border-b border-dotted border-line">
            {COLUMNS.map((c, i) => (
              <td key={c} className="px-(--space-5)">
                {i === 0 ? `Pond ${r + 1}` : `${c} ${r + 1}`}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Sideways only: a wide table keeps its height; the lane runs along the bottom. */
export const Horizontal: Story = {
  render: () => (
    <ScrollArea axes="x" className="w-[22rem] border border-solid border-line">
      <WideTable rows={4} />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const { root, viewport } = parts(canvasElement);
    const bar = await waitFor(() => must(parts(canvasElement).bar));
    await expect(bar).toHaveAttribute('data-orientation', 'horizontal');
    await expect(
      canvasElement.querySelectorAll('[data-slot="scroll-area-scrollbar"]'),
    ).toHaveLength(1);
    const lane = resolvePx(root, 'var(--scroll-lane)');
    await expect(parseFloat(getComputedStyle(viewport).paddingBottom)).toBeCloseTo(lane, 1);
    await expect(bar.getBoundingClientRect().height).toBeCloseTo(lane, 1);
    await expect(getComputedStyle(viewport).overflowY).toBe('hidden');
  },
};

/** Both ways: two lanes and the corner where they meet. */
export const BothAxes: Story = {
  render: () => (
    <ScrollArea axes="both" className="h-[12rem] w-[22rem] border border-solid border-line">
      <WideTable />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-slot="scroll-area-scrollbar"]')).toHaveLength(2),
    );
    await expect(canvasElement.querySelector('[data-slot="scroll-area-corner"]')).not.toBeNull();
  },
};

/** No gutter: the bar overlays the content (a map, an image) — the content takes the full width. */
export const Overlay: Story = {
  render: () => (
    <ScrollArea gutter={false} className="h-[12rem] w-[18rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const { viewport, content } = parts(canvasElement);
    const row = must(content.querySelector('[data-row]')).getBoundingClientRect();
    await expect(row.width).toBeCloseTo(viewport.clientWidth, 1);
  },
};

/** The fade rides the motion tokens (instant under reduced motion, where they're zero). */
export const MotionTokens: Story = {
  render: () => (
    <ScrollArea className="h-[10rem] w-[16rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const bar = await waitFor(() => must(parts(canvasElement).bar));
    const base = getComputedStyle(bar).getPropertyValue('--duration-base').trim();
    await expect(ms(getComputedStyle(bar).transitionDuration)).toBe(ms(base));
    await expect(getComputedStyle(bar).transitionProperty).toBe('opacity');
  },
};

export const FourUp: Story = {
  render: () => (
    <ScrollArea always className="h-[9rem] w-[16rem] border border-solid border-line">
      <Rows />
    </ScrollArea>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const thumb = await waitFor(() => must(parts(q).thumb));
      await expect(getComputedStyle(thumb).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--fg3)')),
      );
      await expect(thumb.getBoundingClientRect().width).toBeCloseTo(
        resolvePx(q, 'var(--stroke-run)'),
        1,
      );
    }
  },
};
