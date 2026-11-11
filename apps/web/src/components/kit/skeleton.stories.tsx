import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { Skeleton, SkeletonBlock, SkeletonRow, SkeletonStat, SkeletonText } from './skeleton';
import { faceLoaded, KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A skeleton takes the **exact box** of what it replaces — same height, and the same width wherever the width is known — so nothing on the page moves when the content arrives. Give a text run the same type classes as its text, a stat its character count, a row its cell widths, and a map or chart block the same height class as the real one. Each story below renders the skeleton beside its real counterpart and asserts the two boxes are equal.',
      },
    },
  },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A story's `beforeEach`: the page's script sees `prefers-reduced-motion: reduce` (the CSS media
 * query is the browser's and can't be faked here; the script branch is what this exercises).
 */
function reduceMotion() {
  const real = window.matchMedia.bind(window);
  const spy = spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const list = real(query);
    if (!query.includes('prefers-reduced-motion')) return list;
    return {
      matches: true,
      media: query,
      onchange: null,
      addEventListener: list.addEventListener.bind(list),
      removeEventListener: list.removeEventListener.bind(list),
      addListener: list.addListener.bind(list),
      removeListener: list.removeListener.bind(list),
      dispatchEvent: list.dispatchEvent.bind(list),
    } satisfies MediaQueryList;
  });
  return () => spy.mockRestore();
}

/** Within a quarter pixel on both axes. */
async function expectSameBox(a: Element, b: Element, what: string) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  await expect(Math.abs(ra.width - rb.width), `${what} width`).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  await expect(Math.abs(ra.height - rb.height), `${what} height`).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
}

/** A loading region beside its loaded twin: skeleton on the left, content on the right. */
function Pair({ skeleton, real }: { skeleton: ReactNode; real: ReactNode }) {
  return (
    <div className="grid w-[24rem] grid-cols-2 items-start gap-(--space-6)">
      <section data-pair="skeleton" aria-busy="true" aria-label="Loading">
        {skeleton}
      </section>
      <div data-pair="real">{real}</div>
    </div>
  );
}

const pair = (root: HTMLElement) => ({
  skeleton: must(root.querySelector<HTMLElement>('[data-pair="skeleton"] > *')),
  real: must(root.querySelector<HTMLElement>('[data-pair="real"] > *')),
});

/** The wash: one lift of the ink, at the surface's control radius, and never announced. */
export const Wash: Story = {
  render: () => <Skeleton className="h-(--space-8) w-[12rem]" />,
  play: async ({ canvasElement }) => {
    const el = must(canvasElement.querySelector<HTMLElement>('[data-slot="skeleton"]'));
    await expect(el).toHaveAttribute('aria-hidden', 'true');
    const style = getComputedStyle(el);
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(el, 'var(--lift-08)')));
    await expect(parseFloat(style.borderTopLeftRadius)).toBeCloseTo(
      resolvePx(el, 'var(--corner-control)'),
      1,
    );
  },
};

/** One line of row text: the skeleton is that text's line box, to the pixel. */
export const TextRun: Story = {
  render: () => (
    <Pair
      skeleton={<SkeletonText className="text-row leading-list" width="100%" />}
      real={<p className="text-row leading-list text-fg1">Mascoma Lake</p>}
    />
  ),
  play: async ({ canvasElement }) => {
    const { skeleton, real } = pair(canvasElement);
    await expectSameBox(skeleton, real, 'row text');
    // It paints only the cap-height band inside the line box.
    const style = getComputedStyle(skeleton);
    await expect(style.backgroundClip).toBe('content-box');
    await expect(parseFloat(style.paddingTop)).toBeGreaterThan(0);
  },
};

