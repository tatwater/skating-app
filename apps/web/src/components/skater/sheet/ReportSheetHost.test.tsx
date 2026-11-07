import type { PostDraft, PostSheet } from '@skating/core';
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindSheetOwner,
  getSheetAttempt,
  setSheet,
  setSheetAttempt,
  updateSheet,
  useSheet,
} from '@/lib/sheetStore';
import { installFakeStore, openSheet, reloadPage, stubObjectUrls } from '@/lib/sheetStore.fixtures';
import { skaterRootSearchSchema } from '@/lib/skaterSearch';
import { ReportSheetHost } from './ReportSheetHost';
import { ABANDON_KEY, reportSheetLinkState } from './sheetHostModel';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));

const h = vi.hoisted(() => ({
  capture: vi.fn(),
  openWebDoor: vi.fn(),
  postSheetOnWeb: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({ useAnalytics: () => ({ capture: h.capture }) }));
vi.mock('convex/react', () => ({
  useConvex: () => ({}),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => ({ showPutInDefault: true }),
}));
vi.mock('@/lib/sheetDoors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sheetDoors')>()),
  openWebDoor: (...args: unknown[]) => h.openWebDoor(...args),
}));
vi.mock('@/lib/sheetActions', () => ({
  postSheetOnWeb: (...args: unknown[]) => h.postSheetOnWeb(...args),
}));
// The sheet's own content is ReportSheet's tests'; here a stub holds the exits the host hands it.
vi.mock('./ReportSheet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ReportSheet')>();
  return {
    LeaveDialog: actual.LeaveDialog,
    ReportSheet: ({
      post,
      exits,
    }: {
      post: PostSheet;
      exits: { onClose: () => void; onDiscard: () => void; onDone: (id: string) => void };
    }) => (
      <div data-testid="sheet" data-draft={post.draftId} data-mode={post.mode.kind}>
        <button type="button" onClick={exits.onClose}>
          Close
        </button>
        <button type="button" onClick={exits.onDiscard}>
          Discard
        </button>
        <button type="button" onClick={() => exits.onDone('rep-9')}>
          Done
        </button>
      </div>
    ),
  };
});

function browserAt(url: string) {
  window.history.replaceState(null, '', url);
  return createBrowserHistory();
}

function renderAt(url: string, kind: 'memory' | 'browser' = 'memory') {
  const root = createRootRoute({
    validateSearch: skaterRootSearchSchema,
    component: () => (
      <>
        <Outlet />
        <ReportSheetHost />
      </>
    ),
  });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{text}</p> });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/', 'Explore'),
      page('/latest', 'Latest'),
      page('/report/$id', 'The report'),
    ]),
    history: kind === 'memory' ? createMemoryHistory({ initialEntries: [url] }) : browserAt(url),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const search = (router: ReturnType<typeof renderAt>) =>
  router.state.location.search as Record<string, unknown>;
const opened = () => h.capture.mock.calls.filter((c) => c[0] === 'report_sheet_opened');

function freshSheet(waterBodyId?: string): PostSheet {
  const sheet = openSheet();
  return waterBodyId === undefined
    ? sheet
    : {
        ...sheet,
        reports: sheet.reports.map((r) => ({ ...r, sheet: { ...r.sheet, waterBodyId } })),
      };
}

let live: Set<string>;
beforeEach(() => {
  window.localStorage.clear();
  live = stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
  h.capture.mockReset();
  h.openWebDoor.mockReset();
  h.postSheetOnWeb.mockReset();
  h.openWebDoor.mockImplementation(async () => freshSheet());
});
afterEach(() => {
  setSheet(null);
  void live;
});

