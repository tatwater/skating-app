import { describe, expect, it } from 'vitest';

import { bountiesTotalSub, bountiesTotalWords, vantageLine } from './eachDayWords';

const v = (on_ice: number, shore: number, secondhand: number, unstated = 0) => ({
  on_ice,
  shore,
  secondhand,
  unstated,
});

describe('the Reports row’s vantage line', () => {
  it('says the board’s sentence when every report is from shore', () => {
    expect(vantageLine(v(0, 14, 0))).toBe('All from shore · none on the ice yet');
  });

  it('names each vantage with a report, in the app’s one order, and never ranks them', () => {
    expect(vantageLine(v(2, 11, 1))).toBe('2 on the ice · 11 from shore · 1 secondhand');
    expect(vantageLine(v(0, 3, 1))).toBe('3 from shore · 1 secondhand · none on the ice yet');
    expect(vantageLine(v(5, 0, 0))).toBe('All on the ice');
    expect(vantageLine(v(0, 0, 2))).toBe('All secondhand · none on the ice yet');
    expect(vantageLine(v(1, 0, 0, 2))).toBe('1 on the ice · 2 not stated');
    expect(vantageLine(v(0, 0, 0, 2))).toBe('2 not stated · none on the ice yet');
  });

  it('says nothing with no reports', () => {
    expect(vantageLine(v(0, 0, 0))).toBeNull();
  });
});

describe('the bounties total', () => {
  it('reads posted, then fulfilled', () => {
    expect(bountiesTotalWords(1200, 3)).toBe('1,200 posted · 3 fulfilled');
    expect(bountiesTotalSub(0)).toBe('Posted · 0 fulfilled');
  });

  it('says a total not recorded as not recorded, never a zero', () => {
    expect(bountiesTotalSub(null)).toBe('Posted · fulfilled not recorded yet');
    expect(bountiesTotalWords(null, 1)).toBe('Posted not recorded yet · 1 fulfilled');
    expect(bountiesTotalWords(2, null)).toBe('2 posted · fulfilled not recorded yet');
  });
});
