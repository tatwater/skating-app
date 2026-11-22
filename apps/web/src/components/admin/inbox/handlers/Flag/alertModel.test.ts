import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { alertCardFoot, alertLife, foldConfirmations, lastedWords } from './alertModel';
import { at, BOARD_NOW, BOARD_ZONE, MOREY_ALERT } from './flagFixtures';

const DAY = 86_400_000;

describe("an alert's life", () => {
  test('board 2.6: posted, pinned, confirmed, flagged today, would lapse', () => {
    const { stations, lines } = alertLife(MOREY_ALERT, BOARD_NOW, BOARD_ZONE);
    expect(
      stations.map((s) => [s.when, s.title, s.mark, s.next ?? null, s.lasted ?? null]),
    ).toEqual([
      ['2 Oct', 'Posted', 'dot', 'thin', '1 d'],
      ['3 Oct', 'Pinned official', 'square', 'heavy', '6 d'],
      ['9 Oct', 'Still so', 'ring', 'heavy', '4 d'],
      ['14 Oct · today', 'Flagged', 'now', 'dashed', '24 d'],
      ['8 Nov', 'Would lapse', 'end', null, null],
    ]);
    expect(lines.map((l) => l.line)).toEqual(['thin', 'heavy', 'dashed']);
  });
  test('nothing today: a Today station is added', () => {
    const life = MOREY_ALERT.life.slice(0, 3);
    const { stations } = alertLife({ ...MOREY_ALERT, life }, BOARD_NOW, BOARD_ZONE);
    expect(stations.map((s) => s.title)).toEqual([
      'Posted',
      'Pinned official',
      'Still so',
      'Today',
      'Would lapse',
    ]);
  });
  test('retracted: no today, no lapse, no dashed line', () => {
    const life = [
      ...MOREY_ALERT.life,
      { at: at(10, 14, 11), event: 'retracted' as const, by: null },
    ];
    const { stations, lines } = alertLife(
      { ...MOREY_ALERT, life, status: 'retracted' },
      BOARD_NOW,
      BOARD_ZONE,
    );
    expect(stations.at(-1)?.title).toBe('Retracted');
    expect(stations.at(-1)?.mark).toBe('square');
    expect(lines.some((l) => l.line === 'dashed')).toBe(false);
  });
  test('an unpin goes back to the thin line', () => {
    const life = [
      ...MOREY_ALERT.life.slice(0, 2),
      { at: at(10, 5, 9), event: 'unpinned' as const, by: null },
      { at: at(10, 7, 9), event: 'denied' as const, by: null },
    ];
    const { stations } = alertLife(
      { ...MOREY_ALERT, life, status: 'active' },
      BOARD_NOW,
      BOARD_ZONE,
    );
    expect(stations.map((s) => s.next ?? null).slice(0, 4)).toEqual([
      'thin',
      'heavy',
      'thin',
      'thin',
    ]);
  });
  test('a run of confirmations folds into one', () => {
    const run = [1, 2, 3, 4].map((d) => ({
      at: at(10, 5 + d, 9),
      event: 'confirmed' as const,
      by: null,
    }));
    expect(
      foldConfirmations([...MOREY_ALERT.life.slice(0, 2), ...run]).map((e) => e.times),
    ).toEqual([1, 1, 4]);
    const { stations } = alertLife(
      { ...MOREY_ALERT, life: [...MOREY_ALERT.life.slice(0, 2), ...run] },
      BOARD_NOW,
    );
    expect(stations[2]?.title).toBe('Still so ×4');
  });
  test('the card’s foot', () => {
    expect(alertCardFoot(MOREY_ALERT, BOARD_ZONE)).toBe('Pinned · since 3 Oct');
    expect(alertCardFoot({ ...MOREY_ALERT, status: 'active' }, BOARD_ZONE)).toBe(
      'Active · lapses 8 Nov',
    );
    expect(alertCardFoot({ ...MOREY_ALERT, status: 'expired', expiresAt: null }, BOARD_ZONE)).toBe(
      'Lapsed',
    );
  });
  test('property: stations are evenly one per event (plus today and the lapse), lines between only', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            at: fc.integer({ min: at(9, 1, 0), max: BOARD_NOW }),
            event: fc.constantFrom(
              'posted',
              'pinned',
              'unpinned',
              'confirmed',
              'denied',
              'flagged',
            ),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (events) => {
          const life = events.map((e) => ({ ...e, by: null }));
          const { stations } = alertLife(
            { ...MOREY_ALERT, life, status: 'active' },
            BOARD_NOW,
            BOARD_ZONE,
          );
          expect(stations.at(-1)?.next).toBeUndefined();
          for (const s of stations.slice(0, -1)) expect(s.next).toBeDefined();
          for (const s of stations)
            if (s.lasted !== undefined) expect(String(s.lasted)).toMatch(/^(<1|\d+) d$/);
        },
      ),
    );
  });
  test('lasted', () => {
    expect(lastedWords(0, DAY * 6.9)).toBe('6 d');
    expect(lastedWords(0, 1000)).toBe('<1 d');
    expect(lastedWords(DAY, 0)).toBe('<1 d');
  });
});
