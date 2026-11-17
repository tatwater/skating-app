import { describe, expect, it } from 'vitest';
import { KATE, LUC, page, ROB } from './peopleFixtures';
import { joinPages } from './peopleReads';

const failed = { failed: true as const, pending: false, retry: () => {} };

describe('joining the pages', () => {
  it('is unread when no read is made', () => {
    expect(joinPages(null)).toMatchObject({ status: 'unread', rows: [], failed: false });
  });

  it('is loading until the first page lands, and fetching while a later one is on its way', () => {
    expect(joinPages([undefined]).status).toBe('loading');
    const first = { ...page([KATE], { isDone: false }), continueCursor: 'c1' };
    expect(joinPages([first, undefined])).toMatchObject({ status: 'fetching', rows: [KATE] });
    expect(joinPages([first]).status).toBe('more');
  });

  it('draws each person once, in the chain’s order, and joins every page’s reasons and pending', () => {
    const a = { ...page([KATE, LUC], { isDone: false }), reasons: ['flags_capped' as const] };
    const b = { ...page([LUC, ROB]), pending: ['flagSubjects' as const, 'rows' as const] };
    const joined = joinPages([a, b]);
    expect(joined.rows.map((r) => r.username)).toEqual(['kdonovan', 'lpelletier', 'rtremblay']);
    expect(joined.reasons).toEqual(['flags_capped']);
    // In the registry's order, whatever order the server gave them in.
    expect(joined.pending).toEqual(['rows', 'flagSubjects']);
    expect(joined.status).toBe('done');
  });

  it('stops at a failed page, keeping the rows before it', () => {
    const first = page([KATE], { isDone: false });
    expect(joinPages([first, failed, page([ROB])])).toMatchObject({
      status: 'error',
      failed: true,
      rows: [KATE],
    });
    expect(joinPages([failed])).toMatchObject({ status: 'error', rows: [] });
  });

  it('draws a page the server says must be split up to its rows, and nothing after it yet', () => {
    const first = { ...page([KATE], { isDone: false }), pageStatus: 'SplitRequired' };
    const joined = joinPages([first, page([ROB])]);
    expect(joined).toMatchObject({ status: 'fetching', rows: [KATE], failed: false });
  });
});
