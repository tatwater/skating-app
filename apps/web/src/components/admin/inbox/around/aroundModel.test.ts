import { AROUND_IT_PHRASE_KEYS, type AroundItPhrase, zonedInstant } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  AROUND,
  AROUND_CAPPED,
  AROUND_EMPTY,
  AROUND_ROB,
  at,
  BOARD_ZONE,
} from '../handlers/Flag/flagFixtures';
import { dayKey } from '../handlers/Flag/flagFormat';
import { AROUND_WORDS } from '../handlers/Flag/flagWords';
import {
  aroundDays,
  aroundLine,
  aroundStats,
  aroundSummary,
  hasMeasured,
  isCapped,
  linePhrases,
  newestFirst,
  reportsCount,
  windowCount,
  windowSpan,
} from './aroundModel';

/** Every word a phrase may say: the counts aside, only these (the founder's call; D3). */
const PHRASE_TEXTS = new Set(
  AROUND_IT_PHRASE_KEYS.map((k) => AROUND_WORDS.phrase[k]('0').replace(/^0 /, '')),
);

const phrase = fc.record({
  key: fc.constantFrom(...AROUND_IT_PHRASE_KEYS),
  count: fc.integer({ min: -3, max: 60 }),
}) as fc.Arbitrary<AroundItPhrase>;

describe('aroundSummary — the line quotes the reports, never a class', () => {
  test('the board: the first three, in the line order', () => {
    expect(aroundSummary(AROUND.phrases)).toBe(
      '1 measured less · 1 saw open water · 1 saw skim ice',
    );
  });
  test('nothing to say is nothing', () => {
    expect(aroundSummary([])).toBeNull();
    expect(aroundSummary([{ key: 'open_water', count: 0 }])).toBeNull();
  });
  test('the order is the line order, whatever order the server sent', () => {
    expect(
      aroundSummary([
        { key: 'dont_go', count: 2 },
        { key: 'measured_less', count: 1 },
      ]),
    ).toBe("1 measured less · 2 said don't go");
  });
  test('property: every part is "<count> <one of the phrases>", at most three, counts positive', () => {
    fc.assert(
      fc.property(fc.array(phrase, { maxLength: 12 }), (phrases) => {
        const s = aroundSummary(phrases);
        if (s === null) {
          expect(phrases.every((p) => p.count <= 0)).toBe(true);
          return;
        }
        const parts = s.split(' · ');
        expect(parts.length).toBeLessThanOrEqual(3);
        for (const part of parts) {
          const m = /^(\d+) (.+)$/.exec(part);
          expect(m).not.toBeNull();
          expect(Number(m?.[1])).toBeGreaterThan(0);
          // No word outside the phrases' own: "thin", "safe", "solid" can't appear.
          expect(PHRASE_TEXTS.has(m?.[2] ?? '')).toBe(true);
        }
      }),
    );
  });
  test('property: no class word ever', () => {
    fc.assert(
      fc.property(fc.array(phrase, { maxLength: 12 }), (phrases) => {
        const s = aroundSummary(phrases, 6) ?? '';
        expect(s).not.toMatch(/\b(thin|thick|safe|unsafe|solid|good|bad|ok|fine|dangerous)\b/i);
      }),
    );
  });
  test('linePhrases keeps a phrase it knows, drops one it does not', () => {
    expect(linePhrases([{ key: 'thin' as never, count: 4 }])).toEqual([]);
    expect(linePhrases(AROUND.phrases, 0)).toEqual([]);
  });
});

describe('the line', () => {
  test('how many more, within how many days', () => {
    expect(aroundLine(AROUND, 'Mascoma Lake')).toBe(
      '3 more reports at Mascoma Lake, within 3 days of this one',
    );
    expect(
      aroundLine(
        { ...AROUND, reports: AROUND.reports.slice(0, 1), window: { ...AROUND.window, days: 1 } },
        'X',
      ),
    ).toBe('1 more report at X, within 1 day of this one');
    expect(aroundLine(AROUND_EMPTY, 'Mascoma Lake')).toBe(
      'No other reports at Mascoma Lake within 3 days of this one',
    );
  });
});

