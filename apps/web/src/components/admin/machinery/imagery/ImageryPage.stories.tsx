import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { expectNoSidewaysScroll, faceLoaded, must } from '@/components/kit/storyKit';

import { ImageryBoard, type ImageryCalls } from './imageryBoard';
import {
  BACKING_OFF_PAGE,
  BEFORE_VIEW,
  CROSSED_PAGE,
  EMPTY_A,
  ENDED_PAGE,
  FAILED_OOM,
  LANDED_A,
  NO_WATCH_PAGE,
  OLD_IMAGE_VIEW,
  PAUSED_PAGE,
  REFUSED_VIEW,
  RUNNING_PAGE,
  UNCONFIGURED_PAGE,
  WAITING_PAGE,
} from './imageryFixtures';

/**
 * Boards 6.4 — Machinery › Imagery in the console's frame at 1440 × 1060, on the board's clock (14:12
 * on 14 Oct 2026): the sidebar with *Imagery* under *Pipelines*, the head across the list and the
 * detail (the five stats, the three cron cards), the granule list failed-first, and the open
 * granule. Every state the brief lists: running, paused, ended, not started (waiting for cold, and
 * the line crossed), no watch, unconfigured — and a granule failed for memory (its log open), landed
 * (its log collapsed), from before attempts were recorded, and cut on an old image with no log.
 * Render one beside its board to compare.
 */
const meta = {
  title: 'Admin/Machinery/Imagery',
  component: ImageryBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { view: RUNNING_PAGE, initialOpen: FAILED_OOM.id },
} satisfies Meta<typeof ImageryBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];
const detailOf = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-pane="detail"]'));

/** Board 6.4: running, the OOM granule open, its second attempt's log open. */
export const Running: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Imagery');
    await expect(slot(canvasElement, 'imagery-kicker')).toHaveTextContent(
      'Winter 2026–27 · polled and pumped on Convex · cut on Fly',
    );
    // The sidebar: Pipelines › Corpus and Imagery, Imagery on screen with its Convex tag.
    const nav = page.getByRole('navigation', { name: 'Machinery' });
    const imagery = within(nav).getByRole('button', { name: /^Imagery/ });
    await expect(imagery).toHaveAttribute('aria-current', 'true');
    await expect(imagery).toHaveTextContent('Convex');
    await expect(nav).not.toHaveTextContent(/Health|Cost ledger|\$/);
    // The head's five stats, machine-minutes only, never a dollar.
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-state')).toHaveTextContent('Running');
    await expect(slot(head, 'stat-state')).toHaveTextContent('Started by Teagan 9 Oct');
    await expect(slot(head, 'stat-landed')).toHaveTextContent('Of 23 queued since the start');
    await expect(slot(head, 'stat-machines')).toHaveTextContent('2/25');
    await expect(slot(head, 'stat-index')).toHaveTextContent('Not built');
    await expect(slot(head, 'stat-fly')).toHaveTextContent('38 machine-min');
    await expect(head).not.toHaveTextContent('$');
    // The three cron cards, the poll's Run now drawn while imagery runs.
    await expect(slots(head, 'cron-card')).toHaveLength(3);
    await expect(slot(head, 'cron-run-now')).toBeEnabled();
    // The list: the failed granule first, then everything else.
    const list = page.getByRole('listbox', { name: 'Granules' });
    const rows = within(list).getAllByRole('option');
    await expect(rows).toHaveLength(8);
    await expect(slot(must(rows[0]), 'granule-row-state')).toHaveTextContent('failed');
    await expect(slot(must(rows[0]), 'granule-row-attempts')).toHaveTextContent('2 attempts');
    await expect(slot(canvasElement, 'granule-divider')).toHaveTextContent(
      'Everything else · newest first',
    );
    await expect(slot(canvasElement, 'granule-list-end')).toHaveTextContent('All 8');
    // An empty cut says the cutter's reason, never cloud.
    await expect(list).not.toHaveTextContent(/cloud/i);
    await expect(list).toHaveTextContent('Nothing to cut · no lake inside the imaged footprint');
    // A queued granule waits for a machine; no next-run clock time (ruling 17).
    await expect(list).toHaveTextContent('waiting for a machine');
    // The detail: exit 137, red; both attempts; attempt 2's log open.
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'granule-title')).toHaveTextContent('Sentinel-1A · 12 Oct');
    await expect(slot(detail, 'granule-state')).toHaveTextContent('Failed · 2 attempts');
    await expect(slot(detail, 'stat-exit')).toHaveTextContent('137');
    await expect(slot(detail, 'stat-exit')).toHaveTextContent('Killed: out of memory');
    const bad = computedColor(canvasElement, 'var(--bad)');
    await expect(getComputedStyle(slot(slot(detail, 'stat-exit'), 'value')).color).toEqual(
      sameColor(bad),
    );
    const attempts = slots(detail, 'attempt-row');
    await expect(attempts.map((r) => r.dataset.verdict)).toEqual(['requeued', 'failed']);
    await expect(must(attempts[1])).toHaveAttribute('data-selected');
    await expect(slot(detail, 'machine-log')).toHaveAttribute('data-open');
    await expect(slot(detail, 'machine-log')).toHaveTextContent(
      'Attempt 2 · from the cutter and Fly',
    );
    await expect(slot(detail, 'attempt-log')).toHaveTextContent('exit 137 · out of memory');
    await expect(slot(detail, 'what-to-check')).toHaveTextContent('Exit 137');
    await expect(slot(detail, 'what-to-check')).toHaveTextContent('Machine size');
    // The season's bar: Retry failed · 1, Pause; no Try again now (nothing is waiting).
    const bar = page.getByRole('toolbar', { name: 'This season' });
    await expect(within(bar).getByRole('button', { name: /Retry failed · 1/ })).toBeVisible();
    await expect(within(bar).getByRole('button', { name: /Pause/ })).toBeVisible();
    await expect(within(bar).queryByRole('button', { name: /Try again now/ })).toBeNull();
  },
};

