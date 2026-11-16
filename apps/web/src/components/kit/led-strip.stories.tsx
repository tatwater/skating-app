import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from './measure';
import { KICKER, must } from './storyKit';
import { LedStrip } from './trace-chart';

/**
 * The LED strip's sizes and states, beside the trace drawings' own `Led` story: Bodies'
 * completeness in a row (5.1) and in the preview, and the Body console's strip with a part that
 * isn't recorded yet.
 */
const meta = {
  title: 'Kit/LedStrip',
  component: LedStrip,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { 'aria-label': 'Complete', value: 9, max: 10 },
} satisfies Meta<typeof LedStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** In a table row: 5 px segments on the baseline, lit in the list ink. */
export const Row: Story = {
  args: { size: 'row', tone: 'on' },
  play: async ({ canvasElement }) => {
    const segs = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="led-segment"]')];
    await expect(segs).toHaveLength(10);
    const lit = must(segs[0]);
    await expect(lit.getBoundingClientRect().width).toBeCloseTo(5, 0);
    await expect(getComputedStyle(lit).backgroundColor).toEqual(
      sameColor(computedColor(lit, 'var(--fg2)')),
    );
    const dark = must(segs[9]);
    await expect(getComputedStyle(dark).backgroundColor).toEqual(
      sameColor(computedColor(dark, 'var(--line)')),
    );
  },
};

/** Across a column, set tall: the preview's strip, one segment per part, a segment gap apart. */
export const Tall: Story = {
  args: { full: true, size: 'tall' },
  decorators: [
    (Story) => (
      <div className="w-[20rem]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const strip = must(canvasElement.querySelector<HTMLElement>('[data-slot="led-strip"]'));
    await expect(strip.getBoundingClientRect().width).toBeCloseTo(320, 0);
    const seg = must(strip.querySelector<HTMLElement>('[data-slot="led-segment"]'));
    await expect(seg.getBoundingClientRect().height).toBeCloseTo(10, 0);
  },
};

/** A part not recorded yet is dashed, and not counted: 8 of 10 known, never 8 of 10 present. */
export const Unknown: Story = {
  args: {
    full: true,
    segments: ['on', 'on', 'on', 'on', 'on', 'on', 'on', 'on', 'off', 'unknown'],
  },
  render: (args) => (
    <div className="flex w-[18rem] flex-col gap-(--space-1_5)">
      <span className={KICKER}>Complete · 8 / 10</span>
      <LedStrip {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const strip = must(canvasElement.querySelector<HTMLElement>('[role="meter"]'));
    await expect(strip).toHaveAttribute('aria-valuenow', '8');
    // The dashed part is said apart from the dark one, never folded into it.
    await expect(strip).toHaveAttribute('aria-valuetext', '8 of 10, 1 not recorded yet');
    const unknown = must(strip.querySelector<HTMLElement>('[data-state="unknown"]'));
    await expect(getComputedStyle(unknown).borderStyle).toBe('dashed');
  },
};

/** Every size in all four maps. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="flex w-[20rem] flex-col gap-(--space-4)">
      <LedStrip {...args} size="row" tone="on" />
      <LedStrip {...args} />
      <LedStrip {...args} full />
      <LedStrip {...args} full size="tall" />
    </div>
  ),
};
