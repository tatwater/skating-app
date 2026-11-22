import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fakeListPage } from '../../people/list/listPageFake';
import type { Loadable } from '../../reads/consoleReads';
import { type ChainLink, extendChain, FIRST_CHAIN, settleChain } from '../../reads/pageChain';
import { page, SAFETY_ROW } from './inboxFixtures';
import { joinPages } from './inboxReads';
import type { InboxListPage, InboxRowView } from './inboxTypes';

const row = (n: number) =>
  ({ ...SAFETY_ROW, itemId: `it${String(n).padStart(4, '0')}` }) as InboxRowView;
const keyOf = (r: InboxRowView) => r.itemId as string;

describe('joinPages', () => {
  it('draws nothing read when there is no read', () => {
    expect(joinPages(null)).toEqual({ status: 'unread', rows: [], pending: false, failed: false });
  });

  it('is loading until the first page lands, and fetching after', () => {
    expect(joinPages([undefined]).status).toBe('loading');
    expect(joinPages([page([row(1)], { isDone: false }), undefined]).status).toBe('fetching');
  });

  it('draws each item once across pages, in order', () => {
    const joined = joinPages([
      page([row(1), row(2)], { isDone: false, continueCursor: 'it0002' }),
      page([row(2), row(3)]),
    ]);
    expect(joined.rows.map(keyOf)).toEqual(['it0001', 'it0002', 'it0003']);
    expect(joined.status).toBe('done');
  });

  it('says the list may be missing items while any page read says the server is preparing', () => {
    expect(joinPages([page([row(1)], { pending: true })]).pending).toBe(true);
    expect(joinPages([page([row(1)])]).pending).toBe(false);
  });

  it('stops at the scan’s budget when the last page read says the scan ended it', () => {
    const budget = joinPages([page([row(1)], { isDone: false, scanBudgetSpent: true })]);
    expect(budget.status).toBe('budget');
    // A page the scan ended that is also the list's end is just the end.
    expect(joinPages([page([], { scanBudgetSpent: true })]).status).toBe('done');
    // Only the last page decides: an earlier page's spent budget was read past.
    expect(
      joinPages([
        page([row(1)], { isDone: false, scanBudgetSpent: true }),
        page([row(2)], { isDone: false }),
      ]).status,
    ).toBe('more');
  });

  it('stops at a failed page, keeping the rows before it', () => {
    const failed = { failed: true as const, pending: false, retry: () => {} };
    const joined = joinPages([page([row(1)], { isDone: false }), failed]);
    expect(joined).toMatchObject({ status: 'error', failed: true });
    expect(joined.rows.map(keyOf)).toEqual(['it0001']);
  });
});

/**
 * The chain driven against a fake server that answers as `inbox.listPage` does (exactly
 * `(cursor, end]` once a page is pinned), settled the way `useChainedPages` settles it.
 */
function readChain(
  rows: readonly InboxRowView[],
  links: readonly ChainLink[],
  pageSize: number,
): { links: readonly ChainLink[]; pages: InboxListPage[] } {
  let chain = links;
  for (let guard = 0; guard < 20; guard++) {
    const pages = chain.map((l) =>
      page([], {
        ...fakeListPage(
          rows,
          keyOf,
          { cursor: l.cursor, endCursor: l.end, pageSize },
          {
            cap: 1000,
            split: true,
          },
        ),
      }),
    );
    const next = settleChain(chain, pages);
    if (next === null) return { links: chain, pages };
    chain = next;
  }
  throw new Error('the chain never settled');
}

describe('the page chain (fast-check)', () => {
  it('a decision on page one moves nothing on page two', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 40 }),
        fc.integer({ min: 2, max: 10 }),
        fc.nat(),
        (count, pageSize, pick) => {
          const all = Array.from({ length: count }, (_, i) => row(i + 1));
          // Read page one, then ask for page two: page one is pinned to where it ended.
          const first = readChain(all, FIRST_CHAIN, pageSize);
          const pageOne = first.pages[0] as InboxListPage;
          const extended = extendChain(first.links, pageOne);
          const before = readChain(all, extended, pageSize);
          if (before.pages.length < 2) return; // the list fit on one page
          // An item on page one is decided: it leaves the open list.
          const onPageOne = before.pages[0]?.rows ?? [];
          const decided = onPageOne[pick % onPageOne.length];
          if (decided === undefined) return;
          const rest = all.filter((r) => r !== decided);
          const after = readChain(rest, before.links, pageSize);
          // Page two is read from the same start and reads the same rows.
          expect(after.links[1]).toEqual(before.links[1]);
          expect(after.pages[1]?.rows.map(keyOf)).toEqual(before.pages[1]?.rows.map(keyOf));
          // And the list drawn is every remaining item, once, in order.
          const joined = joinPages(after.pages as Loadable<InboxListPage>[]);
          const shown = joined.rows.map(keyOf);
          expect(new Set(shown).size).toBe(shown.length);
          expect(shown).not.toContain(keyOf(decided));
          const expected = rest.map(keyOf).slice(0, shown.length);
          expect(shown).toEqual(expected);
        },
      ),
    );
  });
});
