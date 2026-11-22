import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { ClaimChip } from './claim-chip';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/** The claim chip (`.pill.lo`, boards 2.1 and its drawer): a report's own words, as written. */
function Claims() {
  return (
    <div className="flex flex-wrap gap-(--space-1_5)">
      <ClaimChip tone="bad">3.5″ measured</ClaimChip>
      <ClaimChip>black ice</ClaimChip>
      <ClaimChip>still open, south end</ClaimChip>
    </div>
  );
}

const meta = {
  title: 'Kit/ClaimChip',
  component: Claims,
  parameters: { fourUp: true },
} satisfies Meta<typeof Claims>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const chips = [...q.querySelectorAll<HTMLElement>('[data-slot="claim-chip"]')];
      await expect(chips).toHaveLength(3);
      const bad = must(chips[0]);
      const plain = must(chips[1]);
      // The skater's own words: never set in caps.
      await expect(getComputedStyle(plain).textTransform).toBe('none');
      // Red marks the claim under question, and nothing else.
      await expect(getComputedStyle(bad).color).toEqual(
        sameColor(computedColor(bad, 'var(--bad)')),
      );
      await expect(getComputedStyle(plain).color).toEqual(
        sameColor(computedColor(plain, 'var(--fg2)')),
      );
      // The badge's height; square, as every container.
      const badge = Number.parseFloat(getComputedStyle(plain).height);
      await expect(Math.abs(plain.getBoundingClientRect().height - badge)).toBeLessThanOrEqual(0.5);
      await expect(getComputedStyle(plain).borderRadius).toBe('0px');
    }
  },
};
