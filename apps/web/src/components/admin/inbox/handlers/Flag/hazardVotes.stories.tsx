import { HAZARD_TYPES, HAZARD_VERDICTS, verdictLabel } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { DISTINCT_VOTES } from './flagFixtures';
import { HazardVotes } from './subjects';

/**
 * A hazard's votes for **every hazard type**, each verdict at a different count (1, 2, 3, 4) so a
 * swapped label would show: each row's words are core's `verdictLabel` for that type — a ridge
 * crossing's included — in core's order, never sorted by count.
 */
function EveryType() {
  return (
    <div className="grid w-[46rem] max-w-full grid-cols-3 gap-(--space-5)">
      {HAZARD_TYPES.map((type) => (
        <div key={type} data-type={type} className="flex flex-col gap-(--space-1)">
          <span className="text-kick tracking-kick text-fg3 uppercase">{type}</span>
          <HazardVotes hazard={{ type, votes: DISTINCT_VOTES, votesCapped: false }} />
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Admin/Inbox/Flag handler/Hazard votes',
  component: EveryType,
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof EveryType>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EveryHazardType: Story = {
  play: async ({ canvasElement }) => {
    for (const type of HAZARD_TYPES) {
      const box = canvasElement.querySelector<HTMLElement>(`[data-type="${type}"]`);
      const rows = [...(box?.querySelectorAll<HTMLElement>('[data-slot="hazard-verdict"]') ?? [])];
      await expect(rows.map((r) => r.dataset.verdict)).toEqual([...HAZARD_VERDICTS]);
      for (const r of rows) {
        const verdict = r.dataset.verdict as (typeof HAZARD_VERDICTS)[number];
        await expect(r.querySelector('[data-slot="hazard-verdict-label"]')).toHaveTextContent(
          verdictLabel(verdict, type),
        );
        await expect(r.querySelector('[data-slot="hazard-verdict-count"]')).toHaveTextContent(
          String(DISTINCT_VOTES[verdict]),
        );
      }
    }
  },
};

export const FourUp: Story = {
  parameters: { fourUp: true },
  render: () => (
    <HazardVotes hazard={{ type: 'ridge_crossing', votes: DISTINCT_VOTES, votesCapped: false }} />
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      // No verdict wears a color of its own: every count and label is the same ink.
      const colors = new Set(
        [...q.querySelectorAll<HTMLElement>('[data-slot="hazard-verdict"]')].map(
          (r) => getComputedStyle(r).color,
        ),
      );
      await expect(colors.size).toBe(1);
    }
  },
};
