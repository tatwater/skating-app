import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';

import {
  BOARD_COVERAGE,
  BOARD_DAYS,
  BOARD_KEEPING_UP,
  BOARD_SHOWING_UP,
  METRICS_NOW,
  METRICS_ZONE,
  QUIET_KEEPING_UP,
  QUIET_SHOWING_UP,
  RECORD_BEGAN,
  RECORDED_COVERAGE,
  RECORDED_KEEPING_UP,
  RECORDED_SHOWING_UP,
} from './metricsFixtures';
import {
  type KeepingUpData,
  metricsNotRecorded,
  type PulseKey,
  type PulseSeries,
  type ShowingUpData,
} from './metricsModel';
import { OverviewMetrics } from './OverviewMetrics';
import { ShowingUp } from './ShowingUp';

/**
 * Overview › Metrics (board 1.4) on the console surface. The board's frame is the page's main area
 * (1440 less the rail), padded as the page pads it; the page head and its tabs are the shell's.
 */
const meta = {
  title: 'Admin/Overview/Metrics',
  component: OverviewMetrics,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div
        data-slot="board-frame"
        className="min-h-screen w-[86rem] bg-bg px-[1.375rem] pt-(--space-3_5) pb-(--space-14) font-(family-name:--family-sans) text-fg"
      >
        {Story()}
      </div>
    ),
  ],
  args: {
    days: BOARD_DAYS,
    now: METRICS_NOW,
    timeZone: METRICS_ZONE,
    keepingUp: BOARD_KEEPING_UP,
    showingUp: BOARD_SHOWING_UP,
    coverage: BOARD_COVERAGE,
  },
} satisfies Meta<typeof OverviewMetrics>;

export default meta;
type Story = StoryObj<typeof meta>;

const pulseOf = (scope: HTMLElement) =>
  must(scope.querySelector<HTMLElement>('[data-slot="pulse"]'));
const plateOf = (scope: HTMLElement) =>
  scope.querySelector<HTMLElement>('[data-slot="pulse-plate"]');

/** Moves a pointer over the pulse at day `i` of `n`, as a mouse would. */
function pointAtDay(scope: HTMLElement, i: number, n: number) {
  const bars = must(scope.querySelector('[data-slot="pulse-bars"]')).getBoundingClientRect();
  const clientX = bars.left + ((i + 0.5) / n) * bars.width;
  pulseOf(scope).dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, clientX, clientY: bars.top + 4 }),
  );
}

/**
 * The board: the season's numbers, with the hover the board draws (the pulse on its seventh day).
 * Hovering another day moves the one hairline and the one plate; leaving clears them.
 */
export const Board: Story = {
  name: '1.4 Overview | Metrics',
  args: { pulseActive: 6 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await faceLoaded(must(canvasElement.querySelector('[data-slot="value"]')));

    // The stats: now, and the last seven days.
    await expect(canvas.getByText('1 safety')).toBeInTheDocument();
    await expect(
      canvas.getByText('Mascoma Lake', { selector: '[data-slot="stat-sub"]' }),
    ).toBeVisible();
    await expect(canvas.getByText('Median under 6 h')).toBeVisible();
    await expect(canvas.getByText('Oldest 2 d')).toBeVisible();
    await expect(canvas.getByText('7 on two days or more')).toBeVisible();
    // The oldest flag is past three days: red.
    const oldest = must(
      canvasElement
        .querySelector<HTMLElement>('[data-slot="age-value"]')
        ?.closest<HTMLElement>('[data-slot="value"]'),
    );
    await expect(oldest.dataset.tone).toBe('bad');
    await expect(oldest).toHaveTextContent(/3\s?d\s?22\s?h/);

    // The drawn hover: Saturday 9 January, every strip's value.
    const plate = must(plateOf(canvasElement));
    await expect(plate).toHaveTextContent('Sat 9 Jan');
    const values = [...plate.querySelectorAll('[data-slot="pulse-plate-value"]')].map(
      (v) => v.textContent,
    );
    await expect(values).toEqual(['3', '2', '9', '6', '1', '0', '11', '6']);

    // One hairline runs through every strip.
    const hair = must(
      canvasElement.querySelector('[data-slot="pulse-hairline"]'),
    ).getBoundingClientRect();
    const strips = [...canvasElement.querySelectorAll('[data-slot="pulse-bars"]')];
    await expect(strips).toHaveLength(8);
    await expect(hair.top).toBeLessThanOrEqual(must(strips[0]).getBoundingClientRect().top);
    await expect(hair.bottom).toBeGreaterThanOrEqual(
      must(strips.at(-1)).getBoundingClientRect().bottom - 0.5,
    );

    // The tables.
    await expect(canvas.getByText('Kezar Lake')).toBeVisible();
    await expect(canvas.getByText('1.47')).toBeVisible();
    await expect(canvas.getByText('24,953')).toBeVisible();
  },
};

