import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { FactList } from './fact-list';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/** The fact list (`.kv`, boards 2.1 and 2.6): facts down a kicker column, compact and unruled. */
function Facts() {
  return (
    <FactList
      className="max-w-[22rem]"
      rows={[
        { label: 'Status', value: 'Suspended until 15 Oct' },
        { label: 'Reports', value: '14 · 2 contradicted' },
        { label: 'Open flags', value: '1 · this one' },
      ]}
    />
  );
}

const meta = {
  title: 'Kit/FactList',
  component: Facts,
  parameters: { fourUp: true },
} satisfies Meta<typeof Facts>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const terms = [...q.querySelectorAll<HTMLElement>('[data-slot="fact"] > dt')];
      await expect(terms).toHaveLength(3);
      // Unruled, the kicker in the faint ink, the value in the bright body ink.
      await expect(getComputedStyle(must(terms[0])).borderBottomWidth).toBe('0px');
      await expect(getComputedStyle(must(terms[0])).color).toEqual(
        sameColor(computedColor(q, 'var(--fg3)')),
      );
      const value = must(q.querySelector<HTMLElement>('[data-slot="fact"] > dd'));
      await expect(getComputedStyle(value).color).toEqual(
        sameColor(computedColor(q, 'var(--fg1)')),
      );
      // Every value starts on one left edge: one label column.
      const lefts = [...q.querySelectorAll('[data-slot="fact"] > dd')].map((d) =>
        Math.round(d.getBoundingClientRect().left),
      );
      await expect(new Set(lefts).size).toBe(1);
    }
  },
};
