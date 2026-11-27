import { campaignLiveness, type RunLivenessInput } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { type BoardCalls, cappedTail, RunBoard } from './runBoard';
import {
  assembledCampaign,
  at,
  boardCampaign,
  MARKED,
  NOW_LATE,
  NOW_MARKED,
  NOW_RUNNING,
  NOW_STALLED,
  passMarkedCampaign,
  WAITING,
} from './runFixtures';

/**
 * Board 6.2's right column and `live-v5` §1's run going quiet: the campaign page at the board's
 * 830 × 1630, on the pinned clock, in every state — running (13:31), late (13:38, past 2× its pace),
 * stalled (14:12, the board), held by *Wait 30 minutes*, marked failed by hand, marked with the
 * loader's own late close beside it, and a campaign from before its record was kept. Render one
 * beside `machinery-v5.html` to compare.
 */
const meta = {
  title: 'Admin/Machinery/Campaign',
  component: RunBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { now: NOW_STALLED, campaign: boardCampaign(NOW_STALLED) },
} satisfies Meta<typeof RunBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const bar = (root: ParentNode) => root.querySelector('[data-slot="run-actions"]');
const buttons = (root: HTMLElement, name: RegExp) =>
  within(root).queryAllByRole('button', { name });

/** 13:31 — running: on time, no bar, the heartbeat in seconds. */
export const Running: Story = {
  args: { now: NOW_RUNNING, campaign: boardCampaign(NOW_RUNNING) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Running');
    await expect(slot(canvasElement, 'heartbeat')).toHaveTextContent(/18\s*s ago/);
    await expect(slot(canvasElement, 'heartbeat')).toHaveTextContent('Reports about every 3 min');
    await expect(bar(canvasElement)).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="what-to-check"]')).toBeNull();
    await expect(
      slot(canvasElement, 'stage-bar').querySelectorAll('[data-tone="running"]'),
    ).toHaveLength(1);
  },
};

/** 13:38 — late: amber, *Mark failed* alone (full width), no *Wait*. */
export const Late: Story = {
  args: { now: NOW_LATE, campaign: boardCampaign(NOW_LATE) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Late · 6 min quiet');
    await expect(slot(canvasElement, 'run-state')).toHaveAttribute('data-tone', 'warn');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(buttons(canvasElement, /Mark failed/).length).toBeGreaterThan(0);
    await expect(buttons(canvasElement, /Wait 30 minutes/)).toHaveLength(0);
    await expect(slot(canvasElement, 'what-to-check')).toHaveTextContent(
      '.scratch/merge/run-a07a-20261012.log',
    );
  },
};

/** 14:12 — stalled: the board. Red, *Mark failed* and *Wait 30 minutes*, the page's stalled line. */
export const Stalled: Story = {
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-title')).toHaveTextContent('a07a-20261012');
    await expect(slot(canvasElement, 'run-kicker')).toHaveTextContent(
      'Campaign · full canonical · dev',
    );
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Stalled · 40 min quiet');
    await expect(slot(canvasElement, 'stat-passes')).toHaveTextContent(
      '2 done · load stalled · 7 waiting',
    );
    await expect(slot(canvasElement, 'stat-batches')).toHaveTextContent('66 / 170');
    await expect(slot(canvasElement, 'stat-elapsed')).toHaveTextContent(/1\s*h 14\s*m/);
    await expect(slot(canvasElement, 'stat-elapsed')).toHaveTextContent('Started 12:58');
    await expect(slot(canvasElement, 'heartbeat')).toHaveAttribute('data-state', 'stalled');
    // The passes: the load stalled in red, retire-absorbed required in amber.
    const load = must(canvasElement.querySelector('[data-pass="load"]'));
    await expect(load).toHaveTextContent('stalled');
    await expect(load).toHaveTextContent('0 / 9,412');
    await expect(load).toHaveAttribute('aria-current', 'true');
    await expect(
      must(canvasElement.querySelector('[data-pass="retire-absorbed"]')),
    ).toHaveTextContent('required');
    // The tail ends in the page's own stalled line, red-washed.
    const lines = [...canvasElement.querySelectorAll('[data-slot="log-line"]')];
    await expect(lines.at(-1)).toHaveTextContent(/stalled\s+no flush since 13:31:18/);
    await expect(lines.at(-1)).toHaveAttribute('data-fail');
    await expect(within(canvasElement).getByText('Scroll up for full log output')).toBeVisible();
    // Outcome so far and the path.
    await expect(slot(canvasElement, 'outcome-so-far')).toHaveTextContent('Last flush 13:31');
    await expect(slot(canvasElement, 'outcome-failures')).toHaveTextContent(
      '3 stored · nhd/3290011, 2 more',
    );
    await expect(slot(canvasElement, 'path')).toHaveTextContent('2026-10-11 · 412 MB · sha ✓');
    // The bar: both, and no Stop anywhere.
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(buttons(canvasElement, /Mark failed/).length).toBeGreaterThan(0);
    await expect(buttons(canvasElement, /Wait 30 minutes/).length).toBeGreaterThan(0);
    await expect(buttons(canvasElement, /^Stop/)).toHaveLength(0);
    await expect(within(canvasElement).queryByText(/^Stop$/)).toBeNull();
  },
};

