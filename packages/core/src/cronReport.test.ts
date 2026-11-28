import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CRON_TICK_CODES,
  CRON_TICK_MAX_OFFSET_SEC,
  cronTickBucketMs,
  cronTickBucketStart,
  packTick,
  unpackTick,
} from './cronReport';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const offset = fc.integer({ min: 0, max: CRON_TICK_MAX_OFFSET_SEC });
const code = fc.integer({ min: 0, max: 7 });

describe('packTick and unpackTick', () => {
  it('round-trip every offset in a day and every code', () => {
    fc.assert(
      fc.property(offset, code, (o, c) => {
        expect(unpackTick(packTick(o, c))).toEqual({ offsetSec: o, code: c });
      }),
    );
  });

  it('order by time first: a later second always packs larger, whatever the codes', () => {
    fc.assert(
      fc.property(offset, offset, code, code, (a, b, ca, cb) => {
        fc.pre(a < b);
        expect(packTick(a, ca)).toBeLessThan(packTick(b, cb));
      }),
    );
  });

  it('stays an exact integer under 691,200, inside any Convex number', () => {
    expect(packTick(CRON_TICK_MAX_OFFSET_SEC, 7)).toBe(691_199);
    expect(CRON_TICK_MAX_OFFSET_SEC).toBe(86_399);
    expect(Number.isSafeInteger(packTick(CRON_TICK_MAX_OFFSET_SEC, 7))).toBe(true);
  });

  it('floors a fraction and holds the offset inside a day, never spilling into the code', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e7, max: 1e7, noNaN: true }), code, (o, c) => {
        const { offsetSec, code: back } = unpackTick(packTick(o, c));
        expect(back).toBe(c);
        expect(offsetSec).toBe(Math.min(CRON_TICK_MAX_OFFSET_SEC, Math.max(0, Math.floor(o))));
      }),
    );
    expect(unpackTick(packTick(12.9, CRON_TICK_CODES.failed))).toEqual({ offsetSec: 12, code: 2 });
    expect(unpackTick(packTick(-3, CRON_TICK_CODES.ok))).toEqual({ offsetSec: 0, code: 0 });
  });

  it('refuses a code outside the three bits, and an offset that is not a number', () => {
    expect(() => packTick(0, 8)).toThrow(RangeError);
    expect(() => packTick(0, -1)).toThrow(RangeError);
    expect(() => packTick(0, 1.5)).toThrow(RangeError);
    expect(() => packTick(Number.NaN, 0)).toThrow(RangeError);
    expect(() => packTick(Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
  });

  it('keeps every tick code distinct and inside the three bits', () => {
    const codes = Object.values(CRON_TICK_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c >= 0 && c < 8).toBe(true);
  });
});

describe('the tick rows’ buckets', () => {
  it('an hour for a job ticking more often than every 30 minutes, a day otherwise', () => {
    expect(cronTickBucketMs(MINUTE)).toBe(HOUR);
    expect(cronTickBucketMs(3 * MINUTE)).toBe(HOUR);
    expect(cronTickBucketMs(30 * MINUTE - 1)).toBe(HOUR);
    expect(cronTickBucketMs(30 * MINUTE)).toBe(DAY);
    expect(cronTickBucketMs(6 * HOUR)).toBe(DAY);
    expect(cronTickBucketMs(7 * DAY)).toBe(DAY);
  });

  it('holds at most 60 ticks of a job recorded every tick, from one minute up', () => {
    fc.assert(
      fc.property(fc.integer({ min: MINUTE, max: 7 * DAY }), (period) => {
        expect(Math.ceil(cronTickBucketMs(period) / period)).toBeLessThanOrEqual(60);
      }),
    );
  });

  it('starts at the UTC hour or day holding the instant, and every offset fits the packing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }),
        fc.constantFrom(HOUR, DAY),
        (at, bucket) => {
          const start = cronTickBucketStart(at, bucket);
          expect(start).toBeLessThanOrEqual(at);
          expect(at - start).toBeLessThan(bucket);
          expect(start % bucket).toBe(0);
          expect(Math.floor((at - start) / 1000)).toBeLessThanOrEqual(CRON_TICK_MAX_OFFSET_SEC);
        },
      ),
    );
    expect(cronTickBucketStart(Date.UTC(2026, 10, 27, 14, 37, 5), HOUR)).toBe(
      Date.UTC(2026, 10, 27, 14),
    );
    expect(cronTickBucketStart(Date.UTC(2026, 10, 27, 14, 37, 5), DAY)).toBe(
      Date.UTC(2026, 10, 27),
    );
  });
});