export const RunningLight: Story = { globals: { surface: 'admin', mode: 'light' } };

/** Four-up: both modes, both densities. */
export const FourUp: Story = { name: 'Four-up', parameters: { fourUp: true } };

/** Attempt 1 pressed: its log shows in place of attempt 2's. */
export const PressAnAttempt: Story = {
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await userEvent.click(must(slots(detail, 'attempt-row')[0]));
    await waitFor(() =>
      expect(slot(detailOf(canvasElement), 'machine-log')).toHaveTextContent('Attempt 1'),
    );
  },
};

/** A landed granule: its log collapsed behind *Show the log*. */
export const Landed: Story = {
  args: { initialOpen: LANDED_A.id },
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'granule-state')).toHaveTextContent('Landed');
    const log = slot(detail, 'machine-log');
    await expect(log).not.toHaveAttribute('data-open');
    await expect(within(log).queryByRole('log')).toBeNull();
    await userEvent.click(within(log).getByRole('button', { name: /Show the log/ }));
    await waitFor(() =>
      expect(slot(detailOf(canvasElement), 'attempt-log')).toHaveTextContent('settled landed'),
    );
    await expect(detail).not.toHaveTextContent('What to check');
  },
};

/** An empty granule: the cutter's reason, never cloud. */
export const Empty: Story = {
  args: { initialOpen: EMPTY_A.id },
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'granule-state')).toHaveTextContent('Empty');
    await expect(detail).not.toHaveTextContent(/cloud/i);
  },
};

/** From before attempts were recorded: its count and last error, never an empty table. */
export const BeforeAttempts: Story = {
  args: {
    initialOpen: BEFORE_VIEW.row.id,
    view: { ...RUNNING_PAGE, fly: { ...RUNNING_PAGE.fly, countedFrom: Date.UTC(2026, 9, 1, 4) } },
  },
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'attempts-before')).toHaveTextContent(
      'Attempts before 1 Oct weren’t recorded. This granule kept its count (2) and its last error: exit 1.',
    );
    await expect(detail.querySelector('[data-slot="attempts-table"]')).toBeNull();
    await expect(slot(detail, 'stat-catalog')).toHaveTextContent('Not recorded');
  },
};