/** *Wait 30 minutes* sends; its receipt's Undo runs the inverse on the server. */
export const WaitAndUndo: Story = {
  args: { calls: { marks: [], waits: [], undone: [] } satisfies BoardCalls },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as BoardCalls;
    const [wait] = await waitFor(() => {
      const found = buttons(canvasElement, /Wait 30 minutes/);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await userEvent.click(must(wait));
    await waitFor(() => expect(calls.waits).toHaveLength(1));
    const undo = await within(document.body).findByRole('button', { name: /Undo/ });
    await userEvent.click(undo);
    await waitFor(() => expect(calls.undone).toEqual(['act_wait']));
  },
};

/** *Mark failed* asks why (required); it lands, and its Undo reopens the run. */
export const MarkAndUndo: Story = {
  args: { calls: { marks: [], waits: [], undone: [] } satisfies BoardCalls },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as BoardCalls;
    const [mark] = await waitFor(() => {
      const found = buttons(canvasElement, /Mark failed/);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await userEvent.click(must(mark));
    const dialog = await within(document.body).findByRole('alertdialog');
    const confirm = must(dialog.querySelector<HTMLElement>('[data-slot="alert-dialog-action"]'));
    await expect(confirm).toHaveAttribute('data-disabled');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop slept; no process.');
    await waitFor(() => expect(confirm).not.toHaveAttribute('data-disabled'));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(calls.marks).toEqual([{ runId: 'run_load', reason: 'Laptop slept; no process.' }]),
    );
    await waitFor(() => expect(within(document.body).queryByRole('alertdialog')).toBeNull());
    const undo = await within(document.body).findByRole('button', { name: /Undo/ });
    await userEvent.click(undo);
    await waitFor(() => expect(calls.undone).toEqual(['act_mark']));
  },
};

/** A refused mark: the server's words in a toast that stays, the dialog open over the reason. */
export const MarkRefused: Story = {
  args: { refuse: true },
  play: async ({ canvasElement }) => {
    const [mark] = await waitFor(() => {
      const found = buttons(canvasElement, /Mark failed/);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await userEvent.click(must(mark));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'gone');
    await userEvent.click(
      must(dialog.querySelector<HTMLElement>('[data-slot="alert-dialog-action"]')),
    );
    await expect(
      (await within(document.body).findAllByText('Not marked failed · load')).length,
    ).toBeGreaterThan(0);
    await expect(
      within(document.body).getAllByText(/already finished, so it can’t be marked failed/).length,
    ).toBeGreaterThan(0);
    await expect(within(dialog).getByRole('textbox')).toHaveValue('gone');
    // Never printed in place.
    await expect(within(canvasElement).queryByText(/already finished/)).toBeNull();
  },
};

/** A wait whose record the read still sends, while the rule no longer reads *waiting*: no note. */
export const WaitEndedEarly: Story = {
  args: { campaign: { ...boardCampaign(NOW_RUNNING), waiting: WAITING }, now: NOW_RUNNING },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'campaign-view')).not.toHaveAttribute('data-state', 'waiting');
    await expect(canvasElement.querySelector('[data-slot="run-waiting"]')).toBeNull();
  },
};

