import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { FAILED_READ } from '../../reads/readFailureFixtures';
import { LOWS_BOARD } from '../../season/sentinelLowsFixtures';
import {
  BOARD_FAILED,
  BOARD_ROWS,
  CROSSED_PAGE,
  FAILED_OOM,
  LANDED_VIEW,
  NOW,
  OOM_VIEW,
  PAUSED_PAGE,
  RUNNING_PAGE,
  WAITING_PAGE,
} from './imageryFixtures';

/**
 * **Machinery › Imagery's route and view together**: the real layout's sidebar, the real
 * `ImageryRoute` and `ImageryView`, with only the router, the role, the read layer, the writes and
 * the log's paginated read stood in. Every read is recorded by name with its arguments and answered
 * from `h.answers` in the contract's shapes (`machineryImagery`'s stubs).
 */

type Asked = { name: string; args: Record<string, unknown> };
const h = {
  search: {} as Record<string, unknown>,
  navigated: [] as { search: Record<string, unknown>; replace?: boolean }[],
  can: (_c: string) => true,
  asked: [] as Asked[],
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
};

vi.doMock('@tanstack/react-router', () => ({
  useSearch: () => h.search,
  useNavigate: () => (opts: { search: Record<string, unknown>; replace?: boolean }) => {
    h.navigated.push(opts);
  },
  Link: ({ children, to, ...p }: { children?: ReactNode; to?: string }) => (
    <a {...p} href={to}>
      {children}
    </a>
  ),
  Outlet: () => null,
}));
vi.doMock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => h.can(c) }) }));
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

const writes = {
  start: vi.fn(),
  pause: vi.fn(),
  pollNow: vi.fn(),
  retryFailed: vi.fn(),
  tryAgainNow: vi.fn(),
};
vi.doMock('./useImageryWrites', async (orig) => ({
  ...(await orig<typeof import('./useImageryWrites')>()),
  useLiveImageryWrites: () => writes,
}));
vi.doMock('./AttemptLog', async (orig) => ({
  ...(await orig<typeof import('./AttemptLog')>()),
  LiveAttemptLog: ({ attemptId, failed }: { attemptId: string; failed: boolean }) => (
    <div data-slot="live-log" data-attempt={attemptId} data-failed={failed ? '' : undefined} />
  ),
}));

// The lows' chart measures its face (`document.fonts`), which jsdom lacks: its stories check it.
vi.doMock('../../season/SentinelLows', () => ({
  SentinelLows: ({ state }: { state: { kind: string } }) => (
    <div data-slot="sentinel-lows" data-kind={state.kind} />
  ),
}));

const { ImageryRoute } = await import('./ImageryRoute');
const { MachinerySidebarProvider } = await import('../MachineryRoute');

const mount = () =>
  render(
    <MachinerySidebarProvider>
      <ImageryRoute />
    </MachinerySidebarProvider>,
    { wrapper: KeysProvider },
  );
const asked = (name: string) => h.asked.filter((a) => a.name === name);
const last = (name: string) => asked(name).at(-1)?.args;
const must = <T,>(x: T | null | undefined, what: string): T => {
  if (x == null) throw new Error(`missing: ${what}`);
  return x;
};
const slot = (name: string) =>
  must(document.querySelector<HTMLElement>(`[data-slot="${name}"]`), name);
const page = <R,>(rows: R[]) => ({ page: rows, isDone: true, continueCursor: '' });

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  for (const f of Object.values(writes)) f.mockReset().mockResolvedValue(true);
  h.search = {};
  h.navigated = [];
  h.can = () => true;
  h.asked = [];
  h.answers = {
    'machineryRuns:lanes': () => ({ corpus: { state: 'ok', at: 1 } }),
    'machineryImagery:page': () => RUNNING_PAGE,
    'machineryImagery:failedFirst': () => BOARD_FAILED,
    'machineryImagery:granules': () => page(BOARD_ROWS),
    'machineryImagery:granule': () => OOM_VIEW,
    'sentinelLows:forSeason': () => LOWS_BOARD,
  };
});

