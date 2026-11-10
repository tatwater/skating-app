import {
  HAZARD_TYPES,
  type HazardFreshness,
  NO_KNOWN_HAZARDS,
  UNREPORTED_HAZARDS_POSSIBLE,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BOARD_NOW_NH } from '@/test/boardNow';
import {
  areaFact,
  axisLine,
  depthFact,
  elevationFact,
  hazardListCopy,
  hazardRowModel,
  inViewSubLine,
  inViewTrailing,
  lakeFacts,
  lakeKicker,
  lakesCountLine,
  openBountiesLine,
  reportWhen,
  shapeRows,
} from './lakeModel';

const FT = 0.3048;
const ACRE = 4046.8564224;
const TZ = 'America/New_York';
// Saturday 16 January 2027, 11:52 AM in Enfield — the boards' "today".
const NOW = BOARD_NOW_NH;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the header facts', () => {
  it('reads depth as the pair, units with the values (Review 3)', () => {
    expect(
      depthFact({
        meanDepthM: 31 * FT,
        maxDepthM: 79 * FT,
        meanDepthSource: 'state_agency',
        maxDepthSource: 'state_agency',
      } as never),
    ).toEqual({ kicker: 'Depth avg / max', value: '31 / 79', unit: 'ft' });
  });

  it('says the half on file, and marks a modeled figure with ~', () => {
    expect(depthFact({ maxDepthM: 11 * FT, maxDepthSource: 'state_agency' } as never)).toEqual({
      kicker: 'Depth max',
      value: '11',
      unit: 'ft',
    });
    expect(depthFact({ meanDepthM: 20 * FT, meanDepthSource: 'globathy' } as never)?.value).toBe(
      '~20',
    );
    expect(depthFact({ meanDepthM: 20 * FT, meanDepthSource: 'globathy' } as never)?.kicker).toBe(
      'Depth avg',
    );
  });

  it('has no depth fact at all when nothing usable is on file', () => {
    expect(depthFact({})).toBeNull();
    expect(depthFact({ maxDepthM: 0, maxDepthSource: 'state_agency' } as never)).toBeNull();
    // A figure without a source isn't shown: an unattributed depth is a claim nobody made.
    expect(depthFact({ maxDepthM: 10 })).toBeNull();
  });

  it('reads area in whole acres and elevation in feet', () => {
    expect(areaFact(1143 * ACRE)).toEqual({ kicker: 'Area', value: '1,143', unit: 'ac' });
    expect(areaFact(0.2 * ACRE)?.value).toBe('1');
    expect(areaFact(undefined)).toBeNull();
    expect(elevationFact(748 * FT)).toEqual({ kicker: 'Elevation', value: '748', unit: 'ft' });
    expect(elevationFact(undefined)).toBeNull();
    expect(elevationFact(Number.NaN)).toBeNull();
  });

  it('orders the row area, depth, elevation, skipping what is missing', () => {
    expect(
      lakeFacts({ surfaceAreaSqM: 47 * ACRE, elevationM: 300 * FT }).map((f) => f.kicker),
    ).toEqual(['Area', 'Elevation']);
  });

  it('names the kind and the states over the name', () => {
    expect(lakeKicker('reservoir', ['NH'])).toBe('Reservoir · NH');
    expect(lakeKicker('bay', ['NH', 'VT'])).toBe('Bay · NH, VT');
    expect(lakeKicker('lakePond', undefined)).toMatch(/^[A-Z]/);
  });
});

describe('the In view list', () => {
  it('says what, how big, how deep', () => {
    expect(
      inViewSubLine({ type: 'lakePond', surfaceAreaSqM: 9 * ACRE, maxDepthM: 16 * FT }),
    ).toMatch(/ · 9 acres · 16 ft max$/);
    expect(inViewSubLine({ type: 'lakePond', surfaceAreaSqM: 0.4 * ACRE })).toMatch(/ · 1 acre$/);
    expect(inViewSubLine({ type: 'reservoir' })).toBe('Reservoir');
  });

  it('counts the latest day’s reports over its day', () => {
    expect(
      inViewTrailing([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * DAY], {
        now: NOW,
        inactive: false,
        timeZone: TZ,
      }),
    ).toEqual({
      kind: 'reports',
      count: '2 reports',
      when: 'Today',
    });
    expect(inViewTrailing([NOW - 4 * DAY], { now: NOW, inactive: false, timeZone: TZ })).toEqual({
      kind: 'reports',
      count: '1 report',
      when: 'Tuesday',
    });
  });

  it('never reads silence as anything but silence', () => {
    expect(inViewTrailing([], { now: NOW, inactive: false })).toEqual({
      kind: 'note',
      text: 'No recent reports',
    });
    expect(inViewTrailing([NOW], { now: NOW, inactive: true })).toEqual({
      kind: 'note',
      text: 'Inactive',
    });
  });

  it('counts bounties as bounties and lakes as lakes', () => {
    expect(openBountiesLine(1)).toBe('1 open bounty');
    expect(openBountiesLine(3)).toBe('3 open bounties');
    expect(lakesCountLine(1)).toBe('1 lake');
    expect(lakesCountLine(1200)).toBe('1,200 lakes');
  });
});

