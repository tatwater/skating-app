import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { type BoardCalls, fixtureTail, RunBoard } from './runBoard';
import {
  finishedPassDoc,
  loadDoc,
  loadView,
  MARKED,
  markedLoadView,
  NOW_LATE,
  NOW_MARKED,
  NOW_RUNNING,
  NOW_STALLED,
  WAITING,
} from './runFixtures';

/**
 * The run page: one pass (the board's load, opened from its campaign) or a single run, the old run
 * detail re-skinned in the kit — on the pinned clock, through `live-v5` §1's states, and a finished
 * pass with a long record (coverage's *unexplained* remainder, tallies past their preview, failures).
 */
const meta = {
  title: 'Admin/Machinery/Run',
  component: RunBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { now: NOW_STALLED, run: loadView(NOW_STALLED) },
} satisfies Meta<typeof RunBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const bar = (root: ParentNode) => root.querySelector('[data-slot="run-actions"]');

export const Running: Story = {
  args: { now: NOW_RUNNING, run: loadView(NOW_RUNNING) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-title')).toHaveTextContent('load');
    await expect(slot(canvasElement, 'run-kicker')).toHaveTextContent(
      'Campaign pass · full canonical · dev',
    );
    await expect(within(canvasElement).getByText('Campaign a07a-20261012 →')).toBeVisible();
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Running');
    await expect(bar(canvasElement)).toBeNull();
  },
};

export const Late: Story = {
  args: { now: NOW_LATE, run: loadView(NOW_LATE) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveAttribute('data-tone', 'warn');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(within(canvasElement).queryAllByRole('button', { name: /Wait 30/ })).toHaveLength(
      0,
    );
  },
};

export const Stalled: Story = {
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Stalled');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(
      within(canvasElement).queryAllByRole('button', { name: /Wait 30/ }).length,
    ).toBeGreaterThan(0);
    await expect(within(canvasElement).queryAllByRole('button', { name: /^Stop/ })).toHaveLength(0);
    // The record: coverage with its computed remainder, the tallies grouped, the failures.
    await expect(slot(canvasElement, 'coverage')).toHaveTextContent('37.6%');
    await expect(slot(canvasElement, 'unexplained')).toHaveTextContent('738');
    await expect(slot(canvasElement, 'tallies')).toHaveTextContent('Sent to the review queue');
    await expect(slot(canvasElement, 'failures')).toHaveTextContent('nhd/3290011');
    await expect(slot(canvasElement, 'what-to-check')).toHaveTextContent('run-a07a-20261012.log');
  },
};

