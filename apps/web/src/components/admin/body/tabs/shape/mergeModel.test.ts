import { describe, expect, it } from 'vitest';

import {
  MERGE_HEAVY,
  MERGE_NOTHING_MOVES,
  MERGE_REFUSED,
  MERGE_TO_CRYSTAL,
  MERGE_UNMERGING,
} from './mergeFixtures';
import { consequenceRows, countText, mergeVerdict, moveRows } from './mergeModel';
import { MERGE_WORDS as W } from './mergeWords';

/** The merge preview as data: what moves, what it runs into, and whether it may be confirmed. */

describe('what moves', () => {
  it('lists each kind that moves anything, in the preview’s order, a floor drawn as one', () => {
    expect(moveRows(MERGE_TO_CRYSTAL.moves)).toEqual([
      { label: 'Reports', value: '3' },
      { label: 'Hazards', value: '1' },
      { label: 'Put-ins', value: '1' },
      { label: 'Favorites', value: '2' },
      { label: 'Requests', value: '1' },
      { label: 'Bays', value: '2' },
      { label: 'Landmarks', value: '1' },
      { label: 'Skates', value: '1' },
    ]);
    expect(moveRows(MERGE_HEAVY.moves)[0]).toEqual({ label: 'Reports', value: '1,000+' });
  });

  it('lists nothing when nothing moves', () => {
    expect(moveRows(MERGE_NOTHING_MOVES.moves)).toEqual([]);
  });

  it('draws a capped count as the floor it is, never a total', () => {
    expect(countText({ count: 200, capped: true })).toBe('200+');
    expect(countText({ count: 1_234, capped: false })).toBe('1,234');
    // A capped zero is still a floor the read stopped at: drawn, never dropped.
    expect(moveRows({ ...MERGE_NOTHING_MOVES.moves, flags: { count: 0, capped: true } })).toEqual([
      { label: 'Flags', value: '0+' },
    ]);
  });
});

describe('what the merge runs into', () => {
  it('says favorites kept once, the bays delisted, the lists against their caps, what stays', () => {
    expect(consequenceRows(MERGE_TO_CRYSTAL)).toEqual([
      { label: 'Kept once', value: '1 favorite already on Crystal Lake' },
      { label: 'Delisted', value: 'West cove · Crystal Lake has a bay by that name' },
      { label: 'Lists', value: 'Pins 3 of 10 · Aliases 4 of 20 · Links 2 of 10' },
      { label: 'Stays here', value: '1 access alert · 2 linked lots' },
    ]);
  });

  it('says only what is there: the lists always, nothing else when nothing else applies', () => {
    expect(consequenceRows(MERGE_NOTHING_MOVES).map((r) => r.label)).toEqual(['Lists']);
    const two = {
      ...MERGE_TO_CRYSTAL,
      baysClashing: { names: ['West cove', 'North arm'], capped: false },
    };
    expect(consequenceRows(two)[1]?.value).toBe(
      'West cove, North arm · Crystal Lake has a bay by each name',
    );
  });

  it('draws every value the server cut at its bound as a floor, a capped name list as “…and more”', () => {
    const at = { count: 200, capped: true };
    const capped = {
      ...MERGE_TO_CRYSTAL,
      favoritesDeduped: at,
      baysClashing: { names: ['West cove'], capped: true },
      staysBehind: { accessAlerts: at, parkingLots: at },
    };
    expect(consequenceRows(capped)).toEqual([
      { label: 'Kept once', value: '200+ favorites already on Crystal Lake' },
      { label: 'Delisted', value: 'West cove …and more · Crystal Lake has a bay by each name' },
      { label: 'Lists', value: 'Pins 3 of 10 · Aliases 4 of 20 · Links 2 of 10' },
      { label: 'Stays here', value: '200+ access alerts · 200+ linked lots' },
    ]);
    // A capped zero is a floor the read stopped at: drawn, never dropped; uncapped, exact.
    const zero = { count: 0, capped: true };
    const zeros = {
      ...MERGE_NOTHING_MOVES,
      favoritesDeduped: zero,
      staysBehind: { accessAlerts: zero, parkingLots: { count: 200, capped: false } },
    };
    expect(consequenceRows(zeros)).toEqual([
      { label: 'Kept once', value: '0+ favorites already on Crystal Lake' },
      { label: 'Lists', value: 'Pins 3 of 10 · Aliases 4 of 20 · Links 2 of 10' },
      { label: 'Stays here', value: '0+ access alerts · 200 linked lots' },
    ]);
  });
});

describe('whether it may be confirmed', () => {
  it('confirms only a preview that is ok and not too big', () => {
    expect(mergeVerdict(MERGE_TO_CRYSTAL)).toEqual({ confirm: true, said: null });
  });

  it('says the server’s refusal and offers no confirm', () => {
    expect(mergeVerdict(MERGE_REFUSED)).toEqual({
      confirm: false,
      said: 'Survivor is itself merged — pick the canonical body',
    });
  });

  it('says a merge held back mid-unmerge in the server’s sentence, and offers no confirm', () => {
    expect(mergeVerdict(MERGE_UNMERGING)).toEqual({
      confirm: false,
      said: 'This body is still being unmerged. Merge it once that finishes.',
    });
  });

  it('says a merge too heavy for one go, and offers no confirm', () => {
    expect(mergeVerdict(MERGE_HEAVY)).toEqual({ confirm: false, said: MERGE_HEAVY.refusal });
  });

  it('offers no confirm while the preview is on its way, and says nothing', () => {
    expect(mergeVerdict(undefined)).toEqual({ confirm: false, said: null });
    expect(mergeVerdict(null)).toEqual({ confirm: false, said: null });
  });
});

describe('an unmerge’s rows left where they were', () => {
  it('says how many, plainly, singular and plural', () => {
    expect(W.leftSince(1)).toBe('1 row had changed since the merge and stays where it is');
    expect(W.leftSince(1_204)).toBe(
      '1,204 rows had changed since the merge and stay where they are',
    );
  });
});