/**
 * Hovering moves the one hairline and the one plate: over the last day the plate flips to the
 * hairline's left, and leaving the strips clears both. (The board story keeps its drawn hover.)
 */
export const PulseHover: Story = {
  play: async ({ canvasElement }) => {
    await expect(plateOf(canvasElement)).toBeNull();
    pointAtDay(canvasElement, 2, BOARD_DAYS.length);
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Tue 5 Jan'));
    const right = must(plateOf(canvasElement)).getBoundingClientRect();
    const hair = must(
      canvasElement.querySelector('[data-slot="pulse-hairline"]'),
    ).getBoundingClientRect();
    await expect(right.left).toBeGreaterThanOrEqual(hair.right);
    // The last day: the plate moves to its left and names it.
    pointAtDay(canvasElement, 13, BOARD_DAYS.length);
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Sat 16 Jan'));
    const moved = must(plateOf(canvasElement)).getBoundingClientRect();
    const hairNow = must(
      canvasElement.querySelector('[data-slot="pulse-hairline"]'),
    ).getBoundingClientRect();
    await expect(moved.right).toBeLessThanOrEqual(hairNow.left);
    // React hears a leave as a pointer going out to something outside.
    pulseOf(canvasElement).dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
    );
    await waitFor(() => expect(plateOf(canvasElement)).toBeNull());
  },
};

/**
 * The pulse answers the keyboard: once it has focus, ← → step through the days, Home and End
 * jump, Esc clears.
 */
export const PulseKeys: Story = {
  play: async ({ canvasElement }) => {
    const pulse = pulseOf(canvasElement);
    pulse.focus();
    await expect(plateOf(canvasElement)).toBeNull();
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Sat 16 Jan'));
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Fri 15 Jan'));
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Sun 3 Jan'));
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Sun 3 Jan'));
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toHaveTextContent('Sat 16 Jan'));
    pulse.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => expect(plateOf(canvasElement)).toBeNull());
  },
};

/**
 * The board as the writes stand today. Kudos has no record, the per-state widening is deferred,
 * and the sign-in record and the support queue's depth begin partway through the season: those
 * days are absent (no stub), the charts mark where the record begins, and nothing reads as zero.
 */
export const RecordedToday: Story = {
  name: 'Recorded today',
  args: {
    keepingUp: RECORDED_KEEPING_UP,
    showingUp: RECORDED_SHOWING_UP,
    coverage: RECORDED_COVERAGE,
    pulseActive: 3,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const kudos = must(canvasElement.querySelector('[data-slot="pulse-strip"][data-key="kudos"]'));
    await expect(
      kudos.querySelector('[data-slot="pulse-bars"]')?.getAttribute('data-recorded'),
    ).toBe('false');
    await expect(within(kudos as HTMLElement).getByText('Not recorded yet')).toBeVisible();
    // The week's sign-ins aren't a week yet.
    const signed = must(
      canvas.getByText('Signed in', { selector: '[data-slot="stat-label"]' }).parentElement,
    );
    await expect(signed).toHaveTextContent('—Not recorded yet');
    // A day before the sign-in record reads as a dash on the plate, never 0.
    const plate = must(plateOf(canvasElement));
    const values = [...plate.querySelectorAll('[data-slot="pulse-plate-value"]')].map(
      (v) => v.textContent,
    );
    await expect(values[2]).toBe('—');
    await expect(values[6]).toBe('—');
    // Four per-state columns are unrecorded in each of five rows.
    await expect(canvasElement.querySelectorAll('[data-unrecorded]')).toHaveLength(20);
    // The support chart marks where its record begins.
    await waitFor(() => expect(canvas.getAllByText('Record begins').length).toBeGreaterThan(0));
    await expect(RECORD_BEGAN).toBe(8);
  },
};

/** A quiet week: measured zeros, said as zeros — no "none" states, no invented bars. */
export const Quiet: Story = {
  args: { keepingUp: QUIET_KEEPING_UP, showingUp: QUIET_SHOWING_UP },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Nothing open')).toBeVisible();
    await expect(canvas.getAllByText('None resolved this season')).toHaveLength(2);
    await expect(canvas.getByText('No reports this season')).toBeVisible();
  },
};

/**
 * The tab as the app mounts it before any Metrics read exists: every figure a dash and *Not
 * recorded yet*, every chart its empty frame and a note — no zero anywhere, since a zero is
 * measured.
 */
