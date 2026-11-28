import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { ThemePair } from '../../../../../.storybook/theme';
import { CronBoard, type CronBoardProps } from './cronBoard';
import { FLUSH, FLUSH_JOB, IMAGERY_JOBS, PUMP, STATE_JOBS } from './cronFixtures';

/**
 * The runs drawer (boards 6.4 *Runs* and *Runs · Pump*): the poll's history since the start, the
 * pump's last 12 hours with its quiet checks folded and its failed runs' logs open, the *Failed*
 * filter (which leaves killed runs under *All*, and says so), a sparse mutation cron (no durations,
 * quiet hours), loading, and a cron with nothing recorded yet. Each in dark and light, at the board's
 * width (1440 × 900); `Board` alone is the render-compare frame.
 */

function Pair(props: CronBoardProps) {
  return (
    <ThemePair surface="admin" columns="one" height="900px">
      {(_mode, container) => <CronBoard {...props} container={container} />}
    </ThemePair>
  );
}

/** The board's frame, dark only: 1440 × 900, the sheet docked at its right. */
function Board(props: CronBoardProps) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setEl}
      data-slot="story-board"
      className="relative isolate h-[900px] w-[1440px] overflow-hidden bg-bg"
    >
      {el !== null && <CronBoard {...props} container={el} />}
    </div>
  );
}

const meta = {
  title: 'Admin/Machinery/Crons/Runs drawer',
  component: Pair,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Pair>;

export default meta;
type Story = StoryObj<typeof meta>;

const all = (root: ParentNode, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];
/** The first quad's drawer (dark). */
const quad = (root: HTMLElement) => must(root.querySelector<HTMLElement>('[data-mode="dark"]'));

export const Poll: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-tab')).toHaveLength(3));
    const tabs = all(q, 'cron-tab');
    await expect(tabs.map((t) => t.textContent?.slice(0, 4))).toEqual(['Poll', 'Pump', 'Rebu']);
    await expect(must(tabs[0])).toHaveAttribute('aria-selected', 'true');
    // Each tab mirrors its card: the pump is running, the poll on time at its last run.
    await expect(must(tabs[1]).dataset.state).toBe('running');
    await expect(must(tabs[0])).toHaveTextContent('12:40');
    await expect(must(tabs[0])).toHaveTextContent('Every 6 hours');
    // Since the start, Fri 9 Oct to now; an interval cron names its last run, never a next.
    await expect(must(q.querySelector('[data-slot="cron-tick-from"]'))).toHaveTextContent(
      'Fri 9 Oct',
    );
    await expect(must(q.querySelector('[data-slot="cron-runs-right"]'))).toHaveTextContent(
      'Every 6 hours · last 12:40',
    );
    // Every run's took is measured (an action), and the count columns are the page's.
    await expect(within(q).getByRole('columnheader', { name: 'Took' })).toBeVisible();
    await expect(within(q).getByRole('columnheader', { name: 'Found' })).toBeVisible();
    await expect(all(q, 'cron-run')[0]).toHaveTextContent('Today 12:40');
    await expect(all(q, 'cron-run')[0]).toHaveTextContent('6 new');
    // The poll's Run now is in the foot.
    await expect(all(q, 'story-run-now')).toHaveLength(1);
  },
};

