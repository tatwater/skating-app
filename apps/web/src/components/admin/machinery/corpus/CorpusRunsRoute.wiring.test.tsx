import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { FAILED_READ } from '../../reads/readFailureFixtures';
import { assembledCampaign, boardCampaign, finishedPassDoc, loadView } from './runFixtures';
import {
  BOARD_ROWS,
  liveRow,
  NOW,
  REBUILT_FAILED,
  runId,
  runPage,
  STALLED_CAMPAIGN,
} from './runListFixtures';

/**
 * **Machinery › Corpus's route and view together**: the real layout's sidebar, the real
 * `CorpusRunsRoute` and `CorpusRunsView`, with only the router, the role and the read layer stood
 * in. Every read is recorded by name with its arguments and answered from `h.answers`.
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

// The live pages' two Convex hooks stood in: the writes (recorded) and the tail's paginated read.
const writes = { markFailed: vi.fn(), wait: vi.fn(), stop: vi.fn() };
vi.doMock('../actions/useRunWrites', async (orig) => ({
  ...(await orig<typeof import('../actions/useRunWrites')>()),
  useLiveRunWrites: () => writes,
}));
vi.doMock('./RunTail', async (orig) => ({
  ...(await orig<typeof import('./RunTail')>()),
  LiveRunTail: ({ runId: id }: { runId: string }) => <div data-slot="live-tail" data-run={id} />,
}));

const { CorpusRunsRoute } = await import('./CorpusRunsRoute');
const { MachinerySidebarProvider } = await import('../MachineryRoute');

const mount = () =>
  render(
    <MachinerySidebarProvider>
      <CorpusRunsRoute />
    </MachinerySidebarProvider>,
    { wrapper: KeysProvider },
  );
const asked = (name: string) => h.asked.filter((a) => a.name === name);
const last = (name: string) => asked(name).at(-1)?.args;
const must = <T,>(x: T | null | undefined, what: string): T => {
  if (x == null) throw new Error(`missing: ${what}`);
  return x;
};
const detail = () => must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'detail');
const PASS = BOARD_ROWS[1] as (typeof BOARD_ROWS)[number];
const slotIn = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`), name);
/** The stalled campaign's page, as the server answers it. */
const STALLED_PAGE = { ...boardCampaign(NOW), row: STALLED_CAMPAIGN };
/** A pass's run page, as the server answers it. */
const passPage = (label: string, parent: { id: string; title: string } | null = null) => ({
  ...loadView(NOW, { doc: { ...finishedPassDoc(), _id: PASS.id, label } }),
  parent,
});

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  for (const f of Object.values(writes)) f.mockReset().mockResolvedValue(true);
  h.search = {};
  h.navigated = [];
  h.can = () => true;
  h.asked = [];
  h.answers = {
    'machineryRuns:lanes': () => ({ corpus: { state: 'stalled', at: 1 } }),
    'machineryRuns:listPage': () => runPage(BOARD_ROWS),
  };
});

