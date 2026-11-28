import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_MAX,
  attemptOf,
  granuleOf,
  runsTabOf,
  validateImagerySearch,
} from './imagerySearch';

const GRANULE = 'k00000000000000000000000000000001';

describe('Machinery › Imagery’s search', () => {
  it('keeps a granule, its attempt and a drawer tab, and drops everything else', () => {
    expect(
      validateImagerySearch({ granule: GRANULE, attempt: 2, runs: 'pump', run: 'x', q: 'y' }),
    ).toEqual({ granule: GRANULE, attempt: 2, runs: 'pump' });
    expect(validateImagerySearch({})).toEqual({});
  });

  it('drops an attempt without a granule', () => {
    expect(validateImagerySearch({ attempt: 2, runs: 'poll' })).toEqual({ runs: 'poll' });
  });

  it('takes a granule id trimmed, and an attempt as a number or its digits', () => {
    expect(granuleOf(` ${GRANULE} `)).toBe(GRANULE);
    expect(attemptOf('3')).toBe(3);
    expect(attemptOf(' 1 ')).toBe(1);
    expect(attemptOf(ATTEMPT_MAX)).toBe(ATTEMPT_MAX);
  });

  it.each([
    ['not a string', 12],
    ['an uppercase id', GRANULE.toUpperCase()],
    ['too short', 'k123'],
    ['a path', `${GRANULE}/x`],
  ])('drops a granule that is %s', (_why, raw) => {
    expect(granuleOf(raw)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['too high', ATTEMPT_MAX + 1],
    ['words', 'two'],
    ['a signed string', '+2'],
    ['absent', undefined],
  ])('drops an attempt that is %s', (_why, raw) => {
    expect(attemptOf(raw)).toBeNull();
  });

  it.each([['runs'], ['Poll'], [3], [null]])('drops a tab %s', (raw) => {
    expect(runsTabOf(raw)).toBeNull();
  });

  it('knows the three tabs', () => {
    expect(['poll', 'pump', 'index'].map(runsTabOf)).toEqual(['poll', 'pump', 'index']);
  });
});
