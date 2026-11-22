import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assertSeeded } from '@/test/seeded';
import {
  type ChainLink,
  extendChain,
  FIRST_CHAIN,
  type PageEnd,
  settleChain,
} from '../../reads/pageChain';
import { type FakePage, fakeListPage } from './listPageFake';
import type { PeoplePage } from './peopleModel';
import { joinPages } from './peopleReads';

/**
 * **The People list's chain of pages stays stitched** (`people.listPage` takes an `endCursor`): a
 * page read past is pinned to where it ended, so a person joining or leaving an earlier page moves
 * nothing on a later one — no row twice, no row lost, the list's order kept, and the list is done
 * only when the server says its last page is. A page that grew past the server's cap is split where
 * the server says; a search, which gives no split point, reads that page again unbounded and the
 * chain goes on from its new end.
 */

type Row = { userId: string };
const PAGE = 3;
const CAP = 4;

const key = (n: number, tag: number) =>
  `k${String(n).padStart(5, '0')}.${String(tag).padStart(4, '0')}`;

/** A server over `keys` (kept sorted), answering each link as `listPage` would. */
function server(mode: 'keyed' | 'search') {
  let keys: string[] = [];
  const answer = (link: ChainLink): FakePage<Row> =>
    fakeListPage(
      keys.map((userId) => ({ userId })),
      (r) => r.userId,
      { cursor: link.cursor, endCursor: link.end, pageSize: PAGE },
      { cap: CAP, split: mode === 'keyed' },
    );
  return {
    get keys() {
      return keys;
    },
    set(next: string[]) {
      keys = [...next].sort();
    },
    answer,
  };
}

const asPage = (p: FakePage<Row>): PeoplePage =>
  ({ ...p, partial: false, reasons: [], pending: [] }) as unknown as PeoplePage;

/** Settle the chain against the server, as the hook does answer by answer. */
function settled(
  chain: readonly ChainLink[],
  answer: (l: ChainLink) => PageEnd,
): readonly ChainLink[] {
  let current = chain;
  for (let n = 0; n < 200; n++) {
    const next = settleChain(current, current.map(answer));
    if (next === null) return current;
    current = next;
  }
  throw new Error('the chain never settled');
}

type Op = { kind: 'insert'; at: number } | { kind: 'remove'; at: number } | { kind: 'more' };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('insert' as const), at: fc.nat(120) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), at: fc.nat(200) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('more' as const) }) },
);

/** The last row shown before the last page — what every page read past covers — or `null`. */
function readPast(chain: readonly ChainLink[], answer: (l: ChainLink) => FakePage<Row>) {
  const rows = chain.slice(0, -1).flatMap((l) => answer(l).rows);
  return rows.at(-1)?.userId ?? null;
}

function drive(mode: 'keyed' | 'search', start: number, ops: readonly Op[]) {
  const s = server(mode);
  s.set(Array.from({ length: start }, (_, i) => key(i * 10, 0)));
  let chain = settled(FIRST_CHAIN, s.answer);
  let tag = 1;
  const check = (coveredBefore: string | null) => {
    const answers = chain.map(s.answer);
    // The pages themselves never overlap: nothing is read twice, so nothing needs hiding.
    const raw = answers.flatMap((a) => a.rows.map((r) => r.userId));
    expect(new Set(raw).size).toBe(raw.length);
    const joined = joinPages(answers.map(asPage));
    const shown = joined.rows.map((r) => r.userId);
    // In the list's order, from its start, with no row missing between.
    expect(shown).toEqual(s.keys.slice(0, shown.length));
    // Done only when the server says the last page is; then every row is in.
    const last = answers.at(-1) as FakePage<Row>;
    expect(joined.status).toBe(last.isDone ? 'done' : 'more');
    if (joined.status === 'done') expect(shown).toEqual(s.keys);
    // On a keyed lane the pages read past stay: every row they covered before the change still
    // shows — never dropped for the chain to be read again from an earlier page.
    if (mode === 'keyed' && coveredBefore !== null) {
      const covered = s.keys.filter((k) => k <= coveredBefore).length;
      expect(shown.length).toBeGreaterThanOrEqual(covered);
    }
  };
  check(null);
  for (const op of ops) {
    const before = op.kind === 'more' ? null : readPast(chain, s.answer);
    if (op.kind === 'insert') s.set([...s.keys, key(op.at, tag++)]);
    else if (op.kind === 'remove' && s.keys.length > 0)
      s.set(s.keys.filter((_, i) => i !== op.at % s.keys.length));
    else if (op.kind === 'more') {
      const last = chain.at(-1) as ChainLink;
      chain = extendChain(chain, s.answer(last));
    }
    chain = settled(chain, s.answer);
    check(before);
  }
}