/** Held by *Wait 30 minutes*: amber, until 14:42, who; *Mark failed* stays, no second *Wait*. */
export const Waiting: Story = {
  args: { campaign: boardCampaign(NOW_STALLED, { waiting: WAITING }) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Waiting until 14:42');
    await expect(slot(canvasElement, 'run-waiting')).toHaveTextContent('Sarah Lyme');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(buttons(canvasElement, /Wait 30 minutes/)).toHaveLength(0);
  },
};

/** 14:20 — marked failed by hand: who, the reason quoted, what the mark scheduled, no bar. */
export const MarkedFailed: Story = {
  args: { now: NOW_MARKED, campaign: boardCampaign(NOW_MARKED, { marked: MARKED }) },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Marked failed · 14:20');
    const note = slot(canvasElement, 'run-marked');
    await expect(note).toHaveTextContent('Teagan Atwater');
    await expect(note).toHaveTextContent('Laptop slept; no process.');
    await expect(note).toHaveTextContent(
      'asks for a weather-cell sync if it had already changed bodies',
    );
    await expect(slot(canvasElement, 'heartbeat')).toHaveTextContent(/failed\s*By hand/);
    await expect(bar(canvasElement)).toBeNull();
    const tones = [...slot(canvasElement, 'stage-bar').querySelectorAll('[data-tone]')].map((s) =>
      s.getAttribute('data-tone'),
    );
    await expect(tones.slice(0, 7)).toEqual([
      'done',
      'done',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
    ]);
  },
};

/**
 * 14:20 — the load marked failed, the campaign still open and silent since: the bar offers *Mark the
 * campaign failed too* in place of the campaign's own *Mark failed*; it asks why, and sends the
 * campaign's mark naming the load it follows. Its receipt's Undo reopens the campaign alone.
 */
export const PassMarkedCampaignOpen: Story = {
  args: {
    now: NOW_MARKED,
    campaign: passMarkedCampaign(),
    calls: { marks: [], waits: [], undone: [] } satisfies BoardCalls,
  },
  play: async ({ canvasElement, args }) => {
    const calls = args.calls as BoardCalls;
    const load = must(canvasElement.querySelector('[data-pass="load"]'));
    await expect(load).toHaveTextContent('failed');
    const [too] = await waitFor(() => {
      const found = buttons(canvasElement, /Mark the campaign failed too/);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // Never two buttons that send the same mark.
    await expect(buttons(canvasElement, /^Mark failed/)).toHaveLength(0);
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
    const undo = await within(document.body).findByRole('button', { name: /Undo/ });
    await userEvent.click(undo);
    await waitFor(() => expect(calls.undone).toEqual(['act_mark']));
  },
};

/** Once the script has opened its next pass, the read drops the offer: the campaign's own bar is back. */
export const PassMarkedCampaignMovedOn: Story = {
  args: { now: NOW_MARKED, campaign: { ...passMarkedCampaign(), campaignToo: null } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    await expect(buttons(canvasElement, /Mark the campaign failed too/)).toHaveLength(0);
    await expect(buttons(canvasElement, /Mark failed/).length).toBeGreaterThan(0);
  },
};

/** Marked, then the loader's own close landed beside the mark. */
export const MarkedWithLateClose: Story = {
  args: {
    now: NOW_MARKED,
    campaign: boardCampaign(NOW_MARKED, {
      marked: { ...MARKED, loaderFinish: { status: 'succeeded', at: NOW_MARKED + 60_000 } },
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'loader-finish')).toHaveTextContent(
      'The loader later reported it succeeded',
    );
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Marked failed · 14:20');
  },
};

/** August's campaign, rebuilt from its runs: always ended, its flags and plan not recorded, no bar. */
export const NoRecordKept: Story = {
  args: { campaign: assembledCampaign() },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'not-recorded-campaign')).toHaveTextContent(
      'Rebuilt from its runs',
    );
    await expect(slot(canvasElement, 'run-kicker')).toHaveTextContent('Scope not recorded');
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Succeeded');
    await expect(slot(canvasElement, 'stat-bodies')).toHaveTextContent('25,050');
    await expect(slot(canvasElement, 'stat-passes')).toHaveTextContent(
      '2 done · plan not recorded',
    );
    await expect(slot(canvasElement, 'stat-elapsed')).toHaveTextContent('Took');
    await expect(slot(canvasElement, 'path')).toHaveTextContent('Not recorded');
    await expect(bar(canvasElement)).toBeNull();
  },
};

