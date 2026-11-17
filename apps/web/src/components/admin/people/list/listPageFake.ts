/**
 * Test support: `people.listPage`'s paging as the server answers it (`sliceByKey` and the bounded
 * `paginate` in `people.ts`), over rows already in the list's order and keyed by a string that sorts
 * the same way. A page reads after `cursor`; given an `endCursor` it reads exactly
 * `(cursor, endCursor]` and keeps that end as its `continueCursor`; a bounded page that grew past
 * `cap` returns the cap and says `SplitRequired` — with a `splitCursor` on a keyed lane, and none on
 * a search (a search index gives none).
 */

export type FakePageArgs = {
  cursor: string | null;
  endCursor?: string | null;
  pageSize: number;
};

export type FakePage<R> = {
  rows: R[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string;
  pageStatus?: 'SplitRequired';
};

export function fakeListPage<R>(
  rows: readonly R[],
  keyOf: (row: R) => string,
  args: FakePageArgs,
  opts: { cap: number; split: boolean },
): FakePage<R> {
  const { cursor, pageSize } = args;
  const end = args.endCursor ?? null;
  const after = rows.filter((r) => cursor === null || keyOf(r) > cursor);
  if (end === null) {
    const slice = after.slice(0, pageSize);
    const last = slice.at(-1);
    return {
      rows: slice,
      isDone: slice.length === after.length,
      continueCursor: last === undefined ? (cursor ?? '') : keyOf(last),
    };
  }
  const bounded = after.filter((r) => keyOf(r) <= end);
  if (bounded.length > opts.cap) {
    const slice = bounded.slice(0, opts.cap);
    return {
      rows: slice,
      isDone: false,
      continueCursor: end,
      ...(opts.split && { splitCursor: keyOf(slice.at(-1) as R) }),
      pageStatus: 'SplitRequired',
    };
  }
  return { rows: bounded, isDone: bounded.length === after.length, continueCursor: end };
}
