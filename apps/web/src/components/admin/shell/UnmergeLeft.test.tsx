import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';

/**
 * The unmerge's line, from `unmerge.receipt`: moving while its pages land, the count of what stayed
 * once the last one has, and nothing to add when every row went back or the read failed.
 */

const mocks = vi.hoisted(() => ({ receipt: undefined as unknown, args: undefined as unknown }));
vi.mock('../reads/consoleReads', async (original) => ({
  ...(await original<typeof import('../reads/consoleReads')>()),
  useConsoleReadSet: (specs: { receipt: { args: unknown } }) => {
    mocks.args = specs.receipt.args;
    return {
      reads: { receipt: mocks.receipt },
      retry: () => {},
      live: true,
      failed: false,
      pending: false,
    };
  },
}));

const { UnmergeLeft, UnmergeLeftView, unmergeLeftLine } = await import('./UnmergeLeft');

const answer = (done: boolean, count: number) => ({
  unmergeActionId: 'u1' as never,
  done,
  left: { count, byKind: count > 0 ? { reports: count } : {}, rows: [] },
});

beforeEach(() => {
  mocks.receipt = undefined;
});

describe('unmergeLeftLine', () => {
  it('says nothing before the unmerge’s row is there', () => {
    expect(unmergeLeftLine(undefined)).toBeNull();
    expect(unmergeLeftLine(null)).toBeNull();
  });

  it('says it is moving rows back while its pages land, with what stayed so far', () => {
    expect(unmergeLeftLine(answer(false, 0))).toBe(MW.unmerging);
    expect(unmergeLeftLine(answer(false, 2))).toBe(`${MW.unmerging} · ${MW.leftSince(2)}`);
  });

  it('says what stayed once it is done, or that every row went back', () => {
    expect(unmergeLeftLine(answer(true, 1))).toBe(
      '1 row had changed since the merge and stays where it is',
    );
    expect(unmergeLeftLine(answer(true, 1200))).toBe(
      '1,200 rows had changed since the merge and stay where they are',
    );
    expect(unmergeLeftLine(answer(true, 0))).toBe('Every row went back');
  });
});

describe('UnmergeLeftView', () => {
  it('draws the line, or the fallback until the unmerge’s row is read', () => {
    const { rerender } = render(<UnmergeLeftView receipt={answer(true, 3)} fallback="usual" />);
    expect(screen.getByText(MW.leftSince(3))).toBeInTheDocument();
    rerender(<UnmergeLeftView receipt={null} fallback="usual" />);
    expect(screen.getByText('usual')).toBeInTheDocument();
  });
});

describe('UnmergeLeft', () => {
  it('reads the merge’s unmerge, live', () => {
    mocks.receipt = answer(false, 0);
    const { rerender } = render(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(mocks.args).toEqual({ mergeActionId: 'ma1' });
    expect(screen.getByText(MW.unmerging)).toBeInTheDocument();
    mocks.receipt = answer(true, 4);
    rerender(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(screen.getByText(MW.leftSince(4))).toBeInTheDocument();
  });

  it('draws the fallback when the read fails — the unmerge landed all the same', async () => {
    mocks.receipt = (await import('../reads/consoleReads')).retryAll([]);
    render(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(screen.getByText('usual')).toBeInTheDocument();
  });
});
