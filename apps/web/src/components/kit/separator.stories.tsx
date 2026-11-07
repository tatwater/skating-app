import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Kbd } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { Separator } from './separator';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Separator',
  component: Separator,
  tags: ['autodocs'],
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

const rules = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-slot="separator"]')];

/** A rule between two blocks in a pane: the full width, one hair, in the pane borders' gray. */
export const Horizontal: Story = {
  render: () => (
    <div data-junction="pane" className="flex w-[20rem] flex-col gap-heading">
      <p className="m-0 text-row text-fg2">Reported by 3 people</p>
      <Separator />
      <p className="m-0 text-row text-fg2">Last report 4 days ago</p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-junction="pane"]'));
    const rule = within(canvasElement).getByRole('separator');
    await expect(rule).toHaveAttribute('aria-orientation', 'horizontal');
    const r = rule.getBoundingClientRect();
    await expect(r.height).toBe(resolvePx(rule, 'var(--stroke-hair)'));
    await expect(Math.abs(r.width - pane.getBoundingClientRect().width)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    const style = getComputedStyle(rule);
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(rule, 'var(--line)')));
    // No margins: the stack's gap is the only space on each side.
    await expect([style.marginTop, style.marginBottom]).toEqual(['0px', '0px']);
    const [above, below] = [...pane.querySelectorAll('p')].map((p) => p.getBoundingClientRect());
    const gap = resolvePx(pane, 'var(--gap-heading)');
    await expect(Math.abs(r.top - must(above).bottom - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    await expect(Math.abs(must(below).top - r.bottom - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
  },
};

/**
 * The status bar's vertical rule between its lamp, its keys and its runs: `space-3` tall, a hair
 * wide, in the stronger rule, centered on the bar.
 */
export const StatusBar: Story = {
  render: () => (
    <div
      data-junction="status"
      className="flex h-(--size-status) w-[32rem] items-center gap-(--space-2) border-0 border-t border-solid border-line px-(--space-3) text-kick leading-none text-fg3"
    >
      <span className={KICKER}>Convex live</span>
      <Separator orientation="vertical" strong />
      <span className="inline-flex items-center gap-(--space-1)">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> Move
      </span>
      <Separator orientation="vertical" strong />
      <span className={KICKER}>Weather ran 03:00</span>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const bar = must(canvasElement.querySelector<HTMLElement>('[data-junction="status"]'));
    const [first] = rules(bar);
    const rule = must(first);
    await expect(rule).toHaveAttribute('aria-orientation', 'vertical');
    const r = rule.getBoundingClientRect();
    await expect(r.width).toBe(resolvePx(rule, 'var(--stroke-hair)'));
    await expect(r.height).toBeCloseTo(resolvePx(bar, 'var(--space-3)'), 1);
    await expect(getComputedStyle(rule).backgroundColor).toEqual(
      sameColor(computedColor(rule, 'var(--line2)')),
    );
    // Centered on the bar.
    const b = bar.getBoundingClientRect();
    const mid = (b.top + b.bottom) / 2;
    await expect(Math.abs((r.top + r.bottom) / 2 - mid)).toBeLessThanOrEqual(1);
  },
};

/** A full-height divider: pass a height or `self-stretch`, and it spans its row. */
export const VerticalStretch: Story = {
  render: () => (
    <div data-junction="row" className="flex h-[4rem] items-stretch gap-(--space-3)">
      <span className="text-row text-fg2">Before</span>
      <Separator orientation="vertical" className="h-auto self-stretch" />
      <span className="text-row text-fg2">After</span>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const row = must(canvasElement.querySelector<HTMLElement>('[data-junction="row"]'));
    const rule = within(canvasElement).getByRole('separator');
    await expect(rule.getBoundingClientRect().height).toBeCloseTo(
      row.getBoundingClientRect().height,
      1,
    );
  },
};

/** The two tones side by side: `line` for rules between blocks, `line2` for the status bar's. */
export const Tones: Story = {
  render: () => (
    <div className="flex w-[20rem] flex-col gap-heading">
      <span className={KICKER}>Line</span>
      <Separator />
      <span className={KICKER}>Line 2 · strong</span>
      <Separator strong />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [quiet, strong] = rules(canvasElement).map(must);
    await expect(getComputedStyle(must(quiet)).backgroundColor).toEqual(
      sameColor(computedColor(must(quiet), 'var(--line)')),
    );
    await expect(must(strong)).toHaveAttribute('data-strong');
    await expect(getComputedStyle(must(strong)).backgroundColor).toEqual(
      sameColor(computedColor(must(strong), 'var(--line2)')),
    );
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex w-[16rem] flex-col gap-heading">
      <p className="m-0 text-row text-fg2">Reported by 3 people</p>
      <Separator />
      <div className="flex h-(--size-status) items-center gap-(--space-2) text-kick text-fg3">
        <span className={KICKER}>Convex live</span>
        <Separator orientation="vertical" strong />
        <span className={KICKER}>Weather ran 03:00</span>
      </div>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [h, v] = rules(q).map(must);
      await expect(must(h).getBoundingClientRect().height).toBe(1);
      await expect(must(v).getBoundingClientRect().width).toBe(1);
      await expect(must(v).getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--space-3)'),
        1,
      );
      await expect(getComputedStyle(must(h)).backgroundColor).toEqual(
        sameColor(computedColor(must(h), 'var(--line)')),
      );
    }
  },
};