describe('the list', () => {
  it('reads the corpus lane 25 a page on the minute, and draws every row with its months', () => {
    mount();
    expect(last('machineryRuns:listPage')).toMatchObject({
      lane: 'corpus',
      paginationOpts: { numItems: 25, cursor: null },
      now: expect.any(Number),
    });
    expect(screen.getAllByRole('option')).toHaveLength(BOARD_ROWS.length);
    expect(document.querySelectorAll('[data-slot="run-list-month"]')).toHaveLength(4);
    expect(document.querySelector('[data-slot="run-list-end"]')).toHaveTextContent('All 10');
    expect(document.querySelector('[data-slot="run-list-not-indexed"]')).toBeNull();
  });

  it('says older runs are on their way before the history is indexed — never an empty history', () => {
    h.answers['machineryRuns:listPage'] = () => runPage([], { indexed: false });
    mount();
    expect(document.querySelector('[data-slot="run-list-not-indexed"]')).toHaveTextContent(
      'Older runs appear once they’re indexed.',
    );
    expect(document.querySelector('[data-slot="run-list-end"]')).toHaveTextContent(
      'None listed yet',
    );
  });

  it('counts a short list before indexing as listed so far, not All', () => {
    h.answers['machineryRuns:listPage'] = () => runPage([STALLED_CAMPAIGN], { indexed: false });
    mount();
    expect(document.querySelector('[data-slot="run-list-end"]')).toHaveTextContent(
      '1 listed so far',
    );
  });

  it('with the history indexed and nothing in it, says so', () => {
    h.answers['machineryRuns:listPage'] = () => runPage([]);
    mount();
    expect(document.querySelector('[data-slot="run-list-end"]')).toHaveTextContent('No runs yet');
  });

  it('says a failed list in its own place, with Try again', () => {
    h.answers['machineryRuns:listPage'] = () => FAILED_READ;
    mount();
    expect(screen.getByText('The runs didn’t load.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the list on the second', () => {
  it("re-reads a running row by core's rule as the clock moves, with no new answer", () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const start = Date.now();
      const row = {
        ...liveRow('running', 40),
        livenessInputs: {
          self: { kind: 'corpus_campaign', status: 'running' as const },
          passes: [{ kind: 'canonical_water', status: 'running' as const, progressAt: start }],
        },
      };
      h.answers['machineryRuns:listPage'] = () => runPage([row]);
      mount();
      const chip = () => slotIn(screen.getAllByRole('option')[0] as HTMLElement, 'run-row-state');
      expect(chip()).toHaveTextContent('running');
      // Past twice the load's pace: late, on the second — the answer hasn't changed.
      act(() => {
        vi.advanceTimersByTime(7 * 60_000);
      });
      expect(chip()).toHaveTextContent('late');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('opening a run', () => {
  it('opens a campaign and a pass each by its own run id', () => {
    mount();
    fireEvent.click(must(screen.getAllByRole('option')[0], 'the campaign'));
    expect(h.navigated.at(-1)).toMatchObject({ search: { run: STALLED_CAMPAIGN.id } });
    expect(h.navigated.at(-1)?.search).not.toHaveProperty('campaign');
    expect(h.navigated.at(-1)?.replace).toBeUndefined();
    fireEvent.click(must(screen.getAllByRole('option')[1], 'a pass'));
    expect(h.navigated.at(-1)).toMatchObject({ search: { run: PASS.id } });
  });

  it('replaces the entry when a run is already open, and closes to nothing', () => {
    h.search = { run: PASS.id };
    mount();
    fireEvent.click(must(screen.getAllByRole('option')[0], 'the campaign'));
    expect(h.navigated.at(-1)).toEqual({
      to: '/admin/machinery/corpus',
      search: { run: STALLED_CAMPAIGN.id },
      replace: true,
    });
  });

  it('opens an older campaign run again under the same id as itself, never the newest', () => {
    const older = { ...STALLED_CAMPAIGN, id: runId(77), status: 'failed' as const };
    h.answers['machineryRuns:listPage'] = () => runPage([STALLED_CAMPAIGN, older]);
    h.answers['machineryRuns:campaign'] = (args) => ({
      ...STALLED_PAGE,
      row: args.runId === older.id ? older : STALLED_CAMPAIGN,
    });
    mount();
    fireEvent.click(must(screen.getAllByRole('option')[1], 'the older campaign'));
    expect(h.navigated.at(-1)).toMatchObject({ search: { run: older.id } });
    h.search = { run: older.id };
    h.asked = [];
    mount();
    expect(last('machineryRuns:campaign')).toEqual({ runId: older.id, now: expect.any(Number) });
  });

  it('reads ?campaign= by its id, and marks its row open', () => {
    h.search = { campaign: 'a07a-20261012' };
    h.answers['machineryRuns:campaign'] = () => STALLED_PAGE;
    mount();
    expect(last('machineryRuns:campaign')).toEqual({
      campaignId: 'a07a-20261012',
      now: expect.any(Number),
    });
    expect(asked('machineryRuns:run')).toHaveLength(0);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(slotIn(detail(), 'run-title')).toHaveTextContent('a07a-20261012');
  });

  it('reads ?run= on a pass as that run, and draws its name', () => {
    h.search = { run: PASS.id };
    h.answers['machineryRuns:run'] = () => passPage('Load names');
    mount();
    expect(last('machineryRuns:run')).toEqual({ runId: PASS.id, now: expect.any(Number) });
    expect(asked('machineryRuns:campaign')).toHaveLength(0);
    expect(slotIn(detail(), 'run-title')).toHaveTextContent('Load names');
    // Its tail is the live one, reading this run's log.
    expect(slotIn(detail(), 'live-tail')).toHaveAttribute('data-run', PASS.id);
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('reads ?run= on a campaign row as the campaign page, by its id', () => {
    h.search = { run: STALLED_CAMPAIGN.id };
    h.answers['machineryRuns:campaign'] = () => STALLED_PAGE;
    mount();
    expect(asked('machineryRuns:run')).toHaveLength(0);
    expect(last('machineryRuns:campaign')).toEqual({
      runId: STALLED_CAMPAIGN.id,
      now: expect.any(Number),
    });
  });

  it('turns a ?run= the list doesn’t hold into the campaign page when the run is one', () => {
    const away = runId(99);
    h.search = { run: away };
    h.answers['machineryRuns:run'] = () => ({ doc: { kind: 'corpus_campaign', label: 'x' } });
    h.answers['machineryRuns:campaign'] = () => ({ ...assembledCampaign(), row: REBUILT_FAILED });
    mount();
    expect(last('machineryRuns:campaign')).toEqual({ runId: away, now: expect.any(Number) });
    expect(slotIn(detail(), 'run-title')).toHaveTextContent('a07a-20260809');
    // A campaign rebuilt from its runs has always ended: no action on it.
    expect(detail().querySelector('[data-slot="run-actions"]')).toBeNull();
  });

  it('marks a pass’s campaign row open when the pass is under it', () => {
    const away = runId(98);
    h.search = { run: away, campaign: 'a07a-20261012' };
    h.answers['machineryRuns:run'] = () =>
      passPage('Load', { id: STALLED_CAMPAIGN.id, title: 'a07a-20261012' });
    mount();
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    // Its head links back to its campaign, by the campaign row's id.
    expect(within(detail()).getByRole('link', { name: /a07a-20261012/ })).toHaveAttribute(
      'href',
      '/admin/machinery/corpus',
    );
  });

  it.each([
    ['on its way', () => undefined, '[data-slot="run-detail-loading"]'],
    ['not there', () => null, '[data-slot="run-detail-missing"]'],
    ['failed', () => FAILED_READ, '[data-slot="run-detail-error"]'],
  ])('says a run read %s', (_what, answer, slot) => {
    h.search = { run: PASS.id };
    h.answers['machineryRuns:run'] = answer;
    mount();
    expect(detail().querySelector(slot)).not.toBeNull();
  });

  it('with nothing open, says so', () => {
    mount();
    expect(detail().querySelector('[data-slot="run-detail-none"]')).toHaveTextContent(
      'No run open',
    );
  });
});

describe('the run pages, mounted', () => {
  it('gives a viewer with machinery.corpus the action bar, wired to the live writes', () => {
    h.search = { campaign: 'a07a-20261012' };
    h.answers['machineryRuns:campaign'] = () => STALLED_PAGE;
    mount();
    expect(detail().querySelector('[data-slot="run-actions"]')).not.toBeNull();
    fireEvent.click(
      within(detail()).getAllByRole('button', { name: /Wait 30 minutes/ })[0] as HTMLElement,
    );
    expect(writes.wait).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.any(String) }),
    );
  });

  it('draws no action bar for a viewer without machinery.corpus', () => {
    h.can = (c) => c !== 'machinery.corpus';
    h.search = { campaign: 'a07a-20261012' };
    h.answers['machineryRuns:campaign'] = () => STALLED_PAGE;
    mount();
    expect(slotIn(detail(), 'campaign-view')).toBeInTheDocument();
    expect(detail().querySelector('[data-slot="run-actions"]')).toBeNull();
  });

  it('draws the page in the column, never a stand-in head', () => {
    h.search = { campaign: 'a07a-20261012' };
    h.answers['machineryRuns:campaign'] = () => STALLED_PAGE;
    mount();
    expect(detail().querySelector('[data-slot="run-detail-head"]')).toBeNull();
    expect(slotIn(detail(), 'campaign-view')).toHaveAttribute('data-state', 'stalled');
  });
});

describe('the sidebar and the gate', () => {
  it('draws Corpus alone under Pipelines, with its tail, linked to its page', () => {
    mount();
    const nav = screen.getByRole('navigation', { name: 'Machinery' });
    const lanes = within(nav).getAllByRole('link');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toHaveAttribute('href', '/admin/machinery/corpus');
    expect(lanes[0]).toHaveTextContent('Corpus');
    expect(lanes[0]).toHaveTextContent('Local');
    expect(lanes[0]).toHaveTextContent('stalled');
    expect(nav).not.toHaveTextContent(/Health|Cost ledger|\$/);
  });

  it('says the sidebar’s read failed at its foot, and draws no tail', () => {
    h.answers['machineryRuns:lanes'] = () => FAILED_READ;
    mount();
    expect(screen.getByText('The pipelines’ state couldn’t be read')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Machinery' })).not.toHaveTextContent('stalled');
  });

  it('asks nothing for a viewer without machinery.read', () => {
    h.can = (c) => c !== 'machinery.read';
    h.search = { campaign: 'a07a-20261012' };
    mount();
    expect(h.asked.filter((a) => a.name.startsWith('machineryRuns:'))).toEqual([]);
  });
});
