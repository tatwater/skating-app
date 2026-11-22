import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { ThemePair } from '../../../.storybook/theme';
import { computedColor, sameColor } from './measure';
import { OverlapGauge } from './overlap-gauge';
import { must } from './storyKit';

/**
 * The overlap gauge (the Inbox's 2.5) — four-up: dark and light, at the board's
 * inspector width and at a phone's (where the figure stacks over the scale). The board's figure,
 * 92 % of a drawing inside Caspian Lake against the 80 % merge threshold, then one short of it.
 */

const meta = {
  title: 'Kit/OverlapGauge',
  component: OverlapGauge,
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
  args: {
    share: 0.92,
    threshold: 0.8,
    reached: true,
    sub: 'Of the drawing is Caspian Lake',
    thresholdLabel: 'Merge suggested from 80 %',
  },
} satisfies Meta<typeof OverlapGauge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The two widths each mode is drawn at: the board's part (748 px) and a phone's (328 px). */
const WIDTHS = [
  { key: 'wide', px: 748 },
  { key: 'narrow', px: 328 },
] as const;

const fourUp = (args: Parameters<typeof OverlapGauge>[0]) => (
  <ThemePair surface="admin" columns="lg" heading>
    {() => (
      <div className="flex flex-col gap-(--space-6)">
        {WIDTHS.map((w) => (
          <div key={w.key} data-width={w.key} style={{ width: w.px, maxWidth: '100%' }}>
            <OverlapGauge {...args} />
          </div>
        ))}
      </div>
    )}
  </ThemePair>
);

const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];

/** Past the threshold: the label lit, the fill to 92, the tick at 80. */
export const Reached: Story = {
  render: (args) => fourUp(args),
  play: async ({ canvasElement }) => {
    await expect(quads(canvasElement)).toHaveLength(2);
    for (const q of quads(canvasElement)) {
      for (const w of WIDTHS) {
        const box = must(q.querySelector<HTMLElement>(`[data-width="${w.key}"]`));
        const label = must(box.querySelector<HTMLElement>('[data-slot="overlap-gauge-threshold"]'));
        await expect(getComputedStyle(label).color).toEqual(
          sameColor(computedColor(q, 'var(--fg)')),
        );
        const track = must(box.querySelector<HTMLElement>('[data-slot="overlap-gauge-track"]'));
        const fill = must(box.querySelector<HTMLElement>('[data-slot="overlap-gauge-fill"]'));
        const tick = must(box.querySelector<HTMLElement>('[data-slot="overlap-gauge-tick"]'));
        // The fill and tick read in one retry, once laid out (never a one-shot read).
        await waitFor(() => {
          const t = track.getBoundingClientRect();
          expect(fill.getBoundingClientRect().width / t.width).toBeCloseTo(0.92, 2);
          expect((tick.getBoundingClientRect().left - t.left) / t.width).toBeCloseTo(0.8, 2);
        });
        // The label ends on the tick.
        await expect(
          Math.abs(label.getBoundingClientRect().right - tick.getBoundingClientRect().left),
        ).toBeLessThanOrEqual(1);
        // Nothing runs out of its box.
        await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
      }
      // Wide: the figure beside the scale; narrow: stacked over it.
      const figure = (k: string) =>
        must(
          q.querySelector<HTMLElement>(`[data-width="${k}"] [data-slot="overlap-gauge-value"]`),
        ).getBoundingClientRect();
      const scale = (k: string) =>
        must(
          q.querySelector<HTMLElement>(`[data-width="${k}"] [data-slot="overlap-gauge-scale"]`),
        ).getBoundingClientRect();
      await expect(scale('wide').left).toBeGreaterThan(figure('wide').right);
      await expect(scale('narrow').top).toBeGreaterThan(figure('narrow').bottom);
    }
  },
};

/** Short of it: the label quiet, the figure floored (79.9 % reads 79). */
export const Short: Story = {
  args: { share: 0.799, reached: false },
  render: (args) => fourUp(args),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const label = must(q.querySelector<HTMLElement>('[data-slot="overlap-gauge-threshold"]'));
      await expect(getComputedStyle(label).color).toEqual(
        sameColor(computedColor(q, 'var(--fg3)')),
      );
      await expect(
        must(q.querySelector('[data-slot="overlap-gauge-value"]')).textContent,
      ).toContain('79');
    }
  },
};