describe('the chain of pages, against the server’s paging', () => {
  it('keeps every page stitched through inserts and removals in earlier pages', () => {
    assertSeeded(
      fc.property(fc.nat(14), fc.array(opArb, { maxLength: 24 }), (start, ops) => {
        drive('keyed', start, ops);
      }),
      { numRuns: 60 },
    );
  });

  it('keeps a search in order with no row twice, reading a page past the cap again unbounded', () => {
    assertSeeded(
      fc.property(fc.nat(14), fc.array(opArb, { maxLength: 24 }), (start, ops) => {
        drive('search', start, ops);
      }),
      { numRuns: 60 },
    );
  });
});

describe('one step of the chain', () => {
  const page = (o: Partial<PageEnd> = {}): PageEnd => ({
    isDone: false,
    continueCursor: 'c1',
    ...o,
  });

  it('pins the page read past to where it ended, and asks on from there', () => {
    expect(extendChain(FIRST_CHAIN, page())).toEqual([
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ]);
  });

  it('asks for nothing more past a page that is done, on its way, or to be split', () => {
    expect(extendChain(FIRST_CHAIN, page({ isDone: true }))).toBe(FIRST_CHAIN);
    expect(extendChain(FIRST_CHAIN, undefined)).toBe(FIRST_CHAIN);
    expect(extendChain(FIRST_CHAIN, page({ pageStatus: 'SplitRequired' }))).toBe(FIRST_CHAIN);
  });

  it('keeps a pinned last page’s end when it asks on (the chain was cut at a page done)', () => {
    const chain = [{ cursor: null, end: 'c1' }];
    expect(extendChain(chain, page({ continueCursor: 'c1' }))).toEqual([
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ]);
  });

  it('changes nothing while every page agrees with the next, or one before a change is on its way', () => {
    const chain = [
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ];
    expect(settleChain(chain, [page(), page({ continueCursor: 'c2' })])).toBeNull();
    expect(settleChain(chain, [undefined, page({ isDone: true })])).toBeNull();
    expect(settleChain([], [])).toBeNull();
  });

  it('splits a page where the server says, keeping the pages after it', () => {
    const chain = [
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ];
    expect(
      settleChain(chain, [
        page({ pageStatus: 'SplitRequired', splitCursor: 'c0' }),
        page({ continueCursor: 'c2' }),
      ]),
    ).toEqual([
      { cursor: null, end: 'c0' },
      { cursor: 'c0', end: 'c1' },
      { cursor: 'c1', end: null },
    ]);
  });

  it('reads a page to split with no split point again unbounded, the chain going on from it', () => {
    const chain = [
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ];
    expect(settleChain(chain, [page({ pageStatus: 'SplitRequired' }), page()])).toEqual([
      { cursor: null, end: null },
    ]);
  });

  it('cuts the chain at a page read past that is now done, and re-anchors on an end that moved', () => {
    const chain = [
      { cursor: null, end: 'c1' },
      { cursor: 'c1', end: null },
    ];
    expect(settleChain(chain, [page({ isDone: true }), page()])).toEqual([
      { cursor: null, end: 'c1' },
    ]);
    // A page whose end no longer meets the next (a server that didn't hold the end): the deeper
    // pages go and the chain asks on from the end it gives.
    expect(settleChain(chain, [page({ continueCursor: 'c1b' }), page()])).toEqual([
      { cursor: null, end: 'c1' },
      { cursor: 'c1b', end: null },
    ]);
  });
});
