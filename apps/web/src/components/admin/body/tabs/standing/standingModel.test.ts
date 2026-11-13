import { INACTIVE_SEASONS, retentionReason, seasonOf, seasonStartMs } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BODY_NOW, MASCOMA_RETENTION, MASCOMA_RETENTION_WIRED } from './standingFixtures';
import {
  activityHoldsThrough,
  activityLapsesAt,
  RETENTION_YEARS,
  type RetentionFacts,
  retentionModel,
  rolloversBetween,
  seasonWord,
} from './standingModel';

// Any instant from 2000 to 2100.
const instant = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) });

const NONE: RetentionFacts = {
  lastActivity: undefined,
  curatedBoost: undefined,
  favorites: 0,
  savedPutIns: 0,
};

describe('the activity lane agrees with the rollover rule', () => {
  it('holds into exactly the seasons core retains it for, and lapses at the next 1 July', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: -2, max: 8 }), (at, ahead) => {
        const season = seasonOf(at) + ahead;
        const retained =
          retentionReason({ lastActivityAt: at, favorited: false, hasPutIn: false }, season) ===
          'activity';
        // Retained into every season up to `holdsThrough`, never past it.
        expect(retained).toBe(season <= activityHoldsThrough(at));
      }),
    );
  });

  it('lapses on a 1 July UTC rollover, after the activity, inside the window plus one', () => {
    fc.assert(
      fc.property(instant, (at) => {
        const lapses = activityLapsesAt(at);
        const d = new Date(lapses);
        expect([d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()]).toEqual([6, 1, 0]);
        expect(lapses).toBeGreaterThan(at);
        expect(seasonOf(lapses)).toBe(seasonOf(at) + INACTIVE_SEASONS + 1);
        // The instant before the rollover is still in the last season it holds through.
        expect(seasonOf(lapses - 1)).toBe(activityHoldsThrough(at));
      }),
    );
  });

  it('a report on 10 Oct 2026 holds through 2029–30 and stops at the 1 Jul 2030 rollover', () => {
    const at = Date.UTC(2026, 9, 10, 16);
    expect(seasonWord(activityHoldsThrough(at))).toBe('2029–30');
    expect(activityLapsesAt(at)).toBe(Date.UTC(2030, 6, 1));
  });
});

describe('rolloversBetween', () => {
  it('is every 1 July after the start, up to the end', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 0, max: 10 }), (start, years) => {
        const end = start + years * 365.25 * 86_400_000;
        const all = rolloversBetween(start, end);
        for (const r of all) {
          expect(r).toBeGreaterThan(start);
          expect(r).toBeLessThanOrEqual(end);
          expect(r).toBe(seasonStartMs(seasonOf(r)));
        }
        // None skipped: consecutive seasons.
        all.forEach((r, i) => {
          if (i > 0) expect(seasonOf(r)).toBe(seasonOf(all[i - 1] as number) + 1);
        });
        // The first is the next season's start.
        if (all.length > 0) expect(all[0]).toBe(seasonStartMs(seasonOf(start) + 1));
      }),
    );
  });

  it('crosses the rollover at the UTC boundary, whatever the zone', () => {
    // 30 June 23:59 UTC is still the old season; one minute later is the new one.
    const before = Date.UTC(2027, 5, 30, 23, 59);
    expect(rolloversBetween(before, before + 60_000)).toEqual([Date.UTC(2027, 6, 1)]);
    expect(rolloversBetween(Date.UTC(2027, 6, 1), Date.UTC(2027, 6, 2))).toEqual([]);
  });
});

describe('retentionModel', () => {
  it('draws the board: boost, favorites and put-ins hold; the report ends at 1 Jul 2030', () => {
    const model = retentionModel(MASCOMA_RETENTION, BODY_NOW);
    expect(model.lanes.map((l) => [l.label, l.value, l.end])).toEqual([
      ['Map boost', '0.3 · 19 Sep', null],
      ['Favorites', '9 skaters', null],
      ['Saved put-ins', '3 put-ins', null],
      ['On the water', '10 Oct · a report', Date.UTC(2030, 6, 1)],
    ]);
    expect(model.rollovers.map((r) => r.label)).toEqual(['2027', '2028', '2029', '2030']);
    expect(model.foot).toBe('Any one keeps it. The report alone holds through 2029–30.');
    expect(model.notRecorded).toBeNull();
    expect(model.end - model.start).toBeCloseTo(RETENTION_YEARS * 365.25 * 86_400_000);
  });

  it('never draws a reason that is not held, and never zero for one not read', () => {
    const wired = retentionModel(MASCOMA_RETENTION_WIRED, BODY_NOW);
    expect(wired.lanes.map((l) => l.key)).toEqual(['curated', 'put_in']);
    expect(wired.notRecorded).toBe('favorites and the last report');
    expect(wired.foot).toBe('Any one keeps it.');
  });

  it('says nothing holds only when every reason was read', () => {
    const none = retentionModel(NONE, BODY_NOW);
    expect(none.lanes).toEqual([]);
    expect(none.foot).toBe('Nothing keeps it: the 1 Jul 2027 rollover sets it dormant.');
    const unread = retentionModel({ ...NONE, favorites: null }, BODY_NOW);
    expect(unread.foot).toBe('');
    expect(unread.notRecorded).toBe('favorites');
  });

  it('an old report draws no lane; a report alone says how long it holds', () => {
    const old = retentionModel(
      { ...NONE, lastActivity: { at: Date.UTC(2021, 0, 5), kind: 'track' } },
      BODY_NOW,
    );
    expect(old.lanes).toEqual([]);
    const alone = retentionModel(
      { ...NONE, lastActivity: { at: Date.UTC(2025, 1, 5), kind: 'hazard' } },
      BODY_NOW,
    );
    expect(alone.lanes.map((l) => l.key)).toEqual(['activity']);
    expect(alone.foot).toBe('The hazard keeps it through 2027–28.');
    expect(alone.lanes[0]?.endLabel).toBe('Until the 1 Jul 2028 rollover');
  });

  it('a boost with no date shows the value alone; a zero or negative boost holds nothing', () => {
    expect(
      retentionModel({ ...NONE, curatedBoost: { value: 0.5, at: null } }, BODY_NOW).lanes[0]?.value,
    ).toBe('0.5');
    expect(
      retentionModel({ ...NONE, curatedBoost: { value: -0.2, at: null } }, BODY_NOW).lanes,
    ).toEqual([]);
    expect(
      retentionModel({ ...NONE, favorites: 1, savedPutIns: 1 }, BODY_NOW).lanes.map((l) => l.value),
    ).toEqual(['1 skater', '1 put-in']);
    expect(retentionModel({ ...NONE, curatedBoost: null }, BODY_NOW).notRecorded).toBe(
      'the map boost',
    );
  });

  it('every lane ends inside the window or runs off it', () => {
    fc.assert(
      fc.property(instant, instant, (now, at) => {
        fc.pre(at <= now);
        const model = retentionModel({ ...NONE, lastActivity: { at, kind: 'report' } }, now);
        for (const lane of model.lanes) {
          if (lane.end !== null) {
            expect(lane.end).toBeGreaterThan(now);
            expect(lane.end).toBeLessThanOrEqual(model.end);
          }
        }
      }),
    );
  });
});
