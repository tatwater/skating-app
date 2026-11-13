import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BOARD_NOON } from '@/test/boardNow';

import {
  acresText,
  asksText,
  type BodyRow,
  changedWhen,
  classWord,
  countWords,
  laneKicker,
  missingText,
  nextSort,
  sortRows,
  standingGroupWord,
  statesText,
} from './bodiesModel';

const ACRE = 4046.8564224;
const DAY = 86_400_000;

const body = (over: Partial<BodyRow> & { id: string }): BodyRow => ({
  name: over.id,
  bodyClass: 'lakePond',
  states: ['NH'],
  areaSqM: null,
  complete: null,
  asks: null,
  reports: null,
  changedAt: null,
  standing: 'active',
  ...over,
});

describe('a cell says', () => {
  it('the class in core’s words, lowercased', () => {
    expect(classWord('lakePond')).toBe('lake or pond');
    expect(classWord('reservoir')).toBe('reservoir');
    expect(classWord('somethingNew')).toBe('somethingnew');
  });
  it('states joined by a dot, acres grouped and whole, a tenth under one acre', () => {
    expect(statesText(['VT', 'NY'])).toBe('VT · NY');
    expect(acresText(1143 * ACRE)).toBe('1,143');
    expect(acresText(271000 * ACRE)).toBe('271,000');
    expect(acresText(0.44 * ACRE)).toBe('0.4');
  });
  it('no asks as the board’s dash, a count otherwise', () => {
    expect(asksText(0)).toBe('—');
    expect(asksText(3)).toBe('3');
  });
  it('a capped count with its plus', () => {
    expect(countWords({ count: 24871, capped: false })).toBe('24,871');
    expect(countWords({ count: 200, capped: true })).toBe('200+');
  });
  it('what’s missing as one sentence', () => {
    expect(missingText([])).toBeNull();
    expect(missingText(['bathymetry'])).toBe('Missing bathymetry');
    expect(missingText(['bathymetry', 'elevation', 'a put-in'])).toBe(
      'Missing bathymetry, elevation and a put-in',
    );
  });
  it('the group word for each standing', () => {
    expect(standingGroupWord('active')).toBe('Active');
    expect(standingGroupWord('inactive')).toBe('Dormant');
    expect(standingGroupWord('dormant')).toBe('Dormant');
    expect(standingGroupWord('rejected')).toBe('Removed');
    expect(standingGroupWord('no_public_access')).toBe('No public access');
  });
});

describe('changedWhen', () => {
  const now = BOARD_NOON; // Saturday 16 Jan 2027, local midday
  it('writes the clock today, the weekday this past week, the day and month before', () => {
    expect(changedWhen(now - 40 * 60_000, now)).toMatch(/^11:20$/);
    expect(changedWhen(now - DAY, now)).toBe('Fri');
    expect(changedWhen(now - 6 * DAY, now)).toBe('Sun');
    expect(changedWhen(now - 7 * DAY, now)).toBe('9 Jan');
    expect(changedWhen(now - 119 * DAY, now)).toBe('19 Sep');
  });
  it('reads a stamp ahead of the clock as today', () => {
    expect(changedWhen(now + 3 * DAY, now)).toMatch(/^\d\d:\d\d$/);
  });
  it('never names a weekday more than six calendar days back, nor a date within them', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * DAY }), (ago) => {
        const at = now - ago;
        const said = changedWhen(at, now);
        const day = (t: number) => {
          const d = new Date(t);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        };
        const days = Math.round((day(now) - day(at)) / DAY);
        if (days === 0) return /^\d\d:\d\d$/.test(said);
        if (days <= 6) return /^[A-Z][a-z]{2}$/.test(said);
        return /^\d{1,2} [A-Z][a-z]{2}$/.test(said);
      }),
    );
  });
});

describe('sorting a lane held whole', () => {
  const rows = [
    body({ id: 'b', reports: 2, areaSqM: 10 }),
    body({ id: 'a', reports: null, areaSqM: 30 }),
    body({ id: 'c', reports: 2, areaSqM: null }),
    body({ id: 'd', reports: 5, areaSqM: 20 }),
  ];
  it('orders by the column, ties by name', () => {
    expect(sortRows(rows, { column: 'reports', dir: 'desc' }).map((r) => r.id)).toEqual([
      'd',
      'b',
      'c',
      'a',
    ]);
    expect(sortRows(rows, { column: 'acres', dir: 'asc' }).map((r) => r.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
  it('keeps the read’s order while a search ranks it', () => {
    expect(sortRows(rows, { column: 'match' }).map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
  });
  it('puts the unrecorded last whichever way, and is total and stable', () => {
    const arb = fc.array(
      fc.record({
        id: fc.uuid(),
        name: fc.constantFrom('Post Pond', 'Lake Morey', 'Echo Lake'),
        reports: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, fc.constantFrom('asc', 'desc' as const), (specs, dir) => {
        const list = specs.map((s) => body(s));
        const sorted = sortRows(list, { column: 'reports', dir });
        const firstNull = sorted.findIndex((r) => r.reports === null);
        const nullsLast =
          firstNull === -1 || sorted.slice(firstNull).every((r) => r.reports === null);
        const again = sortRows([...list].reverse(), { column: 'reports', dir });
        return nullsLast && again.map((r) => r.id).join() === sorted.map((r) => r.id).join();
      }),
    );
  });
  it('a heading press starts in its first direction and reverses when pressed again', () => {
    expect(nextSort({ column: 'reports', dir: 'desc' }, 'name')).toEqual({
      column: 'name',
      dir: 'asc',
    });
    expect(nextSort({ column: 'match' }, 'acres')).toEqual({ column: 'acres', dir: 'desc' });
    expect(nextSort({ column: 'acres', dir: 'desc' }, 'acres')).toEqual({
      column: 'acres',
      dir: 'asc',
    });
    expect(nextSort({ column: 'acres', dir: 'asc' }, 'acres')).toEqual({
      column: 'acres',
      dir: 'desc',
    });
  });
});

describe('the page’s kicker', () => {
  const c = (count: number, capped = false) => ({ count, capped });
  it('says the lane of the corpus', () => {
    expect(
      laneKicker({
        shown: null,
        lane: c(1412),
        corpus: c(24871),
        laneWord: 'active',
        narrowedBy: [],
      }),
    ).toBe('1,412 of 24,871 in the corpus');
  });
  it('drops what it doesn’t know, never a zero', () => {
    expect(
      laneKicker({ shown: null, lane: c(200, true), corpus: null, laneWord: 'x', narrowedBy: [] }),
    ).toBe('200+');
    expect(
      laneKicker({ shown: null, lane: null, corpus: c(9), laneWord: 'x', narrowedBy: [] }),
    ).toBeNull();
  });
  it('says what narrowed it once a filter is on', () => {
    expect(
      laneKicker({
        shown: c(187),
        lane: c(1412),
        corpus: c(24871),
        laneWord: 'active',
        narrowedBy: ['1,000 ac and up'],
      }),
    ).toBe('187 of 1,412 active · 1,000 ac and up');
    expect(
      laneKicker({ shown: c(3), lane: null, corpus: null, laneWord: 'x', narrowedBy: ['NH'] }),
    ).toBe('3 · NH');
    expect(
      laneKicker({
        shown: null,
        lane: c(9),
        corpus: null,
        laneWord: 'x',
        narrowedBy: ['NH', 'Bay'],
      }),
    ).toBe('NH · Bay');
  });
});
