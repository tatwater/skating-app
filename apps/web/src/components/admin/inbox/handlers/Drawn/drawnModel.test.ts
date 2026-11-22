import { MERGE_SUGGEST_SHARE } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { CASPIAN } from '../../list/inboxFixtures';
import {
  BARE_SKATE,
  BELOW_THRESHOLD,
  DRAWER_GONE,
  DRAWN_BY_VIEWER,
  DRAWN_DECIDED,
  DRAWN_FIXTURES,
  DRAWN_MERGED,
  DRAWN_NOW,
  DRAWN_UNMERGING,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
  OVER_MOREY,
} from './drawnFixtures';
import {
  type DrawnItem,
  drawnBar,
  hasBar,
  headLine,
  MERGE_PERCENT,
  mergeRows,
  refusalSaid,
  standingLine,
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
    expect(drawnBar(OVER_CASPIAN)).toEqual({
      merge: { waterBodyId: CASPIAN.waterBodyId, name: 'Caspian Lake' },
      approve: true,
      reject: true,
    });
  });

  it('names the server’s survivor — the item’s overlap — never the drawing itself', () => {
    expect(drawnBar(OVER_MOREY).merge).toEqual({
      waterBodyId: OVER_MOREY.overlap?.body.waterBodyId,
      name: 'Lake Morey',
    });
    expect(drawnBar(OVER_MOREY).merge?.waterBodyId).not.toBe(OVER_MOREY.body.waterBodyId);
  });

  it('draws no lever once merged (or otherwise decided)', () => {
    expect(hasBar(drawnBar(DRAWN_MERGED))).toBe(false);
    expect(refusalSaid(DRAWN_MERGED)).toBeNull();
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

  it('says a merge held back mid-unmerge from its code, whatever else the bar holds', () => {
    const bar = drawnBar(DRAWN_UNMERGING);
    expect(bar).toMatchObject({ merge: null, approve: true, reject: true });
    expect(refusalSaid(DRAWN_UNMERGING)).toBe(
      'This body is still being unmerged. Merge it once that finishes.',
    );
    // The code, never the words: the same sentence uncoded says nothing while levers are drawn.
    expect(refusalSaid({ ...DRAWN_UNMERGING, canCode: {} })).toBeNull();
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
  it('says what moves, as the board does: the report, the skate, the drawer told, the drawing', () => {
    expect(mergeRows(OVER_CASPIAN, 'Caspian Lake')).toEqual([
      { label: 'Report', value: 'Re-homed · stays visible' },
      { label: 'Skate', value: 'Kept · moves with it' },
      { label: 'Skater', value: 'Told it was merged' },
      { label: 'Drawing', value: 'Points at Caspian Lake' },
    ]);
  });

  it('names only what the item serves: no report, no skate, no one gone to tell', () => {
    expect(mergeRows(BARE_SKATE, 'Caspian Lake').map((r) => r.label)).toEqual([
      'Skate',
      'Skater',
      'Drawing',
    ]);
    expect(mergeRows({ ...OVER_CASPIAN, skate: null }, 'Caspian Lake').map((r) => r.label)).toEqual(
      ['Report', 'Skater', 'Drawing'],
    );
    // A drawer gone or being deleted: no one to tell, and never named.
    expect(mergeRows(DRAWER_GONE, 'Caspian Lake').map((r) => r.label)).toEqual([
      'Report',
      'Skate',
      'Drawing',
    ]);
    expect(mergeRows({ ...OVER_CASPIAN, drawer: null }, 'X').map((r) => r.label)).not.toContain(
      'Skater',
    );
  });

  it('keeps the below-threshold item’s share as the server sent it', () => {
    expect((BELOW_THRESHOLD as DrawnItem).overlap?.share).toBe(0.41);
    expect((BELOW_THRESHOLD as DrawnItem).overlap?.suggested).toBe(false);
  });
});

describe('the drawer’s standing and the skate', () => {
  it('adds the drawer’s reports to their standing; a count not given adds nothing', () => {
    expect(standingLine(OVER_CASPIAN.drawer, 14)).toBe('Trusted · 41 pts · 14 reports');
    expect(standingLine(OVER_CASPIAN.drawer, 1)).toBe('Trusted · 41 pts · 1 report');
    expect(standingLine(OVER_CASPIAN.drawer, 0)).toBe('Trusted · 41 pts · 0 reports');
    expect(standingLine(OVER_CASPIAN.drawer, null)).toBe('Trusted · 41 pts');
    // A departed drawer: no standing, and no count either.
    expect(standingLine(DRAWER_GONE.drawer, 14)).toBe('Not shown for a former skater');
  });
});
