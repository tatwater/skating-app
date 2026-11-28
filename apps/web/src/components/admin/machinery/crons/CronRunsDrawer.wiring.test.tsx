import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { failedRead } from '../../reads/readFailureFixtures';
import {
  FLUSH,
  FLUSH_JOB,
  flushRuns,
  IMAGERY_JOBS,
  INDEX,
  NOW,
  POLL,
  PUMP,
  pumpRuns,
  pumpTicks,
  runLines,
} from './cronFixtures';
import type { CronRunView } from './cronViews';

/**
 * **The runs drawer wired to the crons' reads**: the real drawer and view, with only the read layer
 * and the toast queue stood in. Every read is recorded by name with its arguments and answered from
 * `h.answers` in the shape `machineryCrons` returns.
 */

type Asked = { name: string; args: Record<string, unknown> };
const h = {
  asked: [] as Asked[],
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
};
const toasts = vi.fn();

vi.doMock('@/components/admin/reads/consoleReads', async (orig) => {
  const actual = await orig<typeof import('@/components/admin/reads/consoleReads')>();
  return {
    ...actual,
    useConsoleReadSet: (specs: Record<string, { query: never; args: never } | null>) => {
      const reads: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(specs)) {
        if (spec === null) continue;
        const name = getFunctionName(spec.query);
        h.asked.push({ name, args: spec.args });
        reads[k] = h.answers[name]?.(spec.args);
      }
      return { reads, retry: () => {}, live: true, failed: false, pending: false };
    },
  };
});
vi.doMock('@/components/kit/toast', async (orig) => ({
  ...(await orig<typeof import('@/components/kit/toast')>()),
  toast: (o: unknown) => toasts(o),
}));

const { CronRunsDrawer } = await import('./CronRunsDrawer');

const page = <T,>(rows: T[], isDone = true) => ({ page: rows, isDone, continueCursor: 'c1' });
const asked = (name: string) => h.asked.filter((a) => a.name === name);
const last = (name: string) => asked(name).at(-1)?.args;
const TABS = [POLL, PUMP, INDEX];

beforeAll(stubJsdomAnimations);
// The boards' clock: the fixtures' crons are on time at it (only the date is pinned; timers run).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  h.asked = [];
  toasts.mockReset();
  h.answers = {
    'machineryCrons:jobs': (args) =>
      IMAGERY_JOBS.filter((j) => (args.names as string[]).includes(j.job)),
    'machineryCrons:strip': () => ({ ticks: pumpTicks(), truncated: false }),
    'machineryCrons:runsPage': (args) =>
      page(pumpRuns().filter((r) => (args.filter === 'failed' ? r.outcome === 'failed' : true))),
    'machineryCrons:runLog': (args) => {
      const run = pumpRuns().find((r) => r.id === args.runId) as CronRunView;
      return page([...runLines(run)].reverse());
    },
  };
});

describe('closed', () => {
  it('reads nothing', () => {
    render(<CronRunsDrawer job={PUMP} open={false} onClose={() => {}} tabs={TABS} />);
    expect(h.asked).toEqual([]);
  });
});

