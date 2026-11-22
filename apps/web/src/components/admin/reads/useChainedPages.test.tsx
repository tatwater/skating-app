import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The shared page chain, read through the console's read layer** (`useChainedPages` +
 * `joinChain`), against a fake server that answers each page as a console list's cursor read does
 * (`listPageFake`: exactly `(cursor, end]` once pinned, `SplitRequired` past its cap). The three
 * promises every list that reads it relies on: a row decided on page one moves nothing on page two;
 * a page that grew past the cap is split and nothing is lost or drawn twice; a change of list (a
 * filter, a lane, a search) starts the chain over.
 */

type Row = { id: string };
type Args = { cursor: string | null; endCursor?: string | null; pageSize: number };

const server = vi.hoisted(() => ({
  rows: [] as { id: string }[],
  cap: 4,
  /** Each page read asked for, in order: `cursor..end`. */
  asked: [] as string[],
  answer: null as null | ((args: Args) => unknown),
}));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { query: never; args: Args }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([k, q]) => {
        server.asked.push(`${q.args.cursor ?? '∅'}..${q.args.endCursor ?? '∞'}`);
        return [k, server.answer?.(q.args)];
      }),
    ),
}));
vi.mock('@sentry/tanstackstart-react', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/env', () => ({ isConfigured: { sentry: false } }));

import { api } from '@skating/convex/api';
import { type FakePage, fakeListPage } from '../people/list/listPageFake';
import { read, resetConsoleReads } from './consoleReads';
import { joinChain } from './joinChain';
import type { ChainLink } from './pageChain';
import { useChainedPages } from './useChainedPages';

const PAGE = 3;
const keyOf = (r: Row) => r.id;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: `r${String(from + i).padStart(3, '0')}`,
  }));

/** The chain over the fake server, joined as a list draws it. */
function useList(key: string) {
  const chain = useChainedPages<FakePage<Row>>(key, (link: ChainLink) =>
    // Any query will do: the fake answers by the cursors alone.
    read(api.people.listPage, {
      lane: 'all',
      cursor: link.cursor,
      ...(link.end !== null && { endCursor: link.end }),
      pageSize: PAGE,
      now: 0,
    }),
  );
  return { ...chain, list: joinChain(chain.pages, (p) => p.rows, keyOf) };
}

beforeEach(() => {
  resetConsoleReads();
  server.rows = ids(1, 9);
  server.cap = 4;
  server.asked = [];
  server.answer = (args) =>
    fakeListPage(server.rows, keyOf, args, { cap: server.cap, split: true });
});

/** Ask for pages until the list is done. */
function readAll(result: { current: ReturnType<typeof useList> }) {
  for (let i = 0; i < 10 && result.current.list.status === 'more'; i++) {
    act(() => result.current.loadMore());
  }
}