describe('the hazard list copy rule (D237)', () => {
  it('hazard list copy: populated → tooltip only, empty → full sentence', () => {
    fc.assert(
      fc.property(fc.nat(10_000), (count) => {
        const copy = hazardListCopy(count);
        // Exactly one of the two is ever shown: never silent, never said twice.
        expect((copy.tooltip === null) !== (copy.empty === null)).toBe(true);
        if (count > 0) {
          expect(copy).toEqual({ tooltip: UNREPORTED_HAZARDS_POSSIBLE, empty: null });
        } else {
          expect(copy).toEqual({ tooltip: null, empty: NO_KNOWN_HAZARDS });
        }
      }),
    );
  });

  it('uses the shared strings, word for word', () => {
    expect(hazardListCopy(1).tooltip).toBe(
      "It's possible there are unreported hazards on this ice.",
    );
    expect(hazardListCopy(0).empty).toMatch(
      /^No known hazards\. That does not mean the ice is safe/,
    );
  });
});

describe('a hazard row', () => {
  const base = {
    _id: 'h1',
    type: 'open_water' as const,
    freshness: 'fresh' as HazardFreshness,
    provisional: false,
    firstReportedAt: NOW - 2 * DAY,
    confirmCount: 2,
  };

  it('says where, when and who confirmed it', () => {
    const row = hazardRowModel({ ...base, subAreaName: 'Mascoma North' }, NOW);
    expect(row.title).toBe('Open water / lead');
    expect(row.line).toBe('Mascoma North · reported 2 days ago · confirmed by 2 skaters');
    expect(row.caveat).toBeNull();
    expect(row.older).toBe(false);
  });

  it('marks crossings, healing, disputes and unconfirmed pins', () => {
    expect(
      hazardRowModel(
        { ...base, type: 'ridge_crossing', healingState: 'disputed', provisional: true },
        NOW,
      ).tags,
    ).toEqual(['Crossing', 'Disputed', 'Unconfirmed']);
    expect(hazardRowModel({ ...base, healingState: 'healing_unsafe' }, NOW).tags).toEqual([
      'Healing',
    ]);
  });

  it('prefers the cluster’s confirmations and drops the clause when nobody confirmed', () => {
    expect(hazardRowModel({ ...base, clusterConfirmCount: 5 }, NOW).line).toMatch(
      /confirmed by 5 skaters$/,
    );
    expect(hazardRowModel({ ...base, confirmCount: 0 }, NOW).line).toBe('reported 2 days ago');
  });

  it('reads age as confidence, never as an all-clear (D3)', () => {
    const freshness = fc.constantFrom<HazardFreshness>('fresh', 'aging', 'stale');
    fc.assert(
      fc.property(fc.constantFrom(...HAZARD_TYPES), freshness, (type, f) => {
        const row = hazardRowModel({ ...base, type, freshness: f }, NOW);
        // An aged report keeps its row and gains its type's caveat — never loses its warning.
        if (f === 'fresh') expect(row.caveat).toBeNull();
        else expect(row.caveat).toEqual(expect.any(String));
        expect(row.older).toBe(f === 'stale');
        for (const text of [row.title, row.line, row.confidence, row.caveat ?? '']) {
          expect(text).not.toMatch(/\b(all clear|good to go|skateable)\b/i);
          expect(text).not.toMatch(/\bis safe\b/i);
        }
      }),
    );
  });
});

describe('About', () => {
  it('reads a long axis north-first', () => {
    expect(axisLine(135)).toBe('northwest to southeast');
    expect(axisLine(315)).toBe('northwest to southeast');
    expect(axisLine(0)).toBe('north to south');
    expect(axisLine(45)).toBe('northeast to southwest');
    expect(axisLine(90)).toBe('east to west');
  });

  it('lists the shape in miles', () => {
    expect(
      shapeRows({
        shorelineM: 11.4 * 1609.344,
        longAxisM: 4.1 * 1609.344,
        longAxisBearingDeg: 135,
        shortAxisM: 0.8 * 1609.344,
      }),
    ).toEqual([
      { term: 'Shoreline', value: '11.4 mi' },
      { term: 'Length', value: '4.1 mi, northwest to southeast' },
      { term: 'Width', value: '0.8 mi at its widest' },
    ]);
    expect(shapeRows({ shorelineM: 25 * 1609.344, longAxisM: 1609.344 })).toEqual([
      { term: 'Shoreline', value: '25 mi' },
      { term: 'Length', value: '1 mi' },
    ]);
    expect(shapeRows({})).toEqual([]);
  });
});

describe('reportWhen', () => {
  it('reads today with the time, the week by weekday, and older by date', () => {
    expect(reportWhen(NOW - 12 * 60_000, NOW, TZ)).toBe('Today · 11:40 AM');
    expect(reportWhen(NOW - 2 * 86_400_000, NOW, TZ)).toMatch(/^Thu · /);
    expect(reportWhen(NOW - 10 * 86_400_000, NOW, TZ)).toBe('Jan 6');
  });
});