describe('the page', () => {
  it('reads the page on the minute, the failed first, and the list 25 a page under All', () => {
    mount();
    expect(last('machineryImagery:page')).toEqual({ now: expect.any(Number) });
    expect(last('machineryImagery:failedFirst')).toEqual({});
    expect(last('machineryImagery:granules')).toMatchObject({
      filter: 'all',
      paginationOpts: { numItems: 25, cursor: null },
    });
    const list = screen.getByRole('listbox', { name: 'Granules' });
    expect(within(list).getAllByRole('option')).toHaveLength(
      BOARD_FAILED.length + BOARD_ROWS.length,
    );
    expect(slot('granule-divider')).toHaveTextContent('Everything else · newest first');
    // Nothing waiting, no lows asked.
    expect(asked('sentinelLows:forSeason')).toHaveLength(0);
  });

  it('draws a failed granule once, first, even when the page below lists it too', () => {
    h.answers['machineryImagery:granules'] = () => page([FAILED_OOM, ...BOARD_ROWS]);
    mount();
    const list = screen.getByRole('listbox', { name: 'Granules' });
    expect(within(list).getAllByRole('option')).toHaveLength(1 + BOARD_ROWS.length);
  });

  it('a filter reads that filter alone, with no failed-first read', () => {
    mount();
    h.asked = [];
    fireEvent.click(must(document.querySelector<HTMLElement>('[data-filter="cutting"]'), 'f'));
    expect(last('machineryImagery:granules')).toMatchObject({ filter: 'cutting' });
    expect(asked('machineryImagery:failedFirst')).toHaveLength(0);
  });

  it('the Imagery lane joins the sidebar, its tail from the page read', () => {
    // On the fixtures' clock: the pump's tick is under way, so the worst of the three is running.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    try {
      mount();
      const nav = screen.getByRole('navigation', { name: 'Machinery' });
      const lane = within(nav).getByRole('link', { name: /^Imagery/ });
      expect(lane).toHaveAttribute('href', '/admin/machinery/imagery');
      expect(lane).toHaveTextContent('Convex');
      expect(lane).toHaveTextContent('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no season, says so; a failed page, in its own place', () => {
    h.answers['machineryImagery:page'] = () => null;
    const { unmount } = mount();
    expect(slot('imagery-none')).toHaveTextContent('No imagery season yet');
    unmount();
    h.answers['machineryImagery:page'] = () => FAILED_READ;
    mount();
    expect(slot('imagery-error')).toHaveTextContent('The imagery page didn’t load.');
  });

  it('a viewer without machinery.read reads nothing', () => {
    h.can = () => false;
    mount();
    expect(h.asked).toEqual([]);
  });
});

describe('the open granule', () => {
  it('reads the granule the URL names, and its newest attempt’s log, open', () => {
    h.search = { granule: FAILED_OOM.id };
    mount();
    expect(last('machineryImagery:granule')).toEqual({ id: FAILED_OOM.id });
    const log = slot('live-log');
    expect(log.dataset.attempt).toBe(OOM_VIEW.attempts[1]?.id);
    expect(log).toHaveAttribute('data-failed');
  });

  it('opens the attempt the URL names', () => {
    h.search = { granule: FAILED_OOM.id, attempt: 1 };
    mount();
    expect(slot('live-log').dataset.attempt).toBe(OOM_VIEW.attempts[0]?.id);
  });

  it('a press on a row is a navigation to it; on an attempt, to it in place', () => {
    h.search = { granule: FAILED_OOM.id };
    mount();
    fireEvent.click(must(screen.getAllByRole('option')[1], 'row'));
    expect(h.navigated.at(-1)).toEqual({
      to: '/admin/machinery/imagery',
      search: { granule: BOARD_ROWS[0]?.id },
      replace: true,
    });
    fireEvent.click(must(document.querySelectorAll('[data-slot="attempt-row"]')[0], 'attempt'));
    expect(h.navigated.at(-1)).toEqual({
      to: '/admin/machinery/imagery',
      search: { granule: FAILED_OOM.id, attempt: 1 },
      replace: true,
    });
  });

  it('a landed granule’s log is collapsed until asked', () => {
    h.search = { granule: LANDED_VIEW.row.id };
    h.answers['machineryImagery:granule'] = () => LANDED_VIEW;
    mount();
    expect(document.querySelector('[data-slot="live-log"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show the log/ }));
    expect(slot('live-log')).not.toHaveAttribute('data-failed');
  });

  it('a granule that is gone says so', () => {
    h.search = { granule: FAILED_OOM.id };
    h.answers['machineryImagery:granule'] = () => null;
    mount();
    expect(slot('granule-missing')).toHaveTextContent('isn’t here');
  });
});

describe('the writes', () => {
  it('Retry failed and Pause send the season', async () => {
    mount();
    const bar = screen.getByRole('toolbar', { name: 'This season' });
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: /Retry failed/ }));
    });
    expect(writes.retryFailed).toHaveBeenCalledWith('winter-2026-27');
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: /Pause/ }));
    });
    expect(writes.pause).toHaveBeenCalledWith('winter-2026-27');
  });

  it('Resume while paused starts the season again, worded as a resume', async () => {
    h.answers['machineryImagery:page'] = () => PAUSED_PAGE;
    mount();
    const bar = screen.getByRole('toolbar', { name: 'This season' });
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: /Resume/ }));
    });
    expect(writes.start).toHaveBeenCalledWith('winter-2026-27', true);
  });

  it('a viewer without machinery.imagery gets no bar', () => {
    h.can = (c) => c !== 'machinery.imagery';
    mount();
    expect(screen.queryByRole('toolbar', { name: 'This season' })).toBeNull();
  });

  it('the runs drawer opens from the URL, and a card’s Runs navigates to its tab', () => {
    mount();
    const runs = must(
      within(slot('imagery-head')).getAllByRole('button', { name: 'Runs' })[1],
      'runs',
    );
    fireEvent.click(runs);
    expect(h.navigated.at(-1)?.search).toEqual({ runs: 'pump' });
  });
});

describe('the waiting page', () => {
  it('reads the season’s lows (its start year, at the day’s start), and no granules', () => {
    h.answers['machineryImagery:page'] = () => WAITING_PAGE;
    mount();
    expect(last('sentinelLows:forSeason')).toEqual({ season: 2026, now: expect.any(Number) });
    expect(asked('machineryImagery:granules')).toHaveLength(0);
    expect(asked('machineryImagery:failedFirst')).toHaveLength(0);
    expect(slot('sentinel-table')).toHaveTextContent('Upper Lake of the Clouds');
    expect(slot('sentinel-lows').dataset.kind).toBe('value');
  });

  it('Start imagery sends the season', async () => {
    h.answers['machineryImagery:page'] = () => CROSSED_PAGE;
    mount();
    const panel = slot('start-panel');
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: /Start imagery/ }));
    });
    expect(writes.start).toHaveBeenCalledWith('winter-2026-27');
  });

  it('a viewer without the lows’ capability asks nothing of them', () => {
    h.answers['machineryImagery:page'] = () => WAITING_PAGE;
    h.can = (c) => c !== 'season.summary';
    mount();
    expect(asked('sentinelLows:forSeason')).toHaveLength(0);
  });
});
