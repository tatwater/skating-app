import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayMonth, historyWhen, seasonTape, type TapeFacts } from './consoleTime';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso).getTime();

describe('seasonTape', () => {
  it('names the winter and puts today on the tape (14 Oct, day 10 of the boards’ watch)', () => {
    const tape = seasonTape(at('2026-10-14T16:00:00Z'), NY);
    expect(tape.season).toBe('Winter 2026–27');
    expect(tape.marks).toEqual([
      { at: expect.closeTo(13.67 / 212, 3), kind: 'now', title: 'Today', detail: '14 Oct' },
    ]);
  });

  it('ticks each month start after October — November at 31 of 212 days', () => {
    const { ticks } = seasonTape(at('2027-01-16T17:00:00Z'));
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toBeCloseTo(31 / 212, 6);
    expect(ticks[5]).toBeCloseTo(182 / 212, 6);
  });

  it('names the season by the July it started in, so January reads the winter before', () => {
    expect(seasonTape(at('2027-01-16T17:00:00Z')).season).toBe('Winter 2026–27');
    expect(seasonTape(at('2099-12-01T00:00:00Z')).season).toBe('Winter 2099–00');
  });

  it('draws no today mark outside the winter’s months', () => {
    expect(seasonTape(at('2026-08-01T12:00:00Z')).marks).toEqual([]);
    expect(seasonTape(at('2027-05-02T12:00:00Z')).marks).toEqual([]);
  });

  it('keeps today on the tape for every instant inside the winter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: at('2000-10-01T00:00:00Z'), max: at('2090-04-30T23:59:59Z') }),
        (now) => {
          const { marks } = seasonTape(now, 'UTC');
          for (const m of marks) {
            expect(m.at).toBeGreaterThanOrEqual(0);
            expect(m.at).toBeLessThan(1);
          }
        },
      ),
    );
  });
});

describe('historyWhen', () => {
  const now = at('2027-01-16T16:52:00Z'); // Saturday 11:52 in New Hampshire

  it('writes the clock for today', () => {
    expect(historyWhen(at('2027-01-16T14:41:00Z'), now, NY)).toBe('09:41');
  });

  it('writes the weekday for this past week', () => {
    expect(historyWhen(at('2027-01-15T22:00:00Z'), now, NY)).toBe('Fri');
    expect(historyWhen(at('2027-01-11T15:00:00Z'), now, NY)).toBe('Mon');
  });

  it('counts the past week in calendar days, so a day reads the same at any hour', () => {
    // Sunday the 10th, six days back: early (6 d 7 h ago) and late (5 d 14 h ago) alike.
    expect(historyWhen(at('2027-01-10T09:30:00Z'), now, NY)).toBe('Sun');
    expect(historyWhen(at('2027-01-11T02:30:00Z'), now, NY)).toBe('Sun');
    // Saturday the 9th is a week back: its date, never a weekday that reads as today's.
    expect(historyWhen(at('2027-01-10T04:00:00Z'), now, NY)).toBe('9 Jan');
  });

  it('writes the day and month before that, never the year', () => {
    expect(historyWhen(at('2027-01-03T15:00:00Z'), now, NY)).toBe('3 Jan');
    expect(historyWhen(at('2026-10-03T15:00:00Z'), now, NY)).toBe('3 Oct');
  });

  it('reads today in the reader’s zone, not UTC’s', () => {
    // 01:30 UTC on the 17th is still the 16th in New Hampshire.
    const late = at('2027-01-17T01:30:00Z');
    expect(historyWhen(at('2027-01-16T23:00:00Z'), late, NY)).toBe('18:00');
  });
});

