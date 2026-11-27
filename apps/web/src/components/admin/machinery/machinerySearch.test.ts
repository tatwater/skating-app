import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_MAX_CHARS,
  campaignOf,
  isOpen,
  placeOf,
  runOf,
  searchOf,
  validateMachinerySearch,
} from './machinerySearch';

const RUN = 'k00000000000000000000000000000001';

describe('Machinery › Corpus’s search', () => {
  it('keeps a campaign id and a run id, and drops everything else', () => {
    expect(
      validateMachinerySearch({ campaign: 'a07a-20261012', run: RUN, lane: 'x', q: 'load' }),
    ).toEqual({ campaign: 'a07a-20261012', run: RUN });
    expect(validateMachinerySearch({})).toEqual({});
  });

  it('takes the ids the script and the server write, trimmed', () => {
    expect(campaignOf(' machinery-check ')).toBe('machinery-check');
    expect(campaignOf('a07a_2026.10.12')).toBe('a07a_2026.10.12');
    expect(runOf(` ${RUN} `)).toBe(RUN);
  });

  it.each([
    ['not a string', 7],
    ['empty', ''],
    ['a leading dash', '-a07a'],
    ['a slash', 'a07a/../x'],
    ['a space inside', 'a07a 2026'],
    ['too long', 'a'.repeat(CAMPAIGN_MAX_CHARS + 1)],
  ])('drops a campaign that is %s', (_why, raw) => {
    expect(campaignOf(raw)).toBeNull();
    expect(validateMachinerySearch({ campaign: raw })).toEqual({});
  });

  it('takes a campaign at the longest the URL holds', () => {
    expect(campaignOf('a'.repeat(CAMPAIGN_MAX_CHARS))).toHaveLength(CAMPAIGN_MAX_CHARS);
  });

  it.each([
    ['not a string', 12],
    ['an uppercase id', RUN.toUpperCase()],
    ['too short', 'k123'],
    ['a path', `${RUN}/x`],
  ])('drops a run that is %s', (_why, raw) => {
    expect(runOf(raw)).toBeNull();
  });

  it('round-trips a place, defaults left out, and says when something is open', () => {
    const place = placeOf({ campaign: 'a07a-20261012' });
    expect(place).toEqual({ campaign: 'a07a-20261012', run: null });
    expect(searchOf(place)).toEqual({ campaign: 'a07a-20261012' });
    expect(searchOf({ campaign: null, run: null })).toEqual({});
    expect(isOpen(place)).toBe(true);
    expect(isOpen({ campaign: null, run: RUN })).toBe(true);
    expect(isOpen({ campaign: null, run: null })).toBe(false);
    // A hand-built place is checked again on the way out of the URL.
    expect(placeOf({ campaign: 'bad id', run: 'nope' })).toEqual({ campaign: null, run: null });
  });
});