describe('the drawer', () => {
  test('newest first, this one among them', () => {
    const order = newestFirst(AROUND);
    expect(order.map((o) => o.report.reportId)).toEqual([
      'r_dana',
      'r_sarah',
      'r_black_ice',
      'r_luc',
    ]);
    expect(order.filter((o) => o.isThis)).toHaveLength(1);
  });
  test('days: a quiet run after the newest, each day with its rows, gaps between', () => {
    const days = aroundDays(AROUND, BOARD_ZONE);
    expect(days.map((d) => (d.kind === 'none' ? `none:${d.label}` : d.label))).toEqual([
      'none:Mon 12 Oct – Tue 13 Oct',
      'Sun 11 Oct',
      'Sat 10 Oct',
      'none:Fri 9 Oct',
      'Thu 8 Oct',
      'none:Wed 7 Oct',
    ]);
    const sat = days.find((d) => d.label === 'Sat 10 Oct');
    expect(sat?.kind === 'day' && sat.rows.map((r) => r.isThis)).toEqual([false, true]);
    const dana = days.find((d) => d.label === 'Sun 11 Oct');
    expect(dana?.kind === 'day' && dana.rows[0]).toMatchObject({
      time: '08:40',
      vantage: 'from shore',
      distance: '0.8 mi',
      down: null,
    });
  });
  test('this report has no distance; a hidden one is marked', () => {
    const view = {
      ...AROUND,
      reports: [
        { ...AROUND.reports[0], moderationStatus: 'hidden' } as (typeof AROUND.reports)[number],
      ],
    };
    const rows = aroundDays(view, BOARD_ZONE).flatMap((d) => (d.kind === 'day' ? d.rows : []));
    expect(rows.find((r) => r.isThis)?.distance).toBeNull();
    expect(rows.find((r) => !r.isThis)?.down).toBe('hidden');
  });
  test('a report outside the walked window is still listed', () => {
    const late = {
      ...AROUND.reports[0],
      reportId: 'r_late',
      skateEndTime: at(10, 20, 12),
    } as (typeof AROUND.reports)[number];
    const rows = aroundDays({ ...AROUND, reports: [late] }, BOARD_ZONE).flatMap((d) =>
      d.kind === 'day' ? d.rows : [],
    );
    expect(rows.map((r) => r.report.reportId)).toContain('r_late');
  });
  test('stats: this one counted, vantages, the measured range', () => {
    expect(aroundStats(AROUND)).toEqual({
      reports: 4,
      onIce: 2,
      shore: 2,
      secondhand: 0,
      measured: '1.8–3.5',
    });
    expect(aroundStats(AROUND_EMPTY).measured).toBe('3.5');
    const none = {
      ...AROUND_EMPTY,
      flagged: { ...AROUND_ROB, claims: { ...AROUND_ROB.claims, iceThickness: null } },
    };
    expect(aroundStats(none).measured).toBeNull();
  });
  test('the window on one line', () => {
    expect(windowSpan(AROUND, BOARD_ZONE)).toBe('7–13 Oct');
    expect(
      windowSpan(
        { ...AROUND, window: { from: at(9, 28, 12), to: at(10, 4, 12), days: 3 } },
        BOARD_ZONE,
      ),
    ).toBe('28 Sep – 4 Oct');
    expect(AROUND_CAPPED.cappedBefore).toBe(true);
  });
  test('hasMeasured', () => {
    expect(hasMeasured(AROUND_ROB)).toBe(true);
    expect(hasMeasured(AROUND.reports[0] as never)).toBe(false);
  });
});

describe('a window the read cut short is a floor wherever it is counted', () => {
  test('the summary’s phrases and the drawer’s tiles', () => {
    expect(aroundSummary(AROUND.phrases, undefined, true)).toBe(
      '1+ measured less · 1+ saw open water · 1+ saw skim ice',
    );
    expect(aroundSummary(AROUND.phrases)).toBe(
      '1 measured less · 1 saw open water · 1 saw skim ice',
    );
    expect(windowCount(AROUND_CAPPED, 2)).toBe('2+');
    expect(windowCount(AROUND, 2)).toBe('2');
  });
  test('the line, the drawer’s count and Open all', () => {
    expect(aroundLine(AROUND_CAPPED, 'Mascoma Lake')).toBe(
      '3+ more reports at Mascoma Lake, within 3 days of this one',
    );
    expect(reportsCount(AROUND_CAPPED)).toBe('4+');
    expect(reportsCount(AROUND)).toBe('4');
    expect(isCapped({ cappedBefore: false, cappedAfter: true })).toBe(true);
    expect(
      aroundLine({ ...AROUND, reports: AROUND.reports.slice(0, 1), cappedAfter: true }, 'X'),
    ).toBe('1+ more reports at X, within 3 days of this one');
  });
});