describe('open', () => {
  it('reads the tabs’ crons on the minute, the strip to the minute, and 25 runs from the start', () => {
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} pipeline="Imagery" />);
    const jobs = last('machineryCrons:jobs') as { names: string[]; now: number };
    expect(jobs.names).toEqual(TABS);
    expect(jobs.now % 60_000).toBe(0);
    const strip = last('machineryCrons:strip') as { job: string; from: number; to: number };
    expect(strip.job).toBe(PUMP);
    expect(strip.to).toBe(jobs.now);
    // The pump ticks every 3 minutes: its last 12 hours.
    expect(strip.to - strip.from).toBe(12 * 3_600_000);
    expect(last('machineryCrons:runsPage')).toEqual({
      job: PUMP,
      filter: 'all',
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(screen.getByText('Imagery runs')).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="cron-tab"]')).toHaveLength(3);
  });

  it('opens a failed run’s log by itself and reads it 200 lines a page, drawn oldest first', () => {
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    const logs = asked('machineryCrons:runLog').map((a) => a.args);
    const failed = pumpRuns().filter((r) => r.outcome === 'failed' || r.outcome === 'killed');
    expect(new Set(logs.map((a) => a.runId))).toEqual(new Set(failed.map((r) => r.id)));
    for (const a of logs) expect(a.paginationOpts).toEqual({ numItems: 200, cursor: null });
    const killedLog = document.querySelectorAll('[data-slot="cron-run-log"]')[0] as HTMLElement;
    const text = killedLog.textContent ?? '';
    expect(text.indexOf('lease taken')).toBeLessThan(text.indexOf('never finished'));
  });

  it('reads Failed by its own index, and Did something as every run, unfolded', () => {
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    expect(document.querySelectorAll('[data-slot="cron-quiet"]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(last('machineryCrons:runsPage')?.filter).toBe('failed');
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="cron-run"]')].map(
        (r) => r.dataset.outcome,
      ),
    ).toEqual(['failed']);
    fireEvent.click(screen.getByRole('button', { name: 'Did something' }));
    expect(last('machineryCrons:runsPage')?.filter).toBe('all');
    expect(document.querySelectorAll('[data-slot="cron-quiet"]')).toHaveLength(0);
  });

  it('switches tabs through the page when it keeps the URL, in place otherwise', () => {
    const onJobChange = vi.fn();
    const { unmount } = render(
      <CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} onJobChange={onJobChange} />,
    );
    const tabs = document.querySelectorAll<HTMLElement>('[data-slot="cron-tab"]');
    fireEvent.click(tabs[0] as HTMLElement);
    expect(onJobChange).toHaveBeenCalledWith(POLL);
    unmount();
    h.asked = [];
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    fireEvent.click(
      document.querySelectorAll<HTMLElement>('[data-slot="cron-tab"]')[0] as HTMLElement,
    );
    expect(last('machineryCrons:runsPage')?.job).toBe(POLL);
    expect(last('machineryCrons:strip')?.job).toBe(POLL);
  });

  it('takes the page’s strip range, columns, headlines and foot', () => {
    const from = 1_000;
    render(
      <CronRunsDrawer
        job={POLL}
        open
        onClose={() => {}}
        tabs={TABS}
        stripRangeOf={() => ({ from, label: 'Since the start' })}
        columnsOf={() => [{ key: 'checked', label: 'Checked' }]}
        headlineOf={() => 'page words'}
        jobHeadlineOf={() => 'tab words'}
        labelOf={(j) => (j === POLL ? 'Poll' : j)}
        footOf={(j) => (j === POLL ? <button type="button">Run now</button> : null)}
      />,
    );
    expect(last('machineryCrons:strip')?.from).toBe(from);
    expect(screen.getByText('Since the start')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Checked' })).toBeTruthy();
    expect(screen.getAllByText('page words').length).toBeGreaterThan(0);
    const subs = [...document.querySelectorAll('[data-slot="cron-tab"] small')].map(
      (e) => e.textContent,
    );
    expect(subs.filter((t) => t?.includes('tab words'))).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy();
    expect(
      within(document.querySelector('[data-slot="cron-tabs"]') as HTMLElement).getByText('Poll'),
    ).toBeTruthy();
  });

  it('draws no duration a mutation job never measured', () => {
    h.answers['machineryCrons:jobs'] = () => [FLUSH_JOB];
    h.answers['machineryCrons:runsPage'] = () => page(flushRuns());
    h.answers['machineryCrons:runLog'] = () => page([]);
    render(<CronRunsDrawer job={FLUSH} open onClose={() => {}} />);
    expect(screen.queryByRole('columnheader', { name: 'Took' })).toBeNull();
    expect(document.body.textContent).not.toContain('0 ms');
  });

  it('draws a slow cron’s last 30 days by default', () => {
    render(<CronRunsDrawer job={POLL} open onClose={() => {}} />);
    const strip = last('machineryCrons:strip') as { from: number; to: number };
    expect(strip.to - strip.from).toBe(30 * 24 * 3_600_000);
  });
});

describe('a read that fails', () => {
  it('says so in a toast with Try again, once, never inline', () => {
    const retry = vi.fn();
    h.answers['machineryCrons:runsPage'] = () => failedRead(retry);
    const { rerender } = render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    rerender(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    expect(toasts).toHaveBeenCalledTimes(1);
    const t = toasts.mock.calls[0]?.[0] as {
      title: string;
      tone: string;
      action: { label: string; onAction: () => void };
    };
    expect(t.title).toBe('The runs didn’t load.');
    expect(t.tone).toBe('bad');
    act(() => t.action.onAction());
    expect(retry).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('didn’t load');
  });

  it('toasts a failed strip read', () => {
    h.answers['machineryCrons:strip'] = () => failedRead();
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    const titles = toasts.mock.calls.map((c) => (c[0] as { title: string }).title);
    expect(titles).toEqual(['The ticks didn’t load.']);
  });

  it('toasts a failed tabs read', () => {
    h.answers['machineryCrons:jobs'] = () => failedRead();
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    const titles = toasts.mock.calls.map((c) => (c[0] as { title: string }).title);
    expect(titles).toEqual(['The crons didn’t load.']);
  });

  it('toasts a failed log read', () => {
    h.answers['machineryCrons:runLog'] = () => failedRead();
    render(<CronRunsDrawer job={PUMP} open onClose={() => {}} tabs={TABS} />);
    const titles = toasts.mock.calls.map((c) => (c[0] as { title: string }).title);
    expect(titles).toEqual(['That log didn’t load.', 'That log didn’t load.']);
  });
});
