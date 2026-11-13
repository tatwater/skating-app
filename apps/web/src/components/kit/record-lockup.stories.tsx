import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, waitFor } from 'storybook/test';

import { computedColor, sameColor } from './measure';
import { RecordLockup, useScrollFold } from './record-lockup';
import { faceLoaded, must } from './storyKit';

/** A record's lockup at the head of its panel, and its scroll-fold (the Body console, 5.4.1). */
const meta = {
  title: 'Kit/RecordLockup',
  component: RecordLockup,
  parameters: { layout: 'padded' },
  args: { kind: 'Reservoir', name: 'Mascoma Lake' },
} satisfies Meta<typeof RecordLockup>;

export default meta;
type Story = StoryObj<typeof meta>;

const quadsOf = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-theme-scope]'),
];

function FoldingPanel() {
  const scroller = useRef<HTMLDivElement | null>(null);
  const folded = useScrollFold(scroller);
  return (
    <div className="flex h-[12rem] w-[18.75rem] flex-col">
      <RecordLockup kind="Reservoir" name="Mascoma Lake" folded={folded} />
      <div
        ref={scroller}
        data-testid="scroller"
        className="min-h-0 flex-1 overflow-y-auto pt-(--space-3)"
      >
        <div className="h-[40rem] text-row text-fg2">The record, long enough to scroll.</div>
      </div>
    </div>
  );
}

/** The lockup, then scrolled: it folds to the name and its kind on one line over its rule. */
export const LockupFolds: Story = {
  render: () => <FoldingPanel />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    for (const q of quadsOf(canvasElement)) {
      const name = must(q.querySelector<HTMLElement>('[data-slot="record-lockup-name"]'));
      await faceLoaded(name);
      await expect(getComputedStyle(name).color).toEqual(sameColor(computedColor(q, 'var(--fg)')));
      const scroller = must(q.querySelector<HTMLElement>('[data-testid="scroller"]'));
      scroller.scrollTop = 120;
      scroller.dispatchEvent(new Event('scroll'));
      await waitFor(() =>
        expect(must(q.querySelector('[data-slot="record-lockup"]'))).toHaveAttribute('data-folded'),
      );
      // Folded, the kind sits on the name's line, after it.
      const lockup = must(q.querySelector<HTMLElement>('[data-slot="record-lockup"]'));
      const kind = must(q.querySelector<HTMLElement>('[data-slot="record-lockup-kind"]'));
      const n = must(
        q.querySelector<HTMLElement>('[data-slot="record-lockup-name"]'),
      ).getBoundingClientRect();
      await expect(kind.getBoundingClientRect().left).toBeGreaterThan(n.right);
      await expect(getComputedStyle(lockup).borderBottomStyle).toBe('solid');
    }
  },
};
