import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { ThresholdMeter } from './threshold-meter';

/**
 * A kit candidate: the threshold meter, in all four maps — clears its gate, fails it, and not
 * measured. Generic: a value, a range and a threshold.
 */
const meta = {
  title: 'Kit candidates/Threshold meter',
  parameters: { fourUp: true },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div className="flex w-[21.25rem] flex-col gap-(--space-2)">
      <ThresholdMeter label="Clear of cloud" value={98} threshold={60} unit="%" />
      <ThresholdMeter label="Clear of cloud" value={36} threshold={60} unit="%" />
      <ThresholdMeter label="Lake in the pass" value={null} threshold={50} unit="%" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await faceLoaded(must(quads[0]?.querySelector('[data-slot="threshold-label"]')), 'Clear');
    await faceLoaded(must(quads[0]?.querySelector('[data-slot="threshold-value"]')), '98');
    for (const q of quads) {
      const [pass, fail, none] = [
        ...q.querySelectorAll<HTMLElement>('[data-slot="threshold-meter"]'),
      ];
      // Failing: the name and the figure go bright; passing: they stay the list ink.
      const failValue = must(fail?.querySelector<HTMLElement>('[data-slot="threshold-value"]'));
      const passValue = must(pass?.querySelector<HTMLElement>('[data-slot="threshold-value"]'));
      await expect(getComputedStyle(failValue).color).toEqual(
        sameColor(computedColor(failValue, 'var(--fg)')),
      );
      await expect(getComputedStyle(passValue).color).toEqual(
        sameColor(computedColor(passValue, 'var(--fg2)')),
      );
      // Not measured: no fill, no figure.
      await expect(none?.querySelector('[data-slot="threshold-fill"]')).toBeNull();
      await expect(must(none?.querySelector('[data-slot="threshold-value"]')).textContent).toBe('');
      // The fill reaches its value.
      const track = must(
        pass?.querySelector('[data-slot="threshold-track"]'),
      ).getBoundingClientRect();
      const fill = must(
        pass?.querySelector('[data-slot="threshold-fill"]'),
      ).getBoundingClientRect();
      await expect(Math.abs(fill.width - track.width * 0.98)).toBeLessThanOrEqual(1);
    }
  },
};
