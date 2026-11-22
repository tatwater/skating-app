import { zonedInstant } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BARE_SKATE, OVER_CASPIAN } from '../handlers/Drawn/drawnFixtures';
import type { DrawnItem } from '../handlers/Drawn/drawnModel';
import { dayKey, dayMonth } from '../handlers/Flag/flagFormat';
import { skateWhen, skateWords } from './skateWords';

const NY = 'America/New_York';

describe('a recorded skate, in one format', () => {
  it('says the moving time, then when — never the span’s length as the time', () => {
    const skate = OVER_CASPIAN.skate as NonNullable<DrawnItem['skate']>;
    // 96 minutes moving inside a two-hour span.
    expect(skateWords(skate, NY)).toBe('1h 36m · 11 Oct 09:00–11:00');
  });

  it('reads a skate with no end from its start, and no moving time as nothing', () => {
    const bare = BARE_SKATE.skate as NonNullable<DrawnItem['skate']>;
    expect(skateWords(bare, NY)).toBe('11 Oct 09:00');
    expect(skateWords({ ...bare, elapsedSeconds: 0 }, NY)).toBe('11 Oct 09:00');
  });

  it('reads its day in the zone it is given', () => {
    const skate = OVER_CASPIAN.skate as NonNullable<DrawnItem['skate']>;
    expect(skateWords({ ...skate, elapsedSeconds: null, endTime: null }, 'UTC')).toBe(
      '11 Oct 13:00',
    );
  });
});

describe('a skate’s days: the start’s, and the end’s where it crosses one', () => {
  const H = 3_600_000;
  const at = (y: number, m: number, d: number, hh: number, mm: number, tz: string) =>
    zonedInstant(y, m, d, hh * 60 + mm, tz);

  it('within one day: the start’s day, then its two times — in every zone', () => {
    for (const tz of ['America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const start = at(2026, 10, 10, 21, 0, tz);
      expect(skateWhen({ startTime: start, endTime: start + 2 * H }, tz)).toBe(
        '10 Oct 21:00–23:00',
      );
    }
  });

  it('across midnight: both days, never the end’s alone (R9’s 23:00 → 01:00)', () => {
    for (const tz of ['America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const start = at(2026, 10, 10, 23, 0, tz);
      expect(
        skateWords({ startTime: start, endTime: start + 2 * H, elapsedSeconds: 100 * 60 }, tz),
      ).toBe('1h 40m · 10 Oct 23:00 – 11 Oct 01:00');
    }
  });

  it('across a clock change: the local times as the clock read them', () => {
    // New York falls back at 02:00 on 1 Nov 2026: 00:30 to 03:00 local is three and a half hours.
    const ny = at(2026, 11, 1, 0, 30, 'America/New_York');
    expect(skateWhen({ startTime: ny, endTime: ny + 3.5 * H }, 'America/New_York')).toBe(
      '1 Nov 00:30–03:00',
    );
    // Lord Howe springs forward half an hour at 02:00 on 4 Oct 2026, and this one crosses midnight.
    const lh = at(2026, 10, 3, 23, 0, 'Australia/Lord_Howe');
    expect(skateWhen({ startTime: lh, endTime: lh + 4 * H }, 'Australia/Lord_Howe')).toBe(
      '3 Oct 23:00 – 4 Oct 03:30',
    );
  });

  it('labels its days as the start’s and the end’s local days (property)', () => {
    const zones = ['America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'UTC'] as const;
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }),
        fc.integer({ min: 60_000, max: 30 * H }),
        fc.constantFrom(...zones),
        (start, length, tz) => {
          const end = start + length;
          const label = skateWhen({ startTime: start, endTime: end }, tz);
          // It leads with the start's own day.
          expect(label.startsWith(`${dayMonth(start, tz)} `)).toBe(true);
          if (dayKey(start, tz) === dayKey(end, tz)) {
            expect(label).not.toContain(' – ');
          } else {
            expect(label.endsWith(` – ${dayMonth(end, tz)} ${label.split(' ').at(-1)}`)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
