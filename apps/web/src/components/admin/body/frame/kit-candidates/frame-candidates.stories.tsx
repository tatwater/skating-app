import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { BulletList } from './bullet-list';
import { RecordLockup, useScrollFold } from './record-lockup';
import { SegmentMeter } from './segment-meter';

/**
 * Kit candidates from the Body console's left column (board 5.4.1 and 5.4.1 Scrolled): the LED row,
 * the record lockup with its scroll-fold, and the bullet list. Each in all four maps.
 */
const meta = {
  title: 'Admin/Body/Kit candidates/Left column',
  component: SegmentMeter,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof SegmentMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

const quadsOf = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-theme-scope]'),
];

/** Complete · 9 / 10: lit, missing and not-yet-known parts, and the note that hangs under the row. */
export const LedRow: Story = {
  args: {
    label: 'Complete · 8 / 10',
    segments: ['on', 'on', 'on', 'on', 'on', 'on', 'on', 'on', 'off', 'unknown'],
  },
  render: (args) => (
    <div className="w-[18.75rem]">
      <SegmentMeter {...args}>
        <p className="m-0 border border-solid border-warn-line bg-warn-tint px-(--space-2_5) py-(--space-2) text-assist text-warn">
          Missing bathymetry
        </p>
      </SegmentMeter>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = quadsOf(canvasElement);
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const meter = must(q.querySelector('[role="meter"]'));
      await expect(meter).toHaveAttribute('aria-valuenow', '8');
      const on = must(q.querySelector<HTMLElement>('[data-slot="segment"][data-state="on"]'));
      const off = must(q.querySelector<HTMLElement>('[data-slot="segment"][data-state="off"]'));
      await expect(getComputedStyle(on).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--fg)')),
      );
      await expect(getComputedStyle(off).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--line)')),
      );
      // The row spans its column: the segments share it evenly.
      const segs = [...q.querySelectorAll<HTMLElement>('[data-slot="segment"]')].map(
        (s) => s.getBoundingClientRect().width,
      );
      await expect(Math.max(...segs) - Math.min(...segs)).toBeLessThan(0.5);
    }
  },
};

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
  args: { label: '', segments: [] },
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

const onOpen = fn();

/** Asked of this body: the hollow bullets, the open one lit; ⏎ opens the cursor's row. */
export const Bullets: Story = {
  args: { label: '', segments: [] },
  render: () => (
    <div className="w-[18.75rem]">
      <BulletList
        label="Asked of this body"
        selectedId="b"
        onOpen={onOpen}
        items={[
          {
            id: 'a',
            kicker: 'Bay request · 3 skaters',
            title: '“Shaker cove”',
            sub: 'Near the Shaker Bridge launch',
          },
          { id: 'b', kicker: 'Place name · 12 emails', title: '“the Narrows”' },
          { id: 'c', kicker: 'Landmark proposal · 1 skater', title: '“the flats by the dam”' },
        ]}
      />
    </div>
  ),
  parameters: { fourUp: true },
  beforeEach: () => {
    onOpen.mockClear();
  },
  play: async ({ canvasElement }) => {
    for (const q of quadsOf(canvasElement)) {
      const lit = must(q.querySelector<HTMLElement>('[data-slot="bullet-row"][data-selected]'));
      await expect(lit).toHaveTextContent('the Narrows');
      const bullet = must(lit.querySelector<HTMLElement>('[data-slot="bullet"]'));
      await expect(getComputedStyle(bullet).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--fg)')),
      );
    }
    const first = must(quadsOf(canvasElement)[0]?.querySelector<HTMLElement>('[role="listbox"]'));
    first.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await expect(onOpen).toHaveBeenCalledWith('c');
  },
};
