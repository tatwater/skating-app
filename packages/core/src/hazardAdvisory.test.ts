import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_DISCLAIMER,
  ADVISORY_HEADING,
  RECURRENCE_FAMILY_PHRASES,
  type RecurrenceAdvisoryInput,
  recurrenceAdvisory,
} from './hazardAdvisory';
import { RECURRENCE_FAMILIES } from './hazardCluster';

function input(overrides: Partial<RecurrenceAdvisoryInput> = {}): RecurrenceAdvisoryInput {
  return { family: 'ridge', seasonsObserved: 3, windowSeasons: 4, ...overrides };
}

describe('recurrenceAdvisory', () => {
  it('renders the sentence §9.2 specifies', () => {
    expect(
      recurrenceAdvisory(
        input({
          subAreaName: 'The Narrows',
          showTiming: true,
          firstReportedDayOfSeasonP25: 180,
          firstReportedDayOfSeasonP75: 235,
        }),
      ),
    ).toBe(
      'Skaters have reported a pressure ridge near The Narrows in 3 of the last 4 winters, first reported late December to February.',
    );
  });

  it('names every family it could be asked about', () => {
    for (const family of RECURRENCE_FAMILIES) {
      expect(RECURRENCE_FAMILY_PHRASES[family]).toBeTruthy();
      expect(recurrenceAdvisory(input({ family }))).toContain(RECURRENCE_FAMILY_PHRASES[family]);
    }
  });
});

describe('the D3 discipline', () => {
  /** Every shape the advisory can take, so the assertions below are about the template not one string. */
  const everyRendering: string[] = [];
  for (const family of RECURRENCE_FAMILIES) {
    for (const subAreaName of [undefined, 'The Narrows']) {
      for (const showTiming of [false, true]) {
        for (const seasonsObserved of [1, 2, 3, 4]) {
          const line = recurrenceAdvisory({
            family,
            seasonsObserved,
            windowSeasons: 4,
            ...(subAreaName !== undefined ? { subAreaName } : {}),
            showTiming,
            firstReportedDayOfSeasonP25: 180,
            firstReportedDayOfSeasonP75: 235,
          });
          if (line) everyRendering.push(line);
        }
      }
    }
  }

  it('never asserts that a hazard is, will be, or is likely to be there', () => {
    // The whole line D3 draws. "Ridges usually form here" and "there is a ridge here" are different
    // sentences, and a template that can produce the second is a template that eventually will.
    const forbidden = [
      /\bthere is\b/i,
      /\bthere are\b/i,
      /\bwill be\b/i,
      /\blikely\b/i,
      /\bexpect\b/i,
      /\busually\b/i,
      /\bprobably\b/i,
      /\bdanger(ous)?\b/i,
      /\bunsafe\b/i,
      /\bsafe\b/i,
      /%/,
    ];
    for (const line of everyRendering) {
      for (const pattern of forbidden) expect(line).not.toMatch(pattern);
    }
  });

  it('is past tense with a reporter, every time', () => {
    // The subject of the sentence is the people, never the ice.
    for (const line of everyRendering) expect(line.startsWith('Skaters have reported ')).toBe(true);
  });

  it('never prints a count without its denominator', () => {
    // The number that stops a reader inflating it. A bare "3 winters" is the failure mode.
    for (const line of everyRendering) {
      expect(line).toMatch(/\d+ of the last \d+ winters/);
    }
  });

  it('omits the place rather than inventing one', () => {
    const withPlace = recurrenceAdvisory(input({ subAreaName: 'The Narrows' })) as string;
    const without = recurrenceAdvisory(input()) as string;
    expect(withPlace).toContain('near The Narrows');
    expect(without).not.toMatch(/\bnear\b/);
    // And nothing stands in for the missing phrase — "somewhere on the lake" would be a guess dressed
    // as a location.
    expect(without).not.toMatch(/somewhere|part of|end of/i);
  });

  it('says nothing about timing until the timing clears its own bar', () => {
    const quiet = recurrenceAdvisory(
      input({
        showTiming: false,
        firstReportedDayOfSeasonP25: 180,
        firstReportedDayOfSeasonP75: 235,
      }),
    ) as string;
    expect(quiet).not.toMatch(/first reported/);
    const loud = recurrenceAdvisory(
      input({
        showTiming: true,
        firstReportedDayOfSeasonP25: 180,
        firstReportedDayOfSeasonP75: 235,
      }),
    ) as string;
    expect(loud).toMatch(/first reported late December to February/);
  });

  it('never quotes a date, even in the timing clause', () => {
    // A window given to the day implies the rest of the season is clear.
    const line = recurrenceAdvisory(
      input({
        showTiming: true,
        firstReportedDayOfSeasonP25: 180,
        firstReportedDayOfSeasonP75: 235,
      }),
    ) as string;
    const afterCount = line.slice(line.indexOf('winters'));
    expect(afterCount).not.toMatch(/\d/);
  });

  it('renders nothing rather than a sentence it cannot stand behind', () => {
    // An advisory without its denominator is the one form of this copy that is actively misleading.
    expect(recurrenceAdvisory(input({ seasonsObserved: 0 }))).toBeNull();
    expect(recurrenceAdvisory(input({ windowSeasons: 0 }))).toBeNull();
  });

  it('never prints more winters than the window holds (property)', () => {
    // "5 of the last 4 winters" reads as a bug and takes every other number on the page with it.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom(...RECURRENCE_FAMILIES),
        (seasonsObserved, windowSeasons, family) => {
          const line = recurrenceAdvisory({ family, seasonsObserved, windowSeasons }) as string;
          const match = line.match(/(\d+) of the last (\d+) winters/);
          expect(match).not.toBeNull();
          expect(Number(match?.[1])).toBeLessThanOrEqual(Number(match?.[2]));
        },
      ),
    );
  });

  it('carries the disclaimer that closes the gap a reader would fill in', () => {
    expect(ADVISORY_HEADING).toBe('Ice history');
    expect(ADVISORY_DISCLAIMER).toMatch(/not a report of conditions now/);
    expect(ADVISORY_DISCLAIMER).toMatch(/nothing has been reported here yet this winter/i);
  });
});
