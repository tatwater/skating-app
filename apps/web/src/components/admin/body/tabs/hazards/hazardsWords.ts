import type { Season } from '@skating/core';

import { seasonYears } from '../../../shell/consoleTime';
import { statusDate } from '../../frame/bodyModel';

/**
 * **Every headline, empty state, summary and note the Hazards tab can say, in one place** — so a
 * test can call each and hold it to the rule (`hazardsWords.test.ts` calls every entry of
 * {@link HAZARDS_WORDS}; a new entry is held to it the moment it is added).
 *
 * **The rule (D3).** The tab describes the record, never the lake. It says what reports exist and
 * their state as reports — how many are open, how many archived — and, where a day carries an
 * unknown or an archived report has no recorded end, that the hazard may still have been on the
 * lake. It never says, as a statement about the lake or the season, that hazards are gone, clear,
 * healed, resolved, or that the ice is safe or fine ({@link LAKE_CLAIM}). An empty record is *no
 * hazard reports on record*, never *no hazards*. "Voted it gone" names a vote people cast on one
 * report, attributed and counted ({@link VOTE_WORDS}), and is never a headline.
 */

/** Words that, said about the lake or the season, would read as an all-clear. */
export const LAKE_CLAIM =
  /\b(gone|clear|cleared|all[- ]clear|heal|healed|healing|safe|safely|resolved|fine|ok|okay|skateable|solid|ended)\b/i;

/** What a string on the tab may be about: one context, so every entry can be called alike. */
export type WordsContext = {
  /** "Mascoma" — the body as the copy names it. */
  body: string;
  current: boolean;
  season: Season;
  /** The watch's opening day (a UTC midnight), or `null`. */
  watchOpenedAt: number | null;
  /** Open reports this season, and archived ones. */
  open: number;
  archived: number;
  /** One day: reports known on the lake, and archived ones that may have been. */
  count: number;
  unknown: number;
  /**
   * Hazards with no recorded end first reported that day (each a mark) — or, for a strip, in all.
   */
  reported: number;
  /** The read stopped at its most hazards. */
  capped: boolean;
  /** Archived reports with no recorded end, on one strip. */
  unknownEnds: number;
  /** One strip: days with any report, and days with some unknown. */
  markedDays: number;
  unsureDays: number;
  /** Two strips are drawn, so each note names its winter. */
  named: boolean;
  /** Patterns waiting in the pre-ice pass. */
  patterns: number;
  /** The waiting count stopped at the server's bound: `patterns` is a floor. */
  patternsCapped?: boolean;
};

/** A context with nothing in it but `over`: a string that reads only some of it. */
export function wordsContext(over: Partial<WordsContext> = {}): WordsContext {
  return {
    body: 'this body',
    current: true,
    season: 0,
    watchOpenedAt: null,
    open: 0,
    archived: 0,
    count: 0,
    unknown: 0,
    reported: 0,
    capped: false,
    unknownEnds: 0,
    markedDays: 0,
    unsureDays: 0,
    named: false,
    patterns: 0,
    ...over,
  };
}

/** "3 Oct 2026": a record's day is a UTC midnight, so it is written in UTC. */
export const dateWords = (at: number): string => statusDate(at, 'UTC');

/** "2026–27": the console's one season word. */
export const seasonWord: (season: Season) => string = seasonYears;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "since the watch opened 3 Oct 2026", "this winter", "in 2025–26". */
function when(c: WordsContext): string {
  if (!c.current) return `in ${seasonWord(c.season)}`;
  return c.watchOpenedAt === null
    ? 'this winter'
    : `since the watch opened ${dateWords(c.watchOpenedAt)}`;
}

