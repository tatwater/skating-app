import { LANDMARK_KINDS } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { LandmarkMark } from './landmark-mark';

/** Kit candidate: every landmark kind's mark, and a skater's proposal, in all four maps. */
const meta = {
  title: 'Admin/Body/Kit candidates/Landmark mark',
  component: LandmarkMark,
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof LandmarkMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EveryKind: Story = {
  args: { kind: 'island' },
  parameters: { fourUp: true },
  render: () => (
    <ul className="grid grid-cols-[auto_1fr] items-center gap-x-(--space-2_5) gap-y-(--space-1_5) text-assist text-fg1">
      {[...LANDMARK_KINDS, 'proposed' as const].map((kind) => (
        <li key={kind} className="contents">
          <LandmarkMark kind={kind} />
          <span>{kind}</span>
        </li>
      ))}
    </ul>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const marks = [...quad.querySelectorAll<SVGElement>('[data-slot="landmark-mark"]')];
    await expect(marks).toHaveLength(LANDMARK_KINDS.length + 1);
    for (const m of marks) await expect(m).toHaveAttribute('aria-hidden', 'true');
    // Water named as a place takes the dim ice; a beach is amber; nothing is red.
    const plate = (kind: string) =>
      must(quad.querySelector<SVGRectElement>(`[data-kind="${kind}"] rect`));
    const fill = (kind: string) => getComputedStyle(plate(kind)).fill;
    await expect(fill('waterway')).toEqual(
      sameColor(computedColor(plate('waterway'), 'var(--acc-dim)')),
    );
    await expect(fill('beach')).toEqual(sameColor(computedColor(plate('beach'), 'var(--warn)')));
    // A proposal is dashed: proposed, not placed.
    await expect(plate('proposed').getAttribute('stroke-dasharray')).not.toBeNull();
  },
};