describe('opening', () => {
  it('draws nothing without the param', async () => {
    renderAt('/');
    expect(await screen.findByText('Explore')).toBeInTheDocument();
    expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
    expect(h.openWebDoor).not.toHaveBeenCalled();
  });

  it('opens over the page from a landing with a lake, and counts it as the lake’s', async () => {
    renderAt('/?post=new&postBody=b1');
    expect(await screen.findByTestId('sheet')).toBeInTheDocument();
    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(h.openWebDoor.mock.calls[0]?.[1]).toEqual({ body: 'b1' });
    expect(opened()).toEqual([['report_sheet_opened', { entry: 'water_body' }]]);
  });

  it('leaves an in-app new sheet to the door that recorded it, and counts an edit', async () => {
    h.openWebDoor.mockImplementation(async (_c, params: { edit?: string }) =>
      params.edit
        ? { ...freshSheet('b1'), mode: { kind: 'edit', reportId: params.edit } }
        : freshSheet(),
    );
    const router = renderAt('/');
    await screen.findByText('Explore');
    await act(() => router.navigate({ to: '/', search: { post: 'new' } } as never));
    expect(await screen.findByTestId('sheet')).toBeInTheDocument();
    expect(opened()).toEqual([]);
    await act(() => router.navigate({ to: '/', search: {} } as never));
    setSheet(null);
    await act(() => router.navigate({ to: '/', search: { post: 'r1' } } as never));
    await waitFor(() => expect(screen.getByTestId('sheet')).toHaveAttribute('data-mode', 'edit'));
    expect(opened()).toEqual([['report_sheet_opened', { entry: 'edit' }]]);
  });

  it('counts a bare landing as a deep link', async () => {
    renderAt('/?post=new');
    expect(await screen.findByTestId('sheet')).toBeInTheDocument();
    expect(opened()).toEqual([['report_sheet_opened', { entry: 'deep_link' }]]);
  });

  it('records nothing for a new sheet a door already recorded', async () => {
    const router = renderAt('/');
    await screen.findByText('Explore');
    await act(() =>
      router.navigate({
        to: '/',
        search: { post: 'new', postBody: 'b1' },
        state: reportSheetLinkState(),
      } as never),
    );
    await screen.findByTestId('sheet');
    expect(opened()).toEqual([]);
  });

  it('records nothing for an edit a door already recorded', async () => {
    const router = renderAt('/');
    await screen.findByText('Explore');
    await act(() =>
      router.navigate({ to: '/', search: { post: 'r1' }, state: reportSheetLinkState() } as never),
    );
    await screen.findByTestId('sheet');
    expect(opened()).toEqual([]);
  });

  it('says so when the edit door names a report that is not the viewer’s', async () => {
    h.openWebDoor.mockImplementation(async () => null);
    renderAt('/?post=gone');
    expect(await screen.findByRole('alert')).toHaveTextContent("isn't yours to edit");
  });

  it('keeps the sheet already open for the door rather than rebuilding it', async () => {
    const kept = { ...freshSheet(), title: 'Mine', dirty: true };
    setSheet(kept);
    renderAt('/?post=new');
    expect(await screen.findByTestId('sheet')).toHaveAttribute('data-draft', kept.draftId);
    expect(h.openWebDoor).not.toHaveBeenCalled();
  });
});

describe('closing', () => {
  it('removes the params and keeps the draft (Close)', async () => {
    const router = renderAt('/latest?post=new');
    const sheet = await screen.findByTestId('sheet');
    const draftId = sheet.getAttribute('data-draft');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(search(router).post).toBeUndefined());
    expect(router.state.location.pathname).toBe('/latest');
    expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
    let held: PostSheet | null = null;
    function Probe() {
      held = useSheet();
      return null;
    }
    render(<Probe />);
    expect(held).toMatchObject({ draftId });
  });

  it('Escape closes the sheet', async () => {
    const router = renderAt('/?post=new');
    await screen.findByTestId('sheet');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(search(router).post).toBeUndefined());
  });

  it('a discard throws the draft away and counts the abandonment', async () => {
    const router = renderAt('/?post=new');
    await screen.findByTestId('sheet');
    act(() => updateSheet((p) => ({ ...p, title: 'Half', dirty: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(search(router).post).toBeUndefined());
    expect(h.capture).toHaveBeenCalledWith('report_sheet_abandoned', { sections_answered: 0 });
    expect(window.localStorage.getItem('skating.reportSheet.v2')).toBeNull();
  });

  it('goes to the published report when the sheet is done', async () => {
    const router = renderAt('/?post=new');
    await screen.findByTestId('sheet');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/report/rep-9'));
  });
});

describe('the leave guard (5.31)', () => {
  // The browser's own history: Back is a popstate, which only a real history can block.
  async function editOpen() {
    h.openWebDoor.mockImplementation(async () => ({
      ...freshSheet('b1'),
      mode: { kind: 'edit', reportId: 'r1' },
    }));
    const router = renderAt('/', 'browser');
    await screen.findByText('Explore');
    await act(() => router.navigate({ to: '/', search: { post: 'r1' } } as never));
    await screen.findByTestId('sheet');
    act(() => updateSheet((p) => ({ ...p, title: 'Changed', dirty: true })));
    return router;
  }

  it('lets an untouched sheet go without asking', async () => {
    const router = renderAt('/?post=new');
    await screen.findByTestId('sheet');
    await act(() => router.navigate({ to: '/latest' } as never));
    expect(router.state.location.pathname).toBe('/latest');
    expect(screen.queryByText('Leave without posting?')).not.toBeInTheDocument();
  });

  it('asks before Back takes a touched edit away; Keep writing stays', async () => {
    const router = await editOpen();
    act(() => router.history.back());
    expect(await screen.findByText('Leave without posting?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Keep writing/ }));
    await waitFor(() =>
      expect(screen.queryByText('Leave without posting?')).not.toBeInTheDocument(),
    );
    expect(search(router).post).toBe('r1');
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
  });

  it('asks before the × closes a touched edit; Leave goes and forgets the edit', async () => {
    const router = await editOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Leave without posting?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Leave without posting/ }));
    await waitFor(() => expect(search(router).post).toBeUndefined());
    expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
  });

  // The blocker still holds the touched sheet from the last render when these navigate.
  it('a saved edit goes to its report without asking', async () => {
    const router = await editOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/report/rep-9'));
    expect(screen.queryByText('Leave without posting?')).not.toBeInTheDocument();
  });

  it('a discarded edit leaves without asking a second time', async () => {
    const router = await editOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(search(router).post).toBeUndefined());
    expect(screen.queryByText('Leave without posting?')).not.toBeInTheDocument();
  });
});

