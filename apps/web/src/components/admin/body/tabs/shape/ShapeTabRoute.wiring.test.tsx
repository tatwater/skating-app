import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The Shape tab's merge through the real Body console route** (`/admin/body/$id`, as the app mounts
 * it), with only the router, the role, the Convex hooks, the undo shell's announce, the toast queue
 * and the map's canvas stood in: a touching body pressed asks the server's preview with this body
 * and that one; a survivor found by name is the one sent, never the body itself or the first hit;
 * the confirm sends `waterBodies.merge` with the body's id, the survivor's and the reason; a refusal
 * reaches a toast in the server's words, naming the body; a merge too heavy for one go can't be
 * confirmed; the receipt names both bodies with Undo from the write's own answer; and once the
 * record is the survivor's, the console draws the merged page. A viewer without the duplicates
 * capability is asked nothing of the merge and offered nothing.
 */

const mocks = vi.hoisted(() => ({
  /** Each read's answer: by `name|args` first, else by name. */
  results: new Map<string, unknown>(),
  /** The reads asked for, as `name|args`, across every render. */
  asked: [] as string[],
  params: { id: '' } as Record<string, string>,
  search: {} as Record<string, unknown>,
  denied: new Set<string>(),
  /** Every write sent, by name, with its arguments. */
  writes: [] as { name: string; args: Record<string, unknown> }[],
  /** A write's answer by name; throws to refuse. */
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  announce: vi.fn((_receipt: unknown) => Promise.resolve()),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const answer = (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref);
    const key = `${name}|${JSON.stringify(args)}`;
    mocks.asked.push(key);
    return mocks.results.has(key) ? mocks.results.get(key) : mocks.results.get(name);
  };
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === 'skip' ? undefined : answer(ref, args),
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, answer(q.query, q.args)])),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      return async (args: Record<string, unknown>) => {
        mocks.writes.push({ name, args });
        return mocks.answer[name]?.(args);
      };
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => mocks.params,
  useSearch: () => mocks.search,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { push: vi.fn() } }),
  Link: ({
    to,
    params,
    children,
    className,
    onClick,
  }: {
    to: string;
    params?: { id: string };
    children?: ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={to.replace('$id', params?.id ?? '')} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => !mocks.denied.has(c), isLoading: false }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as { title: string; description?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => toasts.push(t),
}));
vi.mock('../../map/useBodyMapCanvas', () => ({
  FIT_PADDING: { top: 0, right: 0, bottom: 0, left: 0 },
  useBodyMapCanvas: () => ({
    ground: <div data-testid="ground" />,
    surface: null,
    zoomIn: () => {},
    zoomOut: () => {},
    atMinZoom: false,
    atMaxZoom: false,
  }),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { BodyConsoleRoute } from '../../frame/BodyConsoleRoute';
import {
  MASCOMA_BAY_PROVENANCE,
  MASCOMA_EXTRAS,
  MASCOMA_HISTORY,
  MASCOMA_ID,
  MASCOMA_RECORD,
  MASCOMA_SUB_AREAS,
  NEIGHBOR_ID,
  NEIGHBOR_POLYGON,
} from '../../frame/bodyFixtures';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ListWritersProvider } from '../listWriter';
import { MERGE_ANSWER, MERGE_HEAVY, MERGE_TO_CRYSTAL } from './mergeFixtures';
import { MERGE_PREVIEW, MERGE_WRITE } from './mergeModel';
import { MERGE_WORDS } from './mergeWords';

type Ref = Parameters<typeof getFunctionName>[0];
const set = (ref: Ref, value: unknown, args?: unknown) =>
  mocks.results.set(
    args === undefined ? getFunctionName(ref) : `${getFunctionName(ref)}|${JSON.stringify(args)}`,
    value,
  );
const askedFor = (ref: Ref): Record<string, unknown>[] =>
  mocks.asked
    .filter((k) => k.startsWith(`${getFunctionName(ref)}|`))
    .map((k) => JSON.parse(k.slice(k.indexOf('|') + 1)));
const MERGE = getFunctionName(MERGE_WRITE);

/** Another body by name, found by the search (not touching Mascoma). */
const POST_POND_ID = 'k57postpond000000000000000000000';

const Mounted = () => (
  <ListWritersProvider>
    <KeysProvider>
      <BodyConsoleRoute />
    </KeysProvider>
  </ListWritersProvider>
);

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  resetConsoleReads();
  mocks.results.clear();
  mocks.asked.length = 0;
  mocks.params = { id: MASCOMA_ID };
  mocks.search = {};
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = { [MERGE]: () => MERGE_ANSWER };
  mocks.announce.mockClear();
  toasts.length = 0;
  set(api.waterBodies.get, { available: true, body: { ...MASCOMA_RECORD, bbox: undefined } });
  set(
    api.subAreas.listForBody,
    MASCOMA_SUB_AREAS.map((s) => ({ ...s, polygon: MASCOMA_RECORD.polygon })),
  );
  set(api.bodyConsole.bayProvenance, MASCOMA_BAY_PROVENANCE);
  set(api.landmarks.listForEditor, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, { putIns: [], parking: [], blockedIds: [], alerts: [] });
  set(api.corpusRequests.openBayRequestsForBody, { bays: [], more: false });
  set(api.corpusPlaceNames.openForBody, { names: [], more: false });
  set(api.corpusRequests.openLandmarkRequestsForBody, { proposals: [], more: false });
  // Crystal Lake touches Mascoma: the Merge block shows.
  set(api.bodyConsole.consoleExtras, {
    ...MASCOMA_EXTRAS,
    touchingBodyIds: [NEIGHBOR_ID],
    touching: [
      { waterBodyId: NEIGHBOR_ID, name: 'Crystal Lake', ring: NEIGHBOR_POLYGON.coordinates[0] },
    ],
  });
  set(api.bodyConsole.history, {
    entries: MASCOMA_HISTORY.map((h) => ({
      ...h,
      reason: h.reason ?? '',
      undo: { state: 'unavailable', why: '' },
    })),
    capped: false,
  });
  set(MERGE_PREVIEW, MERGE_TO_CRYSTAL);
});
afterEach(() => vi.useRealTimers());