export const Waiting: Story = {
  args: {
    run: loadView(NOW_STALLED, {
      doc: loadDoc({
        stallWait: {
          until: WAITING.until,
          byUserId: WAITING.by.id,
          at: WAITING.at,
          actionId: 'a' as never,
        },
      }),
      waiting: WAITING,
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Waiting until 14:42');
    await expect(slot(canvasElement, 'heartbeat')).toHaveTextContent('Waiting until 14:42');
  },
};

/**
 * The wait's record outlives the wait: a flush came, or the run closed, before the half hour was up.
 * The page reads the rule, not the record — no *Waiting* note beside *Running* or an ended run.
 */
export const WaitEndedEarly: Story = {
  args: { now: NOW_RUNNING, run: loadView(NOW_RUNNING, { waiting: WAITING }) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Running');
    await expect(canvasElement.querySelector('[data-slot="run-waiting"]')).toBeNull();
  },
};

export const WaitEndedByClose: Story = {
  args: { run: loadView(NOW_STALLED, { doc: finishedPassDoc(), waiting: WAITING }) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-view')).toHaveAttribute('data-state', 'finished');
    await expect(canvasElement.querySelector('[data-slot="run-waiting"]')).toBeNull();
  },
};

/** Marked, and the loader's own close came after: kept beside the mark, the mark stands. */
export const MarkedWithLateClose: Story = {
  args: {
    now: NOW_MARKED,
    run: loadView(NOW_MARKED, {
      doc: loadDoc({
        status: 'failed',
        finishedAt: NOW_MARKED,
        markedFailed: {
          byUserId: MARKED.by.id,
          at: NOW_MARKED,
          reason: MARKED.reason,
          actionId: 'a' as never,
        },
        loaderFinish: { status: 'succeeded', at: NOW_MARKED + 60_000 },
      }),
      marked: { ...MARKED, loaderFinish: { status: 'succeeded', at: NOW_MARKED + 60_000 } },
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Marked failed · 14:20');
    await expect(slot(canvasElement, 'loader-finish')).toHaveTextContent(
      'later reported it succeeded',
    );
    await expect(bar(canvasElement)).toBeNull();
    await expect(slot(canvasElement, 'tail')).toHaveTextContent('Log');
  },
};

/** A row from before heartbeats, left running: *No heartbeat recorded*, and *Mark failed* offered. */
/**
 * The load marked failed, its campaign still open: its own page offers *Mark the campaign failed
 * too*, which marks the campaign (not the load again), naming the load it follows.
 */
export const MarkedCampaignOpen: Story = {
  args: {
    now: NOW_MARKED,
    run: markedLoadView(),
    calls: { marks: [], waits: [], undone: [] } satisfies BoardCalls,
  },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as BoardCalls;
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Marked failed · 14:20');
    const [too] = await waitFor(() => {
      const found = within(canvasElement).queryAllByRole('button', {
        name: /Mark the campaign failed too/,
      });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await userEvent.click(must(too));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Mark a07a-20261012 failed?');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop is off.');
    await userEvent.click(
      must(dialog.querySelector<HTMLElement>('[data-slot="alert-dialog-action"]')),
    );
    await waitFor(() =>
      expect(calls.marks).toEqual([
        { runId: 'run_campaign', reason: 'Laptop is off.', afterPass: 'run_load' },
      ]),
    );
  },
};

export const NoHeartbeat: Story = {
  args: { run: loadView(NOW_STALLED, { doc: loadDoc({ progressAt: undefined }) }) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('No heartbeat recorded');
    await expect(slot(canvasElement, 'heartbeat')).toHaveTextContent('Not recorded');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
  },
};

/** A finished single pass: no bar; *Not recorded* where the row holds nothing; tallies open on press. */
export const FinishedPass: Story = {
  args: {
    now: NOW_STALLED,
    run: { ...loadView(NOW_STALLED, { doc: finishedPassDoc() }), parent: null },
    tail: fixtureTail([], false),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-kicker')).toHaveTextContent(
      'Single pass · Scope not recorded · dev',
    );
    await expect(slot(canvasElement, 'run-kicker')).not.toHaveTextContent('Dry run');
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Succeeded');
    await expect(slot(canvasElement, 'coverage')).toHaveTextContent('Not recorded');
    await expect(slot(canvasElement, 'path')).toHaveTextContent('Not recorded');
    await expect(
      within(canvasElement).getByText('No log lines recorded for this run'),
    ).toBeVisible();
    const more = within(canvasElement).getByRole('button', { name: '3 more in this group' });
    await userEvent.click(more);
    await expect(
      slot(canvasElement, 'tallies').querySelectorAll('[data-slot="share-row"]'),
    ).toHaveLength(11);
    await expect(bar(canvasElement)).toBeNull();
  },
};

/** A dry run says so in its kicker. */
export const DryRun: Story = {
  args: {
    run: {
      ...loadView(NOW_STALLED, {
        doc: { ...finishedPassDoc(), notes: ['dry run — nothing written'] },
      }),
      dryRun: true,
      parent: null,
    },
    tail: fixtureTail([], false),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-kicker')).toHaveTextContent('Dry run');
  },
};

export const Narrow: Story = {
  args: { narrow: true },
  play: async ({ canvasElement }) => {
    const pane = slot(canvasElement, 'story-run-pane');
    const scroll = slot(canvasElement, 'inbox-inspector-scroll');
    await expect(scroll.scrollWidth).toBe(pane.clientWidth);
  },
};

export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll('[data-theme-scope] [data-slot="run-view"]'),
    ).toHaveLength(4);
  },
};