/**
 * Between passes, gone quiet: the merge closed at 13:25:41 and no load has opened. The tail is the
 * campaign's own, and its quiet line names when the campaign was last heard from.
 */
export const QuietBetweenPasses: Story = {
  args: {
    campaign: (() => {
      const board = boardCampaign(NOW_STALLED);
      const self: RunLivenessInput = {
        kind: 'corpus_campaign',
        status: 'running',
        progressAt: at(13, 25, 41),
      };
      const liveness = campaignLiveness(self, [], NOW_STALLED);
      const passes = board.passes.map((p) =>
        p.pass === 'load' ? { ...p, state: 'waiting' as const, run: null } : p,
      );
      const merge = must(board.passes.find((p) => p.pass === 'merge')?.run);
      return {
        ...board,
        row: {
          ...board.row,
          liveness,
          livenessInputs: { self, passes: [] },
          line: { ...board.row.line, passesDone: 2, current: null },
        },
        passes,
        liveness,
        current: {
          runId: merge.id,
          pass: 'merge',
          counts: [],
          progressAt: merge.finishedAt,
          batches: null,
          failures: { stored: 0, total: 0, keys: [] },
        },
      };
    })(),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent(/Stalled/);
    const lines = [...canvasElement.querySelectorAll('[data-slot="log-line"]')];
    await expect(lines.at(-1)).toHaveTextContent(/no flush since 13:25:41/);
  },
};

/** A log that hit its cap: the cap row says how many weren't kept. A press on a pass switches the tail. */
export const CappedLog: Story = {
  args: { tail: cappedTail },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/1,204 more lines past the log's limit/),
    ).toBeVisible();
    await userEvent.click(must(canvasElement.querySelector<HTMLElement>('[data-pass="merge"]')));
    await waitFor(() =>
      expect(must(canvasElement.querySelector('[data-pass="merge"]'))).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    // The tail now names the merge, and draws it as finished (no Follow).
    await expect(slot(canvasElement, 'tail')).toHaveTextContent('merge');
    await expect(within(slot(canvasElement, 'tail')).queryByText('Follow')).toBeNull();
  },
};

/** A viewer who can't write (no capability): no bar, even stalled. */
export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-state')).toHaveTextContent('Stalled');
    await expect(bar(canvasElement)).toBeNull();
  },
};

/** A phone's 360 px: one pane, nothing wider than it. */
export const Narrow: Story = {
  args: { narrow: true },
  play: async ({ canvasElement }) => {
    const pane = slot(canvasElement, 'story-run-pane');
    await waitFor(() => expect(bar(canvasElement)).not.toBeNull());
    const scroll = slot(canvasElement, 'inbox-inspector-scroll');
    // The passes table scrolls in its own box; the page never does.
    const table = slot(canvasElement, 'passes-scroll');
    await expect(getComputedStyle(table).overflowX).toBe('auto');
    await expect({ scroll: scroll.scrollWidth, pane: pane.clientWidth }).toEqual({
      scroll: pane.clientWidth,
      pane: pane.clientWidth,
    });
  },
};

/** Both surfaces, both modes: the stalled board. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(slot(q, 'run-state')).toHaveTextContent('Stalled');
    }
  },
};