describe('the drawer’s days across a clock change', () => {
  const ZONE = 'America/New_York';
  // The two US changes of the season and a plain week.
  const ANCHORS = [Date.UTC(2026, 10, 1, 6), Date.UTC(2027, 2, 14, 7), Date.UTC(2026, 11, 9, 5)];
  const HOUR = 3_600_000;
  test('pinned: a window ending just after local midnight on the spring change covers its day', () => {
    // 00:30 EDT on Mon 15 Mar 2027, the night after the clocks went forward: a 24-hour step back
    // lands on Sat 13 Mar and skips Sun 14 Mar. The walk by calendar day must not.
    const to = zonedInstant(2027, 3, 15, 30, ZONE);
    const from = to - 24 * HOUR;
    const view = {
      ...AROUND,
      flagged: { ...AROUND.flagged, skateEndTime: to - 60_000 },
      reports: [],
      window: { from, to, days: 1 },
    };
    const next = (key: string) => {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
    };
    const covered = aroundDays(view, ZONE).flatMap((d) => {
      if (d.kind === 'day') return [d.key];
      const run: string[] = [];
      for (let k = d.span[0]; k <= d.span[1]; k = next(k)) run.push(k);
      return run;
    });
    // The 24 hours back from 00:30 EDT reach 23:30 EST on Sat 13 Mar: three calendar days.
    expect(covered.sort()).toEqual(['2027-03-13', '2027-03-14', '2027-03-15']);
  });
  test('property: every report in exactly one day, the days newest first, none twice', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ANCHORS),
        fc.integer({ min: -36, max: 36 }),
        fc.integer({ min: 1, max: 7 }),
        fc.array(fc.integer({ min: -7 * 24 * 60, max: 0 }), { maxLength: 12 }),
        (anchor, shiftHours, days, offsetsMin) => {
          const to = anchor + shiftHours * HOUR;
          const from = to - days * 24 * HOUR;
          const flaggedAt = to - Math.floor((days * 24 * HOUR) / 2);
          const reports = offsetsMin
            .map((m, i) => ({
              ...AROUND.reports[0],
              reportId: `r${i}`,
              skateStartTime: null,
              skateEndTime: Math.max(from, to + m * 60_000),
            }))
            .map((r) => r as (typeof AROUND.reports)[number]);
          const view = {
            ...AROUND,
            flagged: { ...AROUND.flagged, skateEndTime: flaggedAt },
            reports,
            window: { from, to, days },
          };
          const out = aroundDays(view, ZONE);
          const ids = out.flatMap((d) =>
            d.kind === 'day' ? d.rows.map((r) => r.report.reportId) : [],
          );
          expect(ids.sort()).toEqual(
            [...reports.map((r) => r.reportId), AROUND.flagged.reportId].sort(),
          );
          const keys = out.filter((d) => d.kind === 'day').map((d) => d.key);
          expect(new Set(keys).size).toBe(keys.length);
          expect([...keys].sort().reverse()).toEqual(keys);
          // Every calendar day of the window is in exactly one entry: a day of reports or a quiet run.
          const plus = (key: string, n: number) => {
            const [y, m, d] = key.split('-').map(Number);
            return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + n))
              .toISOString()
              .slice(0, 10);
          };
          const covered = out.flatMap((d) => {
            if (d.kind === 'day') return [d.key];
            const run: string[] = [];
            for (let k = d.span[0]; k <= d.span[1]; k = plus(k, 1)) run.push(k);
            return run;
          });
          const expected: string[] = [];
          for (let k = dayKey(from, ZONE); k <= dayKey(to, ZONE); k = plus(k, 1)) expected.push(k);
          const inWindow = covered.filter((k) => k >= dayKey(from, ZONE) && k <= dayKey(to, ZONE));
          expect([...inWindow].sort()).toEqual(expected);
          // Each report sits under its own calendar day in the zone.
          for (const d of out) {
            if (d.kind !== 'day') continue;
            for (const r of d.rows) expect(dayKey(r.report.skateEndTime, ZONE)).toBe(d.key);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