export const NotReadYet: Story = {
  name: 'Not read yet',
  args: metricsNotRecorded(BOARD_DAYS, { support: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const label of ['Open flags', 'Oldest open flag', 'Flags resolved', 'Open tickets']) {
      const tile = must(
        canvas.getByText(label, { selector: '[data-slot="stat-label"]' }).parentElement,
      );
      await expect(tile).toHaveTextContent('—Not recorded yet');
    }
    await expect(canvas.getAllByText('Time to resolve lands here')).toHaveLength(2);
    await expect(canvas.getByText('The flag queue lands here')).toBeVisible();
    await expect(canvas.queryByText('Nothing open')).toBeNull();
    await expect(canvas.queryByText('None resolved this season')).toBeNull();
    await expect(canvas.queryByText('No reports this season')).toBeNull();
    await expect(canvas.queryByText('No listed bodies')).toBeNull();
    // The stats, vantage, most-reported and coverage each say it in words.
    await expect(canvas.getAllByText('Not recorded yet').length).toBeGreaterThanOrEqual(11);
    // No stat says a number.
    for (const value of canvasElement.querySelectorAll('[data-slot="value"]')) {
      await expect(value).toHaveTextContent('—');
    }
  },
};

/** A moderator without support access: no ticket stat, no support charts. */
export const WithoutSupport: Story = {
  name: 'Without support access',
  args: { keepingUp: { ...BOARD_KEEPING_UP, support: null } satisfies KeepingUpData },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Open tickets')).toBeNull();
    await expect(canvas.queryByText('Support · time to resolve')).toBeNull();
    await expect(canvas.queryByText('Open support tickets')).toBeNull();
    await expect(canvas.getByText('Flags · time to resolve')).toBeVisible();
  },
};

// ── A long season ────────────────────────────────────────────────────────────────────────────

const LONG = 108;
const longDays = Array.from({ length: LONG }, (_, i) =>
  new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
);
/** A deterministic wave: busy weekends, a cold snap in January. */
const wave = (scale: number, phase: number) =>
  longDays.map((_, i) =>
    Math.max(0, Math.round(scale * (1 + Math.sin(i / 3 + phase)) * (i / LONG))),
  );
const longPulse: Record<PulseKey, PulseSeries | null> = {
  reports: { daily: wave(3, 0), total: 120, over: 96 },
  comments: { daily: wave(4, 1), total: 210, over: 80 },
  kudos: null,
  photos: { daily: wave(4, 2), total: 260, over: 90 },
  hazards: { daily: wave(1, 3), total: 22, over: 14 },
  accounts: { daily: wave(1, 4), total: 31 },
  signedIn: { daily: wave(9, 5), total: 64 },
  contributors: { daily: wave(6, 0.5), total: 40 },
};
const longShowingUp: ShowingUpData = { ...BOARD_SHOWING_UP, pulse: longPulse };
const longKeepingUp: KeepingUpData = {
  ...BOARD_KEEPING_UP,
  queueByDay: longDays.map((_, i) => ({
    oldestHours: (i * 7) % 60,
    standard: i % 3,
    safety: i % 11 === 0 ? 1 : 0,
  })),
  support: BOARD_KEEPING_UP.support && {
    ...BOARD_KEEPING_UP.support,
    depthByDay: longDays.map((_, i) =>
      i < 43 ? null : { bug: i % 2, account: i % 5 === 0 ? 1 : 0 },
    ),
  },
};

/** A whole season, 1 Oct to today: the bars thin, the axes keep about five labels. */
export const LongSeason: Story = {
  args: {
    days: longDays,
    now: Date.UTC(2027, 0, 16, 16, 52),
    keepingUp: longKeepingUp,
    showingUp: longShowingUp,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByText('Today').length).toBeGreaterThan(1));
    const axis = must(canvasElement.querySelector('[data-slot="pulse-axis"]'));
    await expect(axis).toHaveTextContent('1 Oct');
    await expect(axis).toHaveTextContent('16 Jan');
  },
};

/** The right column in all four maps: the tones and the plate resolve per map. */
export const FourUp: Story = {
  parameters: { fourUp: true, layout: 'padded' },
  decorators: [(Story) => <div className="w-[40rem]">{Story()}</div>],
  render: () => (
    <ShowingUp data={BOARD_SHOWING_UP} days={BOARD_DAYS} timeZone={METRICS_ZONE} pulseActive={6} />
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) {
      await expect(plateOf(quad)).toHaveTextContent('Sat 9 Jan');
      await expect(quad.querySelectorAll('[data-slot="vantage-segment"]')).toHaveLength(3);
    }
  },
};