/** Cut on an image from before logs were kept: says so, and still shows Fly's word. */
export const OldImage: Story = {
  args: { initialOpen: OLD_IMAGE_VIEW.row.id, rows: [OLD_IMAGE_VIEW.row] },
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'machine-log-note')).toHaveTextContent(
      'This cutter didn’t keep a log of its own',
    );
    await expect(slot(detail, 'machine-log')).toHaveTextContent('from Fly');
    await expect(slot(detail, 'attempt-log')).toHaveTextContent('exit 2');
    await expect(slot(detail, 'what-to-check')).toHaveTextContent('No cutter log');
    // A machine time read only from the settle is an estimate.
    await expect(slot(detail, 'attempts-table')).toHaveTextContent('about 2 m 00');
  },
};

/** Every spawn turned down: no Machine ran, so no log — and never blamed on an old image. */
export const RefusedSpawns: Story = {
  args: { initialOpen: REFUSED_VIEW.row.id, rows: [REFUSED_VIEW.row] },
  play: async ({ canvasElement }) => {
    const detail = detailOf(canvasElement);
    await expect(slot(detail, 'machine-log-note')).toHaveTextContent('Fly turned this one down');
    await expect(slot(detail, 'machine-log')).not.toHaveTextContent('from Fly');
    await expect(detail.querySelector('[data-slot="attempt-log"]')).toBeNull();
    await expect(slot(detail, 'what-to-check')).toHaveTextContent('Spawn refused');
    await expect(slot(detail, 'what-to-check')).not.toHaveTextContent('No cutter log');
  },
};

/** Paused: the state amber, *Resume* in the bar, no *Run now* on the poll. */
export const Paused: Story = {
  args: { view: PAUSED_PAGE },
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-state')).toHaveTextContent('Paused');
    await expect(head.querySelector('[data-slot="cron-run-now"]')).toBeNull();
    const bar = within(canvasElement).getByRole('toolbar', { name: 'This season' });
    await expect(within(bar).getByRole('button', { name: /Resume/ })).toBeVisible();
    await expect(within(bar).queryByRole('button', { name: /^Pause/ })).toBeNull();
  },
};

/** Ended: its word, no bar, no *Run now*. */
export const Ended: Story = {
  args: { view: ENDED_PAGE, initialOpen: null },
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-state')).toHaveTextContent('Ended');
    await expect(slot(head, 'stat-index')).toHaveTextContent('212 frames');
    await expect(slot(head, 'stat-fly')).toHaveTextContent('Counted from 1 Oct');
    await expect(within(canvasElement).queryByRole('toolbar', { name: 'This season' })).toBeNull();
    await expect(head.querySelector('[data-slot="cron-run-now"]')).toBeNull();
    await expect(slot(canvasElement, 'granule-none')).toHaveTextContent('No granule open');
  },
};

/** Backing off: the note says until when, and *Try again now* joins the bar. */
export const BackingOff: Story = {
  args: { view: BACKING_OFF_PAGE },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'imagery-backoff')).toHaveTextContent('waiting until 14:34');
    const bar = within(canvasElement).getByRole('toolbar', { name: 'This season' });
    await expect(within(bar).getByRole('button', { name: /Try again now/ })).toBeVisible();
    await expect(slot(canvasElement, 'stat-index')).toHaveTextContent('14:20');
  },
};