/** A paragraph: one line box per line; the last line stops short, as a paragraph's does. */
export const Paragraph: Story = {
  render: () => (
    <Pair
      skeleton={<SkeletonText className="text-assist leading-body" lines={3} />}
      real={
        <p className="text-assist leading-body text-fg2">
          The flag stays open. Decide it next, or hand it to the person who filed it first.
        </p>
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const { skeleton, real } = pair(canvasElement);
    // Three lines either side.
    const line = resolvePx(real, '1lh');
    await expect(Math.round(real.getBoundingClientRect().height / line)).toBe(3);
    await expectSameBox(skeleton, real, 'paragraph');
    const lines = [...skeleton.querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
    await expect(lines).toHaveLength(3);
    const last = must(lines[2]).getBoundingClientRect().width;
    await expect(last).toBeCloseTo(skeleton.getBoundingClientRect().width * 0.6, 0);
  },
};

/** A stat value: the stat step in mono, exactly as wide as its characters. */
export const Stat: Story = {
  render: () => (
    <Pair
      skeleton={<SkeletonStat chars={6} />}
      real={
        <span className="block w-fit font-(family-name:--family-mono) text-stat leading-none tracking-value text-fg">
          $75.80
        </span>
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const { skeleton, real } = pair(canvasElement);
    // `ch` is the loaded face's: load the value's own face first (the fallback's digits are a
    // different width).
    await faceLoaded(real);
    await expectSameBox(skeleton, real, 'stat');
  },
};

/** A list row: the surface's row height, full width, its cells on the row gap. */
export const Row: Story = {
  render: () => (
    <Pair
      skeleton={<SkeletonRow cells={['40%', '25%', '15%']} />}
      real={
        <div className="flex h-td w-full items-center gap-(--space-3) text-row leading-list text-fg1">
          <span>Mascoma Lake</span>
          <span className="text-fg2">Enfield</span>
          <span className="font-(family-name:--family-mono) text-fg3">2 d</span>
        </div>
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const { skeleton, real } = pair(canvasElement);
    await expectSameBox(skeleton, real, 'row');
    await expect(skeleton.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(skeleton, 'var(--size-td)'),
      1,
    );
  },
};

/** A map or chart: the block takes the real one's height class and fills the width. */
export const MapBlock: Story = {
  render: () => (
    <Pair
      skeleton={<SkeletonBlock className="h-[10rem]" />}
      real={<div className="h-[10rem] w-full border border-solid border-line bg-panel" />}
    />
  ),
  play: async ({ canvasElement }) => {
    const { skeleton, real } = pair(canvasElement);
    await expectSameBox(skeleton, real, 'map');
  },
};

/** Shimmer: while motion is allowed, a band sweeps — every skeleton on the page in step. */
export const Shimmer: Story = {
  render: () => (
    <div className="flex w-[16rem] flex-col gap-(--space-2)">
      <SkeletonText className="text-kick leading-none" width="30%" />
      <SkeletonText className="text-row leading-list" />
      <SkeletonBlock className="h-[4rem]" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const els = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
    for (const el of els) {
      await expect(el).toHaveAttribute('data-shimmer');
      await expect(getComputedStyle(el).backgroundImage).toMatch(/linear-gradient/);
    }
    const anims = els.map((el) => must(el.getAnimations()[0]));
    // In step: every sweep starts at the timeline's zero.
    for (const a of anims) await expect(a.startTime).toBe(0);
    await expect(anims[0]?.effect?.getTiming().iterations).toBe(Number.POSITIVE_INFINITY);
  },
};

/** Under reduced motion the wash holds still: no band, no animation. */
export const ReducedMotion: Story = {
  render: () => (
    <div className="flex w-[16rem] flex-col gap-(--space-2)">
      <SkeletonText className="text-row leading-list" />
      <SkeletonBlock className="h-[4rem]" />
    </div>
  ),
  beforeEach: reduceMotion,
  play: async ({ canvasElement }) => {
    const els = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
    await expect(els.length).toBeGreaterThan(0);
    for (const el of els) {
      await expect(el).not.toHaveAttribute('data-shimmer');
      await expect(el.getAnimations()).toHaveLength(0);
      await expect(getComputedStyle(el).backgroundImage).toBe('none');
    }
  },
};

/** Unmounting stops the sweep, so a loaded page leaves nothing running. */
export const StopsOnUnmount: Story = {
  render: () => <Loads />,
  play: async ({ canvasElement }) => {
    const el = must(canvasElement.querySelector<HTMLElement>('[data-slot="skeleton"]'));
    const anim = must(el.getAnimations()[0]);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="skeleton"]')).toBeNull());
    await expect(anim.playState).toBe('idle');
  },
};

function Loads() {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex flex-col gap-(--space-2)">
      <button type="button" onClick={() => setLoaded(true)}>
        Load
      </button>
      {loaded ? (
        <p className="text-row text-fg1">Mascoma Lake</p>
      ) : (
        <SkeletonText className="text-row leading-list" width="12rem" />
      )}
    </div>
  );
}

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <section
      className="flex w-full max-w-[24rem] flex-col gap-heading"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex flex-col gap-(--space-1_5)">
        <span className={KICKER}>Cost · this season</span>
        <SkeletonStat chars={6} />
        <SkeletonText className="text-assist leading-list" width="70%" />
      </div>
      <div>
        <SkeletonRow cells={['40%', '25%', '15%']} />
        <SkeletonRow cells={['55%', '20%', '15%']} />
        <SkeletonRow cells={['35%', '30%', '15%']} />
      </div>
      <SkeletonBlock className="h-[6rem]" />
    </section>
  );
}

/** A loading card in all four maps: the wash reads on every ground. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const washes = new Set<string>();
    for (const q of quads) {
      const el = must(q.querySelector<HTMLElement>('[data-slot="skeleton"]'));
      washes.add(getComputedStyle(el).backgroundColor);
    }
    // Ink at an alpha: light on dark, dark on light.
    await expect(washes.size).toBeGreaterThan(1);
  },
};
