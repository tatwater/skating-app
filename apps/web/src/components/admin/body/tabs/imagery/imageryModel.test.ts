import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nearestNotch, notchAt } from './ImageryDockView';
import {
  granuleOf,
  INFERRED_STOP,
  MASCOMA_OVERRIDES,
  MASCOMA_PASSES,
  MASCOMA_STOPS,
} from './imageryFixtures';
import { imageryMapScene } from './imageryMap';
import {
  CLEAR_GATE_PCT,
  COVERAGE_GATE_PCT,
  defaultPass,
  isShown,
  parsePassAddress,
  passAddress,
  passCount,
  passDay,
  passRows,
  passSeen,
  satelliteAssist,
  seenWords,
  selectedPass,
  winterWord,
} from './imageryModel';
import { meterPercent } from './kit-candidates/threshold-meter';

describe('passRows', () => {
  it('draws the board’s passes: cloud and coverage in percent, who sees each', () => {
    expect(
      MASCOMA_PASSES.map((r) => [r.day, r.weekday, r.cloudPct, r.coveragePct, r.seen]),
    ).toEqual([
      ['3 Oct', 'Sat', 8, 100, 'shown'],
      ['5 Oct', 'Mon', 91, 100, 'hidden'],
      ['6 Oct', 'Tue', 0, 40, 'hidden'],
      ['8 Oct', 'Thu', 3, 100, 'shown'],
      ['10 Oct', 'Sat', 64, 100, 'hidden'],
      ['11 Oct', 'Sun', 72, 100, 'shown-anyway'],
      ['13 Oct', 'Tue', 2, 100, 'shown'],
    ]);
    expect(passCount(MASCOMA_PASSES)).toEqual({ total: 7, hidden: 3 });
    expect(MASCOMA_PASSES.at(-1)?.date).toBe('13 Oct 2026');
    expect(MASCOMA_PASSES.at(-1)?.source).toBe('Sentinel-2 true color');
    expect(MASCOMA_PASSES[2]?.caveat).toBe('only 40% of the lake in this pass');
  });

  it('a pass no manifest measured has no figures — absent, never zero', () => {
    const [row] = passRows([INFERRED_STOP]);
    expect([row?.cloudPct, row?.clearPct, row?.coveragePct]).toEqual([null, null, null]);
    // The caveat falls back to the region's figure, worded as the region's.
    expect(row?.caveat).toBe('94% cloud over the region');
  });

  it('writes a pass’s day first, by its UTC day, and an unreadable one as unknown', () => {
    // 23:30 UTC on the 13th is the 13th, whatever the reader's zone.
    expect(passDay('2026-10-13T23:30:00Z')).toEqual({
      day: '13 Oct',
      weekday: 'Tue',
      date: '13 Oct 2026',
    });
    expect(passDay('nope').date).toBe('Unknown date');
  });

  it('the gates are core’s', () => {
    expect([CLEAR_GATE_PCT, COVERAGE_GATE_PCT]).toEqual([60, 50]);
  });

  it('cloud and clear always add to 100, and a figure under its gate is what hid the pass', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (clear) => {
        const stop = {
          ...MASCOMA_STOPS[0],
          stats: { waterBodyId: 'x', clearPct: clear, coveragePct: 1, pixels: 1 },
        } as (typeof MASCOMA_STOPS)[number];
        const [row] = passRows([stop]);
        expect((row?.cloudPct ?? 0) + (row?.clearPct ?? 0)).toBe(100);
        expect(row?.clearPct).toBeGreaterThanOrEqual(0);
        expect(row?.clearPct).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe('who sees a pass', () => {
  it('a person’s call only ever goes against the gates', () => {
    expect(passSeen(true, null)).toBe('shown');
    expect(passSeen(false, null)).toBe('hidden');
    expect(passSeen(false, { verdict: 'show', by: 'T', at: 0 })).toBe('shown-anyway');
    expect(passSeen(true, { verdict: 'hide', by: 'T', at: 0 })).toBe('hidden-by-staff');
    // A call that agrees with the gates changes nothing.
    expect(passSeen(true, { verdict: 'show', by: 'T', at: 0 })).toBe('shown');
    expect(passSeen(false, { verdict: 'hide', by: 'T', at: 0 })).toBe('hidden');
    expect(
      ['shown', 'shown-anyway', 'hidden', 'hidden-by-staff'].map((s) => seenWords(s as never)),
    ).toEqual(['shown to skaters', 'shown anyway', 'hidden from skaters', 'hidden by staff']);
  });

  it('opens on the newest shown pass, or the newest when none is shown', () => {
    expect(defaultPass(MASCOMA_PASSES)).toBe(6);
    const allHidden = passRows(MASCOMA_STOPS.map((s) => ({ ...s, landable: false })));
    expect(defaultPass(allHidden)).toBe(6);
    expect(defaultPass([])).toBe(-1);
    // A lit pass wins; an unknown one falls back.
    expect(selectedPass(MASCOMA_PASSES, granuleOf(10))).toBe(4);
    expect(selectedPass(MASCOMA_PASSES, 'gone')).toBe(6);
    expect(selectedPass(MASCOMA_PASSES, null)).toBe(6);
    const overridden = passRows(MASCOMA_STOPS, {
      ...MASCOMA_OVERRIDES,
      [granuleOf(13)]: { verdict: 'hide', by: 'Sarah', at: 0 },
    });
    expect(defaultPass(overridden)).toBe(5);
    expect(isShown('hidden-by-staff')).toBe(false);
  });
});

describe('the satellite link’s line', () => {
  it('says the rule and where the body falls under it', () => {
    expect(satelliteAssist('Mascoma Lake', 4_620_000, 'auto')).toBe(
      'Auto offers it at 10 ha and up; Mascoma is 462 ha.',
    );
    expect(satelliteAssist('Mud Pond', 60_000, 'on')).toBe(
      'Auto offers it at 10 ha and up; Mud is 6.0 ha. Always offered, whatever the area.',
    );
    expect(satelliteAssist(undefined, undefined, 'off')).toBe(
      'Auto offers it at 10 ha and up; this body has no stored area, so auto offers it. Never offered.',
    );
  });

  it('names the season as a person says it', () => {
    expect(winterWord('winter-2026-27')).toBe('Winter 2026–27');
    expect(winterWord('odd')).toBe('odd');
  });
});

describe('the dock’s notches and the meter', () => {
  it('stand evenly, and a press picks the nearest', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        (n, f) => {
          const i = nearestNotch(f, n);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(n);
          // No notch is nearer to the press than the one picked.
          const clamped = Math.min(1, Math.max(0, f));
          for (let j = 0; j < n; j++) {
            expect(Math.abs(notchAt(i, n) - clamped)).toBeLessThanOrEqual(
              Math.abs(notchAt(j, n) - clamped) + 1e-9,
            );
          }
        },
      ),
    );
    expect(notchAt(0, 1)).toBe(0.5);
  });

  it('the meter clamps to its range', () => {
    expect(meterPercent(60, 0, 100)).toBe(60);
    expect(meterPercent(-5, 0, 100)).toBe(0);
    expect(meterPercent(150, 0, 100)).toBe(100);
    expect(meterPercent(1, 1, 1)).toBe(0);
  });
});

describe('the lit address', () => {
  it('carries the band with the pass, and reads back what it wrote', () => {
    expect(passAddress('visual', granuleOf(10))).toBe(`pass:visual.${granuleOf(10)}`);
    expect(passAddress('vh')).toBe('pass:vh');
    // Anything the URL can't hold is no address at all.
    expect(passAddress('visual', 'a/b')).toBeNull();
    expect(passAddress('Visual', 'x')).toBeNull();
    expect(parsePassAddress(`pass:scl.${granuleOf(5)}`)).toEqual({
      band: 'scl',
      granuleId: granuleOf(5),
    });
    expect(parsePassAddress('pass:vh')).toEqual({ band: 'vh', granuleId: null });
    expect(parsePassAddress('hazard:x')).toEqual({ band: 'visual', granuleId: null });
    expect(parsePassAddress(null)).toEqual({ band: 'visual', granuleId: null });
  });

  it('round-trips every address the frame would accept', () => {
    const LIT = /^[a-z][a-zA-Z]{0,31}:[A-Za-z0-9_.-]{1,128}$/;
    fc.assert(
      fc.property(
        fc.constantFrom('visual', 'scl', 'vh'),
        fc.stringMatching(/^[A-Za-z0-9_.-]{1,100}$/),
        (band, granule) => {
          const address = passAddress(band, granule);
          expect(address).not.toBeNull();
          expect(LIT.test(address as string)).toBe(true);
          expect(parsePassAddress(address)).toEqual({ band, granuleId: granule });
        },
      ),
    );
  });
});

describe('the map', () => {
  const data = { rows: MASCOMA_PASSES, band: 'visual', season: 'winter-2026-27' };
  it('draws the lit pass as the Aerial layer, and turns the layer on', () => {
    const scene = imageryMapScene(data, `pass:visual.${granuleOf(10)}`);
    expect(scene).toEqual({
      items: [
        {
          kind: 'raster',
          id: `pass:visual.${granuleOf(10)}`,
          layer: 'aerial',
          granuleId: granuleOf(10),
          band: 'visual',
          capturedAt: '2026-10-10T15:42:00Z',
          key: `frames/winter-2026-27/${granuleOf(10)}.webp`,
          season: 'winter-2026-27',
        },
      ],
      lit: `pass:visual.${granuleOf(10)}`,
      layers: { aerial: true },
    });
    // Nothing lit: the newest shown pass.
    expect(imageryMapScene(data, null).lit).toBe(`pass:visual.${granuleOf(13)}`);
    expect(imageryMapScene(data, 'hazard:x').lit).toBe(`pass:visual.${granuleOf(13)}`);
    expect(imageryMapScene({ rows: [], band: 'visual', season: null }, null)).toEqual({
      items: [],
      lit: null,
      layers: { aerial: true },
    });
  });

  it('never draws one band’s picture for a pass lit in another', () => {
    expect(imageryMapScene(data, 'pass:vh.S1A_IW_20261012')).toEqual({
      items: [],
      lit: 'pass:vh.S1A_IW_20261012',
      layers: { aerial: true },
    });
  });
});