/** Board *Waiting for Cold*: not started, the line not reached, *Run now* drawn disabled. */
export const WaitingForCold: Story = {
  args: { view: WAITING_PAGE, initialOpen: null, className: 'h-[70rem] w-[90rem]' },
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-state')).toHaveTextContent('Not started');
    await expect(slot(head, 'stat-watch')).toHaveTextContent('Open');
    await expect(slot(head, 'stat-closest')).toHaveTextContent('20.8 °F');
    await expect(slot(head, 'stat-line')).toHaveTextContent('20 °F');
    await expect(slot(head, 'cron-run-now')).toBeDisabled();
    await expect(slot(canvasElement, 'sentinel-table')).toHaveTextContent(
      'How close each sentinel has come',
    );
    await expect(slot(canvasElement, 'watch-words')).toHaveTextContent('What it’s waiting for');
    const panel = slot(canvasElement, 'start-panel');
    await expect(panel.querySelector('[data-slot="ready-to-start"]')).toBeNull();
    await expect(within(panel).getByRole('button', { name: /Start imagery/ })).toBeEnabled();
    await expect(canvasElement).not.toHaveTextContent('$');
    // The lane's tail: not started, quiet (nothing waits on a person yet).
    const nav = within(canvasElement).getByRole('navigation', { name: 'Machinery' });
    await expect(within(nav).getByRole('button', { name: /^Imagery/ })).toHaveTextContent(
      'not started',
    );
  },
};

export const WaitingForColdLight: Story = {
  args: { view: WAITING_PAGE, initialOpen: null },
  globals: { surface: 'admin', mode: 'light' },
};

/** Board *Line Crossed*: ready to start, the staff email's time, the lane amber. */
export const LineCrossed: Story = {
  args: { view: CROSSED_PAGE, initialOpen: null, className: 'h-[70rem] w-[90rem]' },
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-line')).toHaveTextContent('Crossed');
    await expect(slot(head, 'stat-email')).toHaveTextContent('07:31');
    await expect(slot(head, 'stat-email')).toHaveTextContent('Today · to staff');
    await expect(slot(canvasElement, 'ready-to-start')).toHaveTextContent('Ready to start');
    await expect(slot(canvasElement, 'watch-words')).toHaveTextContent('What happened');
    const nav = within(canvasElement).getByRole('navigation', { name: 'Machinery' });
    const tail = must(
      [
        ...within(nav)
          .getByRole('button', { name: /^Imagery/ })
          .querySelectorAll<HTMLElement>('*'),
      ].find((el) => el.textContent === 'not started'),
    );
    await expect(getComputedStyle(tail).color).toEqual(
      sameColor(computedColor(tail, 'var(--warn)')),
    );
  },
};

/** Start imagery: the write lands, the receipt says so with its Undo. */
export const Start: Story = {
  args: { view: CROSSED_PAGE, initialOpen: null, calls: { sent: [], undone: [] } },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as ImageryCalls;
    const panel = slot(canvasElement, 'start-panel');
    await userEvent.click(within(panel).getByRole('button', { name: /Start imagery/ }));
    await waitFor(() => expect(calls.sent.map((c) => c.write)).toEqual(['startImagery']));
    await expect(calls.sent[0]?.args).toEqual({ season: 'winter-2026-27' });
    await waitFor(() => expect(within(document.body).getByText('Imagery started')).toBeVisible());
  },
};

/** A refusal is a toast, never inline. */
export const StartRefused: Story = {
  args: { view: CROSSED_PAGE, initialOpen: null, refuse: true, calls: { sent: [], undone: [] } },
  play: async ({ canvasElement }) => {
    const panel = slot(canvasElement, 'start-panel');
    await userEvent.click(within(panel).getByRole('button', { name: /Start imagery/ }));
    await waitFor(() =>
      expect(within(document.body).getAllByText('Imagery not started').length).toBeGreaterThan(0),
    );
    await expect(document.body).toHaveTextContent('Imagery has already started this season.');
    await expect(panel).not.toHaveTextContent('has already started');
  },
};

/** *Pause* lands with its Undo; the Undo runs the server's inverse (*Resume*). */
export const PauseThenUndo: Story = {
  args: { calls: { sent: [], undone: [] } },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as ImageryCalls;
    const bar = within(canvasElement).getByRole('toolbar', { name: 'This season' });
    await userEvent.click(within(bar).getByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(calls.sent.map((c) => c.write)).toEqual(['pauseImagery']));
    const body = within(document.body);
    await body.findByText('Imagery paused');
    await userEvent.click(await body.findByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(calls.undone).toEqual(['act_pauseImagery']));
  },
};