describe('the restore', () => {
  it('lands back on the draft a reload left, and says so', async () => {
    const kept = { ...freshSheet(), title: 'Before the reload', dirty: true };
    setSheet(kept);
    reloadPage('user_1');
    renderAt('/?post=new');
    expect(await screen.findByTestId('sheet')).toHaveAttribute('data-draft', kept.draftId);
    expect(h.openWebDoor).not.toHaveBeenCalled();
    expect(h.capture).toHaveBeenCalledWith('report_draft_restored');
  });

  it('sends once, after a restore that comes back owed a resend', async () => {
    const kept = { ...freshSheet('b1'), title: 'As pressed', dirty: true };
    setSheet(kept);
    const failed: PostDraft = {
      kind: 'post',
      id: kept.draftId,
      idempotencyKey: kept.idempotencyKey,
      status: 'pending',
      reports: [],
      createdAt: 1,
      updatedAt: 1,
    };
    setSheetAttempt(failed);
    reloadPage('user_1');
    h.postSheetOnWeb.mockResolvedValue({ kind: 'posted', postId: 'p1', reportId: 'rep-7' });
    const router = renderAt('/?post=new');
    await waitFor(() => expect(router.state.location.pathname).toBe('/report/rep-7'));
    expect(h.postSheetOnWeb).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledWith('report_post_retried', { offline: true });
    expect(h.capture).toHaveBeenCalledWith('report_posted', { report_count: 1 });
  });

  it('opens fresh when the stored draft answers another door', async () => {
    setSheet({ ...freshSheet('other'), dirty: false });
    reloadPage('user_1');
    renderAt('/?post=new&postBody=b1');
    await screen.findByTestId('sheet');
    expect(h.openWebDoor).toHaveBeenCalledTimes(1);
    expect(h.capture).not.toHaveBeenCalledWith('report_draft_restored');
  });
});

describe('abandonment', () => {
  it('a hidden page leaves a marker; the next open counts it when the draft did not come back', async () => {
    renderAt('/?post=new');
    await screen.findByTestId('sheet');
    act(() => updateSheet((p) => ({ ...p, title: 'Typed', dirty: true })));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(JSON.parse(window.localStorage.getItem(ABANDON_KEY) ?? 'null')).toMatchObject({
      sectionsAnswered: 0,
    });
    // The next page: a different account's browser state, so the draft does not come back.
    window.localStorage.removeItem('skating.reportSheet.v2');
    reloadPage('user_1');
    h.capture.mockReset();
    renderAt('/?post=new');
    await waitFor(() =>
      expect(h.capture).toHaveBeenCalledWith('report_sheet_abandoned', { sections_answered: 0 }),
    );
    expect(window.localStorage.getItem(ABANDON_KEY)).toBeNull();
  });

  it('a reload that brings the draft back is not an abandonment', async () => {
    const kept = { ...freshSheet(), title: 'Typed', dirty: true };
    setSheet(kept);
    window.localStorage.setItem(
      ABANDON_KEY,
      JSON.stringify({ draftId: kept.draftId, sectionsAnswered: 2 }),
    );
    reloadPage('user_1');
    renderAt('/?post=new');
    await screen.findByTestId('sheet');
    expect(h.capture).not.toHaveBeenCalledWith('report_sheet_abandoned', expect.anything());
    expect(getSheetAttempt()).toBeNull();
    bindSheetOwner('user_1');
  });
});
