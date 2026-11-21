import { describe, expect, it } from 'vitest';

import { DELETED, page, STANDING } from './recordFixtures';
import type { StandingRow } from './recordModel';
import { joinRecordPages } from './recordReads';

const failed = { failed: true as const, pending: false, retry: () => {} };
const [a, b, c] = STANDING as [StandingRow, StandingRow, StandingRow];

describe('joining a list’s pages', () => {
  it('is unread when no read is made, loading until the first page, fetching after', () => {
    expect(joinRecordPages(null)).toMatchObject({ status: 'unread', rows: [], failed: false });
    expect(joinRecordPages([undefined]).status).toBe('loading');
    const first = page([a], { isDone: false });
    expect(joinRecordPages([first, undefined])).toMatchObject({ status: 'fetching', rows: [a] });
    expect(joinRecordPages([first]).status).toBe('more');
  });

  it('draws each item once, in the chain’s order, and is done only when the last page says so', () => {
    const joined = joinRecordPages([page([a, b], { isDone: false }), page([b, c])]);
    expect(joined.rows).toEqual([a, b, c]);
    expect(joined.status).toBe('done');
  });

  it('a short page — even an empty one — is not the end', () => {
    expect(joinRecordPages([page([], { isDone: false })]).status).toBe('more');
  });

  it('any page still being prepared makes the list so', () => {
    expect(
      joinRecordPages([page([a], { isDone: false }), page([b], { pending: true })]).pending,
    ).toBe(true);
    expect(joinRecordPages([page(DELETED)]).pending).toBe(false);
    // The Deleted list rests on its withdrawal rows too: that backfill alone is "still being prepared".
    const withdrawals = { ...page(DELETED), pending: ['withdrawals'] as unknown as [] };
    expect(joinRecordPages([withdrawals]).pending).toBe(true);
  });

  it('stops at a failed page, keeping the rows before it', () => {
    expect(joinRecordPages([page([a], { isDone: false }), failed, page([b])])).toMatchObject({
      status: 'error',
      failed: true,
      rows: [a],
    });
  });
});

describe('a page the server says must be split', () => {
  it('draws its rows and nothing after them until the halves land', () => {
    const split = {
      ...page([a], { isDone: false, cursor: 'end' }),
      pageStatus: 'SplitRequired',
      splitCursor: 's',
    };
    const joined = joinRecordPages([split, page([c])]);
    expect(joined).toMatchObject({ status: 'fetching', rows: [a] });
  });
});