export const HAZARDS_WORDS = {
  /** The headline over a winter with no open report. */
  quietHeadline: (c: WordsContext): string =>
    c.archived > 0
      ? `No open reports · ${c.archived} archived`
      : c.current
        ? 'No hazard reports yet'
        : 'No hazard reports on record',

  /** The line under it. */
  quietDetail: (c: WordsContext): string =>
    c.archived > 0
      ? `${plural(c.archived, 'hazard report', 'hazard reports')} on ${c.body} ${when(c)}, ${c.archived === 1 ? 'archived' : 'each archived'} by skaters’ votes. An archived report has no recorded end, so the hazard may still have been on the lake. No open report is not a reading of the ice.`
      : `There are no hazard reports on record for ${c.body} ${when(c)}. No reports is not a reading of the ice.`,

  /**
   * One day, as its strip's title and today's line write it. A mark's hazard is *first reported*
   * that day — never ended, never gone after it.
   */
  day: (c: WordsContext): string => {
    const firsts = c.reported > 0 ? `, ${c.reported} first reported this day` : '';
    if (c.unknown > 0) {
      return c.count > 0
        ? `At least ${c.count} reported on the lake${firsts}, ${c.unknown} unknown`
        : `${c.unknown} unknown: archived, may still have been on the lake`;
    }
    if (c.capped) {
      return c.count > 0
        ? `At least ${c.count} reported on the lake${firsts}`
        : 'No reports counted; the count stopped short';
    }
    return c.count > 0 ? `${c.count} reported on the lake${firsts}` : 'No hazard reports';
  },

  /** What a reader hears for one strip. */
  lineSummary: (c: WordsContext): string => {
    if (c.markedDays === 0) {
      return c.capped ? 'No reports counted; the count stopped short' : 'No hazard reports';
    }
    const days = `${plural(c.markedDays, 'day', 'days')} with hazard reports`;
    const firsts =
      c.reported === 0
        ? ''
        : `, ${plural(c.reported, 'first report', 'first reports')} with no recorded end`;
    const some = c.unsureDays === 0 ? '' : `, ${c.unsureDays} with some unknown`;
    return `${days}${firsts}${some}${c.capped ? '; each a floor' : ''}`;
  },

  /** What the winters' strips count, for their keyboard stop and their table of days. */
  stripsName: (_c: WordsContext): string => 'Hazard reports on the lake',
  /** The axis's 29 February in a winter without one: never "not yet", a day that never comes. */
  noSuchDay: (_c: WordsContext): string => 'No 29 February this winter',
  /**
   * The strips' caption, drawn whenever a mark is: what a mark is, and that the days after it say
   * nothing about the lake.
   */
  marksCaption: (_c: WordsContext): string =>
    'A bright mark is the day a hazard with no recorded end was first reported. How long it stayed on the lake isn’t recorded; the days after it are not a reading of the ice.',

  /**
   * Archived reports with no recorded end, on a strip that marks their first reports. `reported` is
   * the marks the strip draws in all. The read says each hazard's state (B01-3n), so every one is
   * marked; a read from before it did leaves one first reported on the strip's last day (today, or
   * the season's last) a bar until the day after says it was archived, so "each is marked" is said
   * only when every one is — otherwise how many are, and that the rest are counted without one.
   */
  unknownEndsNote: (c: WordsContext): string => {
    const n = c.unknownEnds;
    const lead = c.named ? `${seasonWord(c.season)}: ` : '';
    const marked =
      c.reported >= n
        ? `${n === 1 ? 'It is' : 'Each is'} marked on the day it was first reported`
        : `${c.reported} ${c.reported === 1 ? 'is' : 'are'} marked on the day first reported, and the rest counted that day without a mark`;
    return `${lead}${n === 1 ? '1 archived report has' : `${n} archived reports have`} no recorded end. ${marked}; from then on, every day counts ${n === 1 ? 'it' : 'them'} as unknown: ${n === 1 ? 'the hazard' : 'each hazard'} may still have been on the lake.`;
  },

  /** A count that stopped short. */
  cappedNote: (c: WordsContext): string =>
    `${c.named ? `${seasonWord(c.season)}: ` : ''}The count stopped short of every hazard reported; each day is at least what it shows.`,

  /** Today, under the strips. */
  todayLine: (c: WordsContext): string => `Today: ${HAZARDS_WORDS.day(c)}`,

  /** The archived group's head. */
  archivedGroup: (c: WordsContext): string =>
    c.current ? 'Archived this winter' : `Archived in ${seasonWord(c.season)}`,

  /** The promotion queue's line. */
  patternsLine: (c: WordsContext): string =>
    c.patternsCapped === true
      ? `At least ${c.patterns.toLocaleString('en-US')} patterns on ${c.body} wait in the pre-ice pass; the count stopped short`
      : c.patterns === 0
        ? `No patterns on ${c.body} wait in the pre-ice pass`
        : `${plural(c.patterns, 'pattern', 'patterns')} on ${c.body} ${c.patterns === 1 ? 'waits' : 'wait'} in the pre-ice pass`,
} as const satisfies Record<string, (c: WordsContext) => string>;

/**
 * Words that would make a reported crossing read as a recommendation — that the ridge is safe,
 * passable or fine to cross here. A crossing is a report that someone crossed there, with its age,
 * and nothing more (D3; `ridge_crossing` is a passage marker, never an all-clear).
 */
export const CROSSING_CLAIM =
  /\b(safe|safely|passable|crossable|ok|okay|fine|good|recommended|go|clear|open)\b|(ok|okay|clear|safe|fine|good) to cross|way across/i;

/**
 * **A reported crossing, in plain words** — never the skater app's "Still crossable" or its
 * positive green: the console says someone crossed there, how many said so again, and how long ago.
 */
export const CROSSING_WORDS = {
  /** The row's kicker and the map mark's name. */
  label: 'Reported crossing',
  /** A day's crossings, said on their own: reports that someone crossed, nothing more. */
  live: (n: number): string => (n === 1 ? '1 reported crossing' : `${n} reported crossings`),
  /** How many more skaters reported the same crossing. */
  again: (n: number): string =>
    n === 0 ? 'No other report' : `Reported again ${n === 1 ? 'once' : `${n} times`}`,
} as const;

/**
 * The one place "gone" may appear: the votes people cast on one report, counted and attributed —
 * a hazard row's gone-vote squares, and their column.
 */
export const VOTE_WORDS = {
  goneVotes: (n: number, of: number): string =>
    `${plural(n, 'skater', 'skaters')} voted it gone; ${of} archive it`,
  column: 'Gone votes',
} as const;