describe('useChainedPages', () => {
  it('reads page after page, each pinned to where it ended, until the last says done', () => {
    const { result } = renderHook(() => useList('all'));
    expect(result.current.list).toMatchObject({ status: 'more' });
    expect(result.current.list.rows.map(keyOf)).toEqual(['r001', 'r002', 'r003']);
    readAll(result);
    expect(result.current.list.status).toBe('done');
    expect(result.current.list.rows.map(keyOf)).toEqual(ids(1, 9).map(keyOf));
    // Every page but the last is read as its own pinned range.
    expect(server.asked).toContain('r003..r006');
  });

  it('a row decided on page one moves nothing on page two', () => {
    const { result, rerender } = renderHook(() => useList('all'));
    act(() => result.current.loadMore());
    const second = result.current.pages[1];
    expect(result.current.list.rows.map(keyOf)).toEqual(ids(1, 6).map(keyOf));
    // r002 is decided: it leaves the list, on page one.
    server.rows = server.rows.filter((r) => r.id !== 'r002');
    rerender();
    const rows = result.current.list.rows.map(keyOf);
    expect(rows).toEqual(['r001', 'r003', 'r004', 'r005', 'r006']);
    // Page two starts and ends where it did: its rows are the same rows, none lost, none twice.
    expect(result.current.pages[1]).toEqual(second);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('a page past the cap is split where the server says, and nothing is lost or drawn twice', () => {
    const { result, rerender } = renderHook(() => useList('all'));
    act(() => result.current.loadMore());
    // Three rows land inside page one's pinned range: it now holds six, past the cap of four.
    server.rows = [...server.rows, { id: 'r001a' }, { id: 'r001b' }, { id: 'r001c' }].sort(
      (a, b) => (a.id < b.id ? -1 : 1),
    );
    rerender();
    readAll(result);
    const rows = result.current.list.rows.map(keyOf);
    expect(rows).toEqual(server.rows.map(keyOf));
    expect(new Set(rows).size).toBe(rows.length);
    expect(result.current.list.status).toBe('done');
    // The split asked for the two halves of the old range.
    expect(server.asked).toContain('∅..r001c');
    expect(server.asked).toContain('r001c..r003');
  });

  it('a change of list starts the chain over from its first page', () => {
    const { result, rerender } = renderHook(({ key }) => useList(key), {
      initialProps: { key: 'all' },
    });
    act(() => result.current.loadMore());
    expect(result.current.pages).toHaveLength(2);
    server.asked = [];
    rerender({ key: 'suspended' });
    expect(result.current.pages).toHaveLength(1);
    expect(server.asked).toEqual(['∅..∞']);
    expect(result.current.list.rows.map(keyOf)).toEqual(['r001', 'r002', 'r003']);
  });

  it('asks for nothing more while the last page is on its way, done, or no list is read', () => {
    server.answer = () => undefined;
    const { result } = renderHook(() => useList('all'));
    expect(result.current.list.status).toBe('loading');
    act(() => result.current.loadMore());
    expect(result.current.pages).toHaveLength(1);
    const none = renderHook(() => useChainedPages<FakePage<Row>>('', null));
    expect(none.result.current.pages).toEqual([undefined]);
  });
});

describe('joinChain', () => {
  const failed = { failed: true as const, pending: false, retry: () => {} };
  const page = (rows: Row[], more: Partial<FakePage<Row>> = {}): FakePage<Row> => ({
    rows,
    isDone: true,
    continueCursor: rows.at(-1)?.id ?? '',
    ...more,
  });

  it('is unread with no pages, loading before the first, fetching before a later one', () => {
    expect(joinChain(null, (p: FakePage<Row>) => p.rows, keyOf)).toEqual({
      status: 'unread',
      rows: [],
      read: [],
      failed: false,
    });
    expect(joinChain([undefined], (p: FakePage<Row>) => p.rows, keyOf).status).toBe('loading');
    const first = page(ids(1, 2), { isDone: false });
    expect(joinChain([first, undefined], (p) => p.rows, keyOf)).toMatchObject({
      status: 'fetching',
      read: [first],
    });
  });

  it('stops at a failure keeping the rows before it, and at a split page after its rows', () => {
    const first = page(ids(1, 2), { isDone: false });
    expect(
      joinChain([first, failed, page(ids(3, 4))], (p: FakePage<Row>) => p.rows, keyOf),
    ).toMatchObject({
      status: 'error',
      failed: true,
      rows: ids(1, 2),
    });
    const split = page(ids(1, 2), { isDone: false, pageStatus: 'SplitRequired' });
    expect(joinChain([split, page(ids(3, 4))], (p) => p.rows, keyOf)).toMatchObject({
      status: 'fetching',
      rows: ids(1, 2),
      read: [split],
    });
  });

  it('draws each row once, the first page that holds it winning', () => {
    const a = page(ids(1, 3), { isDone: false });
    const b = page(ids(3, 4));
    expect(joinChain([a, b], (p) => p.rows, keyOf)).toMatchObject({
      status: 'done',
      rows: ids(1, 4),
      read: [a, b],
    });
    expect(joinChain([page(ids(1, 1), { isDone: false })], (p) => p.rows, keyOf).status).toBe(
      'more',
    );
  });
});
