import { zonedParts } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';

import { hourTicks, type StepEvent, StepRugChart } from './step-rug-chart';

/**
 * A running count's steps over a rug (Inbox zero's *Open, today*, 2.9). Twenty open
 * at eight, two filed through the morning, twenty-two decided by 15:02 — the line reaches zero and
 * is marked there.
 */

const day = new Date(2026, 9, 14).getTime();
const at = (h: number, m = 0) => day + h * 3_600_000 + m * 60_000;
const minutes = [
  95,
  130,
  185,
  ...[
    220, 226, 238, 247, 256, 268, 279, 291, 300, 314, 326, 337, 349, 358, 370, 381, 394, 408, 422,
  ],
];
const EVENTS: StepEvent[] = [
  { at: at(9, 10), delta: 1 },
  { at: at(10, 30), delta: 1 },
  ...minutes.map((m) => ({ at: at(8, m), delta: -1 as const })),
];
const time = (t: number) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    t,
  );

const meta = {
  title: 'Kit/StepRugChart',
  component: StepRugChart,
  globals: { surface: 'admin' },
  parameters: { fourUp: true },
  args: {
    start: 20,
    events: EVENTS,
    from: at(8),
    to: at(16),
    formatTime: time,
    zeroLabel: (t: number) => `Zero ${time(t)}`,
    label: 'Open, today',
    className: 'h-[13.375rem]',
  },
  decorators: [(Story) => <div className="w-[40rem] bg-bg p-(--space-4)">{Story()}</div>],
} satisfies Meta<typeof StepRugChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The zero board's day: every event on the rug, the line stepping to zero, marked at 15:02. */
export const ToZero: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const root = canvasElement.querySelector('[data-slot="step-rug-chart"]');
      expect(root?.querySelectorAll('[data-slot="step-rug-fall"]').length).toBe(22);
      expect(root?.querySelectorAll('[data-slot="step-rug-rise"]').length).toBe(2);
      expect(root?.querySelector('[data-slot="step-rug-zero"]')?.textContent).toBe('Zero 15:02');
    });
  },
};

/** A quiet day: nothing reached zero, so nothing is marked. */
export const StillOpen: Story = {
  args: { events: EVENTS.slice(0, 6) },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="step-rug-line"]')).not.toBeNull(),
    );
    expect(canvasElement.querySelector('[data-slot="step-rug-zero"]')).toBeNull();
  },
};

const KOLKATA = 'Asia/Kolkata';
/** Kolkata's clock (UTC+5:30), where a whole UTC hour reads :30. A story's floor, as a caller's. */
const kolkataHour = (t: number) => {
  const p = zonedParts(t, KOLKATA);
  return t - (p.minute * 60 + p.second) * 1000 - (((t % 1000) + 1000) % 1000);
};
const kolkataTime = (t: number) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: KOLKATA,
  }).format(t);
// 08:00 to 16:00 on Kolkata's clock.
const K_FROM = Date.UTC(2026, 9, 14, 2, 30);
const K_TO = Date.UTC(2026, 9, 14, 10, 30);

/**
 * A reader in a half-hour zone: the span starts on a whole hour of their clock, and so do the
 * ticks — the caller's `ticks` (from `hourTicks` with its zoned floor), not the UTC hours that
 * would read 08:30, 09:30 there.
 */
export const HalfHourZone: Story = {
  args: {
    events: [],
    start: 4,
    from: K_FROM,
    to: K_TO,
    formatTime: kolkataTime,
    zeroLabel: undefined,
    ticks: hourTicks(K_FROM, K_TO, kolkataHour),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-slot="step-rug-hour"]').length).toBeGreaterThan(
        0,
      ),
    );
    for (const quad of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const ticks = [...quad.querySelectorAll<SVGElement>('[data-slot="step-rug-hour"]')];
      const instants = ticks.map((g) => Number(g.dataset.at));
      // Every tick a whole hour on the reader's clock: 08:00 … 16:00, nine of them.
      await expect(instants.map((t) => kolkataTime(t))).toEqual(
        Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00`),
      );
      // Every other one labeled, in the reader's words.
      const labels = [...quad.querySelectorAll('[data-slot="step-rug-hour"] text')].map(
        (t) => t.textContent,
      );
      await expect(labels.every((l) => l?.endsWith(':00'))).toBe(true);
    }
  },
};