/** *Retry failed*: the receipt says how many went back, and offers no Undo. */
export const RetryFailed: Story = {
  args: { calls: { sent: [], undone: [] } },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as ImageryCalls;
    const bar = within(canvasElement).getByRole('toolbar', { name: 'This season' });
    await userEvent.click(within(bar).getByRole('button', { name: /Retry failed/ }));
    await waitFor(() => expect(calls.sent.map((c) => c.write)).toEqual(['retryFailed']));
    await within(document.body).findByText('1 failed cut is back in line');
  },
};

/** *Run now* on the poll, while imagery runs. */
export const RunNow: Story = {
  args: { calls: { sent: [], undone: [] }, initialOpen: null },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as ImageryCalls;
    await userEvent.click(slot(canvasElement, 'cron-run-now'));
    await waitFor(() => expect(calls.sent.map((c) => c.write)).toEqual(['pollNow']));
    await within(document.body).findByText('Checking the catalogs now');
  },
};

/** No ice watch yet, and no cron tick recorded: *Not recorded yet*, start drawn disabled. */
export const NoWatch: Story = {
  args: { view: NO_WATCH_PAGE, initialOpen: null, lows: null },
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'imagery-head');
    await expect(slot(head, 'stat-watch')).toHaveTextContent('Not open');
    await expect(head).toHaveTextContent('Not recorded yet');
    const panel = slot(canvasElement, 'start-panel');
    await expect(slot(panel, 'start-said')).toHaveTextContent('hasn’t opened this season');
    await expect(within(panel).getByRole('button', { name: /Start imagery/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** Fly and R2 unset: said in the head and the panel, start drawn disabled. */
export const Unconfigured: Story = {
  args: { view: UNCONFIGURED_PAGE, initialOpen: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'imagery-unconfigured')).toHaveTextContent(
      'Fly and R2 aren’t set up on this deployment',
    );
    const panel = slot(canvasElement, 'start-panel');
    await expect(within(panel).getByRole('button', { name: /Start imagery/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(panel.querySelector('[data-slot="ready-to-start"]')).toBeNull();
  },
};

/** A viewer without `machinery.imagery`: no bar, no switch's press, no *Run now*. */
export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('toolbar', { name: 'This season' })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="cron-run-now"]')).toBeNull();
  },
};

/** The filter: *Failed* lists the failed granule alone, with no divider. */
export const FilterFailed: Story = {
  args: { initialOpen: null },
  play: async ({ canvasElement }) => {
    await userEvent.click(must(canvasElement.querySelector<HTMLElement>('[data-filter="failed"]')));
    const list = within(canvasElement).getByRole('listbox', { name: 'Granules' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    await expect(canvasElement.querySelector('[data-slot="granule-divider"]')).toBeNull();
  },
};

/** Keys: ↓ moves the cursor, ⏎ opens the granule. */
export const Keys: Story = {
  args: { initialOpen: null },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('listbox', { name: 'Granules' });
    await userEvent.click(must(within(list).getAllByRole('option')[0]));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(must(within(list).getAllByRole('option')[1])).toHaveAttribute('aria-selected', 'true'),
    );
    await waitFor(() =>
      expect(slot(detailOf(canvasElement), 'granule-title')).toHaveTextContent('Sentinel-2B'),
    );
  },
};

/** The page's read: on its way, failed, no season. */
export const Loading: Story = { args: { view: null, read: 'loading' } };
export const Failed: Story = {
  args: { view: null, read: 'failed' },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'imagery-error')).toHaveTextContent('didn’t load');
  },
};
export const NoSeason: Story = {
  args: { view: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'imagery-none')).toHaveTextContent('No imagery season yet');
  },
};

/** A phone: one pane at a time, nothing sideways. */
export const Phone: Story = {
  args: { className: 'h-[50rem] w-[24.375rem]' },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'machinery-imagery-page')).toHaveAttribute('data-narrow');
    // The attempts table scrolls in its own box by design; nothing else moves sideways.
    await expectNoSidewaysScroll(canvasElement, { except: ['attempts-scroll'] });
  },
};