const region = () => screen.getByRole('region', { name: 'Merge into another body' });

/** Picks Crystal Lake from the touching list, then confirms with a reason. */
async function mergeIntoCrystal(user: ReturnType<typeof userEvent.setup>, reason = 'Drawn twice') {
  await user.click(within(region()).getByText('Crystal Lake'));
  await user.click(await screen.findByRole('button', { name: 'Merge into Crystal Lake' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.type(within(dialog).getByRole('textbox'), reason);
  await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
}

describe('the Shape tab’s merge, through the route', () => {
  it('asks nothing of the merge until a survivor is picked, then the preview for this body and that one', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    expect(askedFor(MERGE_PREVIEW)).toEqual([]);
    expect(askedFor(api.waterBodies.searchByName)).toEqual([]);
    await user.click(within(region()).getByText('Crystal Lake'));
    expect(askedFor(MERGE_PREVIEW).at(-1)).toEqual({
      loserId: MASCOMA_ID,
      survivorId: NEIGHBOR_ID,
    });
    expect(screen.getByRole('region', { name: 'Into Crystal Lake' })).toHaveTextContent(
      'Reports 3',
    );
  });

  it('sends waterBodies.merge with this body, the survivor picked and the reason', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await mergeIntoCrystal(user, '  Drawn twice  ');
    await waitFor(() =>
      expect(mocks.writes).toEqual([
        {
          name: MERGE,
          args: { survivorId: NEIGHBOR_ID, loserId: MASCOMA_ID, reason: 'Drawn twice' },
        },
      ]),
    );
  });

  it('raises the receipt naming both bodies, with Undo (the unmerge) from the write’s answer', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await mergeIntoCrystal(user);
    await waitFor(() => expect(mocks.announce).toHaveBeenCalledTimes(1));
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'Merged into Crystal Lake',
      description: MERGE_WORDS.mergedDetail,
      target: { targetType: 'waterbody', targetId: MASCOMA_ID },
      // This body by name: the receipt's subject.
      subject: 'Mascoma Lake',
      actionId: MERGE_ANSWER.actionId,
      undoNeedsReason: true,
    });
  });

  it('a write that can’t be undone now raises its receipt with no Undo', async () => {
    const user = userEvent.setup();
    mocks.answer[MERGE] = () => ({ ...MERGE_ANSWER, undoable: false, undoNeedsReason: undefined });
    render(<Mounted />);
    await mergeIntoCrystal(user);
    await waitFor(() => expect(mocks.announce).toHaveBeenCalledTimes(1));
    expect(mocks.announce.mock.calls[0]?.[0]).toMatchObject({
      actionId: MERGE_ANSWER.actionId,
      undoable: false,
    });
  });

  it('a refusal reaches a toast in the server’s words, naming this body; the dialog stays', async () => {
    const user = userEvent.setup();
    const { ConvexError } = await import('convex/values');
    mocks.answer[MERGE] = () => {
      throw new ConvexError('Too much moves for one merge here.');
    };
    render(<Mounted />);
    await mergeIntoCrystal(user);
    await waitFor(() =>
      expect(toasts).toContainEqual(
        expect.objectContaining({
          title: 'Not saved · Mascoma Lake',
          description: 'The merge: Too much moves for one merge here.',
        }),
      ),
    );
    expect(mocks.announce).not.toHaveBeenCalled();
    // Said in the toast, never in the page; the dialog keeps the reason to send again.
    expect(within(region()).queryByText('Too much moves for one merge here.')).toBeNull();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('a merge too heavy for one go can’t be confirmed', async () => {
    const user = userEvent.setup();
    set(MERGE_PREVIEW, MERGE_HEAVY);
    render(<Mounted />);
    await user.click(within(region()).getByText('Crystal Lake'));
    const confirm = screen.getByRole('button', { name: 'Merge into Crystal Lake' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Into Crystal Lake' })).toHaveTextContent(
      MERGE_HEAVY.refusal as string,
    );
    await user.click(confirm);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it('a survivor found by name is the one asked and sent — never this body, never the first hit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The search finds this body itself first, then Crystal Lake, then Post Pond.
    set(api.waterBodies.searchByName, [
      { waterBodyId: MASCOMA_ID, name: 'Mascoma Lake', type: 'lake', states: ['NH'] },
      { waterBodyId: NEIGHBOR_ID, name: 'Crystal Lake', type: 'lake', states: ['NH'] },
      { waterBodyId: POST_POND_ID, name: 'Post Pond', type: 'pond', states: ['NH'] },
    ]);
    set(
      MERGE_PREVIEW,
      {
        ...MERGE_TO_CRYSTAL,
        survivor: { ...MERGE_TO_CRYSTAL.survivor, waterBodyId: POST_POND_ID, name: 'Post Pond' },
      },
      { loserId: MASCOMA_ID, survivorId: POST_POND_ID },
    );
    render(<Mounted />);
    await user.type(within(region()).getByRole('searchbox'), 'po');
    // Asked only once typing rests.
    expect(askedFor(api.waterBodies.searchByName)).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(askedFor(api.waterBodies.searchByName).at(-1)).toEqual({
      query: 'po',
      limit: 6,
      bodiesOnly: true,
    });
    const hits = within(region()).getByRole('table', { name: MERGE_WORDS.searchLabel });
    // This body is never offered as its own survivor.
    expect(within(hits).queryByText('Mascoma Lake')).toBeNull();
    await user.click(within(hits).getByText('Post Pond'));
    expect(askedFor(MERGE_PREVIEW).at(-1)).toEqual({
      loserId: MASCOMA_ID,
      survivorId: POST_POND_ID,
    });
    await user.click(screen.getByRole('button', { name: 'Merge into Post Pond' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Same pond');
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(mocks.writes).toHaveLength(1));
    expect(mocks.writes[0]?.args).toEqual({
      survivorId: POST_POND_ID,
      loserId: MASCOMA_ID,
      reason: 'Same pond',
    });
  });

  it('once the record is the survivor’s, the console draws the merged page', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Mounted />);
    await mergeIntoCrystal(user);
    await waitFor(() => expect(mocks.writes).toHaveLength(1));
    // The live record follows the merge: this id now reads as the body it was merged into.
    set(api.waterBodies.get, {
      available: true,
      body: { ...MASCOMA_RECORD, _id: NEIGHBOR_ID, name: 'Crystal Lake', bbox: undefined },
    });
    rerender(<Mounted />);
    expect(await screen.findByText(/This body was merged into/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Crystal Lake' })).toHaveAttribute(
      'href',
      `/admin/body/${NEIGHBOR_ID}`,
    );
  });

  it('offers a viewer without the duplicates capability no merge, and asks nothing of it', async () => {
    const user = userEvent.setup();
    mocks.denied = new Set(['corpus.duplicates']);
    render(<Mounted />);
    await user.click(within(region()).getByText('Crystal Lake'));
    expect(within(region()).queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Merge into/ })).toBeNull();
    expect(askedFor(MERGE_PREVIEW)).toEqual([]);
  });
});
