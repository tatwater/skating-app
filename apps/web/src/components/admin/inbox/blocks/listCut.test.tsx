import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { countedLike, ListCutLine, listCount, listTotalOf, shownLine } from './listCut';

const open = { status: 'open' as const };
const closed = { status: 'closed' as const };
const total = (count: number, floor = false, cut = false) => ({ count, floor, cut });

describe('a member list served short', () => {
  it('counts what it shows as the item counts: the open ones while any is open, else all', () => {
    expect(countedLike([open, open, closed])).toBe(2);
    expect(countedLike([closed, closed])).toBe(2);
    expect(countedLike([])).toBe(0);
  });

  it('says nothing while the list is whole', () => {
    expect(shownLine(2, total(2), 'asks')).toBeNull();
    expect(listCount(2, total(2))).toBe(2);
  });

  it('says how many of how many past a page, a floor past the count', () => {
    expect(shownLine(50, total(51), 'flags')).toBe('Showing 50 of 51 flags');
    expect(shownLine(50, total(500, true), 'asks')).toBe('Showing 50 of 500+ asks');
    expect(listCount(50, total(500, true))).toEqual({ count: 500, capped: true });
  });

  it('says it when the server cut the list, even where the counts would read whole', () => {
    expect(shownLine(1, total(1, false, true), 'reports')).toBe('Showing 1 of 1 report');
    expect(listCount(3, total(3, false, true))).toEqual({ count: 3, capped: false });
  });

  it('takes the item’s count and the list’s own cut flag', () => {
    expect(listTotalOf({ memberCount: 500, memberCountIsFloor: true }, true)).toEqual(
      total(500, true, true),
    );
  });

  it('draws its line only under a list served short', () => {
    const { rerender } = render(
      <ListCutLine members={[open, closed]} total={total(1)} noun="reports" />,
    );
    expect(screen.queryByText(/Showing/)).toBeNull();
    rerender(<ListCutLine members={[open, closed]} total={total(9)} noun="reports" />);
    expect(screen.getByText('Showing 1 of 9 reports')).toBeInTheDocument();
  });
});
