import { MERGE_SUGGEST_SHARE } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  BELOW_THRESHOLD,
  DRAWER_GONE,
  DRAWN_BY_VIEWER,
  DRAWN_DECIDED,
  DRAWN_FIXTURES,
  DRAWN_NOW,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
} from './drawnFixtures';
import {
  type DrawnItem,
  drawnBar,
  hasBar,
  headLine,
  MERGE_PERCENT,
  mergeRows,
  refusalSaid,
  trustLine,
} from './drawnModel';

/** Board 2.5 as data: the bar from `can` alone, the head, the trust line, the merge block. */

describe('the bar, from the item’s can alone', () => {
  // Every fixture × its viewer: a lever is drawn exactly when its verb answers `null`.
  const verbs = { approve: 'approveDrawn', reject: 'rejectDrawn', merge: 'mergeDrawn' } as const;
  for (const [name, item] of Object.entries(DRAWN_FIXTURES)) {
    it(`${name}: draws each lever exactly when its verb is allowed`, () => {
      const bar = drawnBar(item);
      for (const [lever, verb] of Object.entries(verbs)) {
        const allowed = verb in item.can && item.can[verb] === null;
        const drawn = lever === 'merge' ? bar.merge !== null : bar[lever as 'approve' | 'reject'];
        // Merge also needs a body to merge into.
        expect(drawn, `${name} · ${lever}`).toBe(
          lever === 'merge' ? allowed && item.overlap !== null : allowed,
        );
      }
    });
  }

  it('draws the board’s three: Merge into Caspian Lake, Approve, Reject', () => {
    expect(drawnBar(OVER_CASPIAN)).toEqual({ merge: 'Caspian Lake', approve: true, reject: true });
  });

  it('draws no merge for a moderator the server refuses it', () => {
    expect(drawnBar(MODERATOR_VIEW)).toEqual({ merge: null, approve: true, reject: true });
  });

  it('draws no merge over no body, even were the verb allowed', () => {
    expect(
      drawnBar({ ...NEW_WATER, can: { ...NEW_WATER.can, mergeDrawn: null } }).merge,
    ).toBeNull();
  });

  it('draws nothing for a verb absent from can', () => {
    expect(hasBar(drawnBar({ ...OVER_CASPIAN, can: {} }))).toBe(false);
  });

  it('draws nothing for the viewer’s own drawing, and says why once', () => {
    expect(hasBar(drawnBar(DRAWN_BY_VIEWER))).toBe(false);
    expect(refusalSaid(DRAWN_BY_VIEWER)).toBe(
      'You filed this, so another staff member decides it.',
    );
  });

  it('says no refusal while any lever is drawn, for a decided item, or with nothing refused', () => {
    expect(refusalSaid(MODERATOR_VIEW)).toBeNull();
    expect(refusalSaid(DRAWN_DECIDED)).toBeNull();
    expect(refusalSaid({ ...OVER_CASPIAN, can: {} })).toBeNull();
  });
});

describe('the head', () => {
  it('says where it came from and its age', () => {
    expect(headLine(OVER_CASPIAN, DRAWN_NOW)).toBe('From a recorded skate · 2 hours ago');
    expect(headLine(NEW_WATER, DRAWN_NOW)).toBe('Drawn by a skater · 2 hours ago');
  });
});

describe('the gauge’s threshold and the drawer', () => {
  it('reads the threshold from core', () => {
    expect(MERGE_PERCENT).toBe(Math.round(MERGE_SUGGEST_SHARE * 100));
    expect(MERGE_PERCENT).toBe(80);
  });

  it('gives a drawer’s standing, and none for a departed one', () => {
    expect(trustLine(OVER_CASPIAN.drawer)).toBe('Trusted · 41 pts');
    expect(trustLine(DRAWER_GONE.drawer)).toBe('Not shown for a former skater');
    expect(trustLine(null)).toBe('Not shown for a former skater');
  });
});

describe('the merge block', () => {
  it('says what a merge does — never that it can be done here', () => {
    const rows = mergeRows('Caspian Lake');
    expect(rows).toEqual([
      { label: 'Report', value: 'Re-homed · stays visible' },
      { label: 'Drawing', value: 'Points at Caspian Lake' },
    ]);
    for (const r of rows) expect(r.value).not.toMatch(/press|click|merge it|here/i);
  });

  it('keeps the below-threshold item’s share as the server sent it', () => {
    expect((BELOW_THRESHOLD as DrawnItem).overlap?.share).toBe(0.41);
    expect((BELOW_THRESHOLD as DrawnItem).overlap?.suggested).toBe(false);
  });
});