export const Pump: Story = {
  args: { job: PUMP },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-run').length).toBeGreaterThan(0));
    // The quiet ticks between two runs fold into one line each, never a row per tick.
    const quiet = all(q, 'cron-quiet');
    await expect(quiet.length).toBeGreaterThan(0);
    for (const row of quiet) {
      await expect(row.textContent).toMatch(/^\d+ quiet checks? · \d\d:\d\d(–\d\d:\d\d)?$/);
    }
    // A failed and a killed run open their logs by themselves; the successful ones stay shut.
    const open = all(q, 'cron-run').filter((r) => r.dataset.open !== undefined);
    await expect(open.map((r) => r.dataset.outcome)).toEqual(['killed', 'failed']);
    await expect(all(q, 'cron-run-logrow')).toHaveLength(2);
    // A press of Run now says who pressed it.
    await expect(must(q.querySelector('[data-slot="cron-run-pressed"]'))).toHaveTextContent(
      'Run now · Teagan',
    );
    // No foot on the pump: Run now is the poll's alone.
    await expect(all(q, 'story-run-now')).toHaveLength(0);
    // Opening a successful run's log.
    const first = must(all(q, 'cron-run')[0]);
    await userEvent.click(within(first).getByRole('button', { name: /^Log · / }));
    await waitFor(() => expect(all(q, 'cron-run-logrow')).toHaveLength(3));
    await expect(within(first).getByRole('button', { name: /^Hide log · / })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};

export const FailedFilter: Story = {
  args: { job: PUMP, filter: 'failed' },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-run').length).toBeGreaterThan(0));
    await expect(all(q, 'cron-run').map((r) => r.dataset.outcome)).toEqual(['failed']);
    // The read lists failed runs only: the list says a killed run is under All (Ma29).
    await expect(must(q.querySelector('[data-slot="cron-runs-killed-note"]'))).toHaveTextContent(
      'They’re under All',
    );
    await expect(all(q, 'cron-quiet')).toHaveLength(0);
  },
};

export const DidSomething: Story = {
  args: { job: PUMP, filter: 'worked' },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-run').length).toBe(9));
    // The runs alone: no folded quiet lines.
    await expect(all(q, 'cron-quiet')).toHaveLength(0);
  },
};

export const SparseMutation: Story = {
  args: { job: FLUSH, jobs: [FLUSH_JOB] },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-run')).toHaveLength(1));
    // A mutation job's duration is never measured: no Took column, never "0 ms".
    await expect(within(q).queryByRole('columnheader', { name: 'Took' })).toBeNull();
    await expect(q.textContent).not.toContain('0 ms');
    // Its quiet ticks are kept once an hour, and the fold counts hours.
    await expect(must(q.querySelector('[data-slot="cron-tick-note"]'))).toHaveTextContent(
      'Quiet checks are kept once an hour',
    );
    await expect(must(all(q, 'cron-quiet')[0]).textContent).toMatch(/quiet hours?/);
  },
};

export const Loading: Story = {
  args: { runs: 'loading', ticks: 'loading', jobs: 'loading' },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-runs-loading')).toHaveLength(1));
    await expect(must(q.querySelector('[data-slot="cron-tick-marks"]'))).toHaveAttribute(
      'data-loading',
    );
  },
};

export const NothingRecorded: Story = {
  args: {
    job: 'never ticked',
    jobs: [must(STATE_JOBS[0]).job],
    runs: [],
    ticks: [],
  },
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-tab')).toHaveLength(1));
    await expect(must(all(q, 'cron-tab')[0])).toHaveTextContent('Not recorded yet');
    await expect(q).toHaveTextContent('No runs yet');
    await expect(q).toHaveTextContent('Nothing recorded in this range yet');
  },
};

export const SwitchTabs: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    await waitFor(() => expect(all(q, 'cron-tab')).toHaveLength(3));
    await userEvent.click(must(all(q, 'cron-tab')[1]));
    await waitFor(() =>
      expect(must(all(q, 'cron-tab')[1])).toHaveAttribute('aria-selected', 'true'),
    );
    await expect(must(q.querySelector('[data-slot="cron-tick-from"]'))).toHaveTextContent('02:12');
  },
};

export const BoardPoll: Story = {
  render: () => <Board />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(all(canvasElement, 'cron-tab')).toHaveLength(3));
  },
};

export const BoardPump: Story = {
  render: () => <Board job={PUMP} jobs={IMAGERY_JOBS} />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(all(canvasElement, 'cron-run').length).toBeGreaterThan(0));
  },
};