describe('short months', () => {
  it('writes September as Sep, whatever the ICU build says (current ICU writes "Sept")', () => {
    expect(dayMonth(at('2026-09-14T12:00:00Z'), 'UTC')).toBe('14 Sep');
    expect(historyWhen(at('2026-09-14T12:00:00Z'), at('2026-11-13T12:00:00Z'), 'UTC')).toBe(
      '14 Sep',
    );
    expect(seasonTape(at('2026-10-14T16:00:00Z'), NY).marks[0]?.detail).toBe('14 Oct');
  });

  it('writes every month in three letters', () => {
    for (let m = 0; m < 12; m++) {
      expect(dayMonth(Date.UTC(2026, m, 15, 12), 'UTC')).toMatch(/^15 [A-Z][a-z]{2}$/);
    }
  });
});

describe('seasonTape with the watch’s record', () => {
  const WATCH: NonNullable<TapeFacts['watch']> = {
    opensOn: '2026-10-05',
    openedBy: ['sentinel'],
    closesOn: null,
    opening: {
      sentinels: [
        { name: 'A', lowC: -2 },
        { name: 'B', lowC: -1 },
      ],
    },
    sentinels: [
      { waterBodyId: 'a' as never, name: 'A' },
      { waterBodyId: 'b' as never, name: 'B' },
      { waterBodyId: 'c' as never, name: 'C' },
    ],
  };
  const FACTS: TapeFacts = {
    season: 2026,
    countsFrom: '2026-10-01',
    watch: WATCH,
    imageryNudgeOn: '2026-10-07',
    imageryNudgeLowC: -7.2,
    winterFrom: null,
    lastWinterFirst: { source: 'report', at: at('2025-12-06T15:00:00Z'), body: 'Crystal Lake' },
  };

  it('marks the opening, the imagery line, today with the day of the watch, and last winter’s ghost', () => {
    const tape = seasonTape(at('2026-10-14T16:00:00Z'), NY, FACTS);
    expect(tape.badge).toBe('Day 10');
    expect(tape.marks.map((m) => [m.kind, m.title, m.detail])).toEqual([
      ['event', 'Ice watch opened', '5 Oct · 2 of 3 sentinels'],
      ['event', 'First imagery-line night', '7 Oct · 19 °F'],
      ['now', 'Today', '14 Oct · Day 10 of the watch'],
      ['ghost', 'Last winter’s first report', '6 Dec · Crystal Lake'],
    ]);
    // The ghost sits where 6 December falls on this winter's tape.
    expect(tape.marks[3]?.at).toBeCloseTo(66 / 212, 6);
  });

  it('closes: a close mark, and no day badge', () => {
    const closed = {
      ...FACTS,
      watch: { ...WATCH, closesOn: '2027-04-20' },
      winterFrom: '2026-12-01',
    };
    const tape = seasonTape(at('2027-04-25T16:00:00Z'), NY, closed);
    expect(tape.badge).toBeUndefined();
    expect(tape.marks.map((m) => m.title)).toEqual([
      'Ice watch opened',
      'First imagery-line night',
      'Winter set in, region-wide',
      'Last winter’s first report',
      'Ice watch closed',
      'Today',
    ]);
  });

  it('says the region opened it when no sentinel did, and draws a staff date as a first skate', () => {
    const facts: TapeFacts = {
      ...FACTS,
      watch: { ...WATCH, opening: { sentinels: [] } },
      imageryNudgeOn: null,
      imageryNudgeLowC: null,
      lastWinterFirst: { source: 'field', day: '2025-12-20', body: null },
    };
    const tape = seasonTape(at('2026-10-14T16:00:00Z'), NY, facts);
    expect(tape.marks.map((m) => m.detail)).toEqual([
      '5 Oct · the region’s bodies',
      '14 Oct · Day 10 of the watch',
      '20 Dec · recorded by staff',
    ]);
    expect(tape.marks[2]?.title).toBe('Last winter’s first skate');
  });

  it('ignores another season’s record, and waits for the watch to open before a badge', () => {
    expect(
      seasonTape(at('2026-10-14T16:00:00Z'), NY, { ...FACTS, season: 2025 }).marks,
    ).toHaveLength(1);
    const waiting = seasonTape(at('2026-10-14T16:00:00Z'), NY, { ...FACTS, watch: null });
    expect(waiting.badge).toBeUndefined();
  });
});
