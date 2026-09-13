import { describe, expect, it } from 'vitest';
import {
  COLD_CHAIN_MAX_SPAN_DAYS,
  COLD_CHAIN_THRESHOLDS_F,
  type ColdChainDay,
  coldChain,
  describeColdChain,
  isColdChainThresholdF,
  noSnowSinceChain,
  nthColdNightDayMs,
  thresholdLabel,
} from './coldChain';

const DAY = 86_400_000;
const d0 = Date.UTC(2026, 0, 10);
const day = (i: number) => d0 + i * DAY;

/** Nights as a string, newest last: `c` cold, `m` mild, `?` unobserved, `-` no row at all. */
function nights(pattern: string, snow: Record<number, number | null> = {}): ColdChainDay[] {
  const out: ColdChainDay[] = [];
  [...pattern].forEach((ch, i) => {
    if (ch === '-') return;
    out.push({
      dayMs: day(i),
      nightMinTempC: ch === 'c' ? -12 : ch === 'm' ? -2 : null,
      snowfallCm: i in snow ? (snow[i] as number | null) : 0,
    });
  });
  return out;
}

describe('coldChain — the founder definition (D164)', () => {
  it('finds a plain run and names its ends', () => {
    const c = coldChain(nights('mmcccm'), 20);
    expect(c.nights).toBe(3);
    expect(c.startDayMs).toBe(day(2));
    expect(c.endDayMs).toBe(day(4));
    expect(c.alive).toBe(true); // the mild 5th is inside the tolerance
    expect(c.openEnded).toBe(false);
    expect(c.coldNightMask).toBe(0b111);
  });

  it('bridges one mild night and not two — the 48 h rule', () => {
    expect(coldChain(nights('mccmcc'), 20).nights).toBe(4);
    expect(coldChain(nights('mccmmcc'), 20).nights).toBe(2);
    expect(coldChain(nights('mccmmcc'), 20).startDayMs).toBe(day(5));
  });

  it('treats an unobserved night as the same tolerance, never as cold or warm', () => {
    expect(coldChain(nights('mcc?cc'), 20).nights).toBe(4);
    expect(coldChain(nights('mcc??cc'), 20).nights).toBe(2);
    expect(coldChain(nights('mcc-cc'), 20).nights).toBe(4); // a missing row is an unobserved night
  });

  it('is dead after two non-cold nights, and dates its end', () => {
    const c = coldChain(nights('mcccmm'), 20);
    expect(c.alive).toBe(false);
    expect(c.nights).toBe(3);
    expect(c.endDayMs).toBe(day(3));
    expect(describeColdChain(c)).toBe('Run of 3 nights below 20°F ended Jan 13');
  });

  it('is alive when the newest night is unobserved but the one before was cold', () => {
    expect(coldChain(nights('mccc?'), 20).alive).toBe(true);
    expect(coldChain(nights('mccc??'), 20).alive).toBe(false);
  });

  it('reports nothing when no night was cold', () => {
    const c = coldChain(nights('mmm'), 20);
    expect(c.nights).toBe(0);
    expect(c.startDayMs).toBeNull();
    expect(c.asOfDayMs).toBe(day(2));
    expect(describeColdChain(c)).toBeNull();
  });

  it('is open-ended when the chain reaches the oldest day given', () => {
    const c = coldChain(nights('cccm'), 20);
    expect(c.nights).toBe(3);
    expect(c.openEnded).toBe(true);
    expect(describeColdChain(c)).toBe('3+ nights below 20°F, no snow since the first');
  });

  it('is not open-ended when the oldest night is a bridgeable gap', () => {
    // The night beyond the window is unknown either way; "+" on every chain near an edge would mean
    // nothing.
    expect(coldChain(nights('mccc'), 20).openEnded).toBe(false);
  });

  it('caps the walk at the max span and marks it open-ended', () => {
    const c = coldChain(nights('c'.repeat(COLD_CHAIN_MAX_SPAN_DAYS + 5)), 20);
    expect(c.nights).toBe(COLD_CHAIN_MAX_SPAN_DAYS);
    expect(c.openEnded).toBe(true);
  });

  it('answers as of an earlier day, ignoring anything newer', () => {
    const c = coldChain(nights('mccmm'), 20, { asOfDayMs: day(2) });
    expect(c.alive).toBe(true);
    expect(c.nights).toBe(2);
    expect(c.asOfDayMs).toBe(day(2));
  });

  it('walks by day key, so out-of-order input gives the same answer', () => {
    const shuffled = [...nights('mcccm')].reverse();
    expect(coldChain(shuffled, 20)).toEqual(coldChain(nights('mcccm'), 20));
  });

  it('uses the threshold it was given', () => {
    const mild = nights('mmm'); // −2 °C ≈ 28 °F: below 32, not below 20
    expect(coldChain(mild, 32).nights).toBeGreaterThan(0);
    expect(coldChain(mild, 20).nights).toBe(0);
  });
});

describe('coldChain — snow since the first night', () => {
  it('sums snow on and after the start day, not before', () => {
    const c = coldChain(nights('mccc', { 0: 10, 1: 0.2, 2: 1 }), 20);
    expect(c.snowSinceStartCm).toBeCloseTo(1.2);
    expect(noSnowSinceChain(c)).toBe(false);
    expect(describeColdChain(c)).toBe('3 nights below 20°F, 0.5 in of snow since the first');
  });

  it('holds "no snow since" under the dusting floor', () => {
    const c = coldChain(nights('mccc', { 2: 0.3 }), 20);
    expect(noSnowSinceChain(c)).toBe(true);
    expect(describeColdChain(c)).toBe('3 nights below 20°F, no snow since the first');
  });

  it('refuses "no snow since" when a day since the start has no snow figure', () => {
    const c = coldChain(nights('mccc', { 2: null }), 20);
    expect(c.snowUnknownDays).toBe(1);
    expect(noSnowSinceChain(c)).toBe(false);
    expect(describeColdChain(c)).toBe(
      '3 nights below 20°F, snow since the first unknown for 1 day',
    );
  });

  it('counts a missing row since the start as an unknown snow day', () => {
    const c = coldChain(nights('mcc-c'), 20);
    expect(c.snowUnknownDays).toBe(1);
  });
});

describe('nthColdNightDayMs — the feed event time (D165)', () => {
  it('finds the day the chain reached N, skipping bridged nights', () => {
    const c = coldChain(nights('mccmcc'), 20);
    expect(c.coldNightMask).toBe(0b11011);
    expect(nthColdNightDayMs(c, 1)).toBe(day(1));
    expect(nthColdNightDayMs(c, 2)).toBe(day(2));
    expect(nthColdNightDayMs(c, 3)).toBe(day(4)); // the mild 3rd is bridged, not counted
    expect(nthColdNightDayMs(c, 4)).toBe(day(5));
    expect(nthColdNightDayMs(c, 5)).toBeNull();
    expect(nthColdNightDayMs(c, 0)).toBeNull();
  });

  it('is null for an empty chain', () => {
    expect(nthColdNightDayMs(coldChain(nights('mm'), 20), 1)).toBeNull();
  });
});

describe('thresholds', () => {
  it('pins the four founder thresholds and labels them from the Fahrenheit value', () => {
    expect([...COLD_CHAIN_THRESHOLDS_F]).toEqual([32, 20, 10, 0]);
    expect(thresholdLabel(20)).toBe('20°F');
    expect(thresholdLabel(0)).toBe('0°F');
    expect(isColdChainThresholdF(20)).toBe(true);
    expect(isColdChainThresholdF(25)).toBe(false);
    expect(isColdChainThresholdF('20')).toBe(false);
  });
});
