import { describe, expect, it } from 'vitest';
import { searchQueryArg } from './lakeSearch';

describe('searchQueryArg', () => {
  it("returns 'skip' below the 2-char floor (after trimming)", () => {
    expect(searchQueryArg('')).toBe('skip');
    expect(searchQueryArg('a')).toBe('skip');
    expect(searchQueryArg('  x ')).toBe('skip');
    expect(searchQueryArg('   ')).toBe('skip');
  });

  it('trims and builds the query arg at 2+ chars', () => {
    expect(searchQueryArg('  morey ')).toEqual({ query: 'morey', limit: 8 });
    expect(searchQueryArg('george', 5)).toEqual({ query: 'george', limit: 5 });
  });
});
