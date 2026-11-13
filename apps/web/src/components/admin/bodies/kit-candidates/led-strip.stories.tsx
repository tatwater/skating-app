import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { LedStrip } from './led-strip';

/** Kit candidate: the LED strip — Bodies' completeness in a row (5.1) and in the preview. */
const meta = {
  title: 'Kit candidates/LedStrip',
  component: LedStrip,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { label: 'Complete', value: 9, max: 10 },
} satisfies Meta<typeof LedStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** In a table row: small segments, lit in the list ink. */
export const Row: Story = {
  play: async ({ canvasElement }) => {
    const segs = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="led-segment"]')];
    await expect(segs).toHaveLength(10);
    const lit = must(segs[0]);
    await expect(getComputedStyle(lit).backgroundColor).toEqual(
      sameColor(computedColor(lit, 'var(--fg2)')),
    );
    const dark = must(segs[9]);
    await expect(getComputedStyle(dark).backgroundColor).toEqual(
      sameColor(computedColor(dark, 'var(--line)')),
    );
  },
};

/** Across a column: one segment per part, the lit ones bright with the lit glow. */
export const Full: Story = {
  args: { size: 'full' },
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
  },
};

/** Both sizes in all four maps. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="flex w-[20rem] flex-col gap-(--space-4)">
      <LedStrip {...args} />
      <LedStrip {...args} size="full" />
    </div>
  ),
};
