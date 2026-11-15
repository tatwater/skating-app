import {
  INACTIVE_SEASONS,
  retentionReason,
  type Season,
  seasonOf,
  seasonStartMs,
} from '@skating/core';

import { listWords } from '@/lib/words';
import { seasonYears } from '../../../shell/consoleTime';
import { dayMonth, statusDate } from '../../frame/bodyModel';

/**
 * The Standing tab's arithmetic: what keeps an active body active at each 1 July rollover, laid on
 * the years ahead. Pure, with `now` passed in.
 *
 * The rule is core's `retentionReason` (D177, D245): any one of use within the last
 * `INACTIVE_SEASONS` completed seasons, a positive map boost, a favorite or a saved put-in keeps an
 * active body active. Three of those hold until someone takes them away, so their lanes run off
 * the end; use lapses on a date the calendar alone decides, so its lane stops there.
 */

/** What the use was, for the lane's value ("a report"). */
export type ActivityKind = 'report' | 'track' | 'hazard';

/**
 * What keeps a body active. `standing.retentionForBody` returns exactly these fields, and every one
 * is kept. `waterBodies.get`'s standing, its reason, note and dates are the tab's; the rest of the
 * record is the frame's or another tab's.
 */
/**
 * What the retention rule reads about one body. `null` is *not recorded* (no read serves it yet),
 * drawn as absent and never as zero; `0` is a real zero.
 */
export type RetentionFacts = {
  /** The newest report, matched track or hazard on the body; `undefined` ⇒ none ever. */
  lastActivity: { at: number; kind: ActivityKind } | undefined | null;
  /** The map boost and when it was set (`at` null when the record doesn't say). */
  curatedBoost: { value: number; at: number | null } | undefined | null;
  /** How many skaters favorited it — counted to {@link FAVORITES_COUNTED}, then a floor. */
  favorites: number | null;
  /** The count stopped at its most: there are at least `favorites`, drawn "1,000+". */
  favoritesCapped?: boolean;
  /** How many saved put-ins it has (D245): a visible, unsuppressed stored launch. */
  savedPutIns: number | null;
  /** The saved put-ins read stopped at its most: there are at least `savedPutIns`, drawn "1,000+". */
  savedPutInsCapped?: boolean;
  /**
   * Whether its put-ins keep it active at the rollover — **the rollover's own answer**
   * (`putInKeeps`), never inferred from the count above (a hidden put-in doesn't keep it; a body
   * past the rollover's bounds is kept though this tab counts it whole). `null`: not recorded.
   */
  putInKeeps: boolean | null;
};

export type RetentionLane = {
  key: 'curated' | 'favorited' | 'put_in' | 'activity';
  label: string;
  value: string;
  /** Where it stops holding: the rollover it fails at. `null` holds until someone changes it. */
  end: number | null;
  endLabel?: string;
};

export type RetentionModel = {
  start: number;
  end: number;
  /** Each 1 July inside the window — every one a rollover. */
  rollovers: { at: number; label: string }[];
  lanes: RetentionLane[];
  /** The line under the lanes; empty when the read is incomplete and nothing read holds. */
  foot: string;
  /** What no read serves yet, in words, or `null` when everything was read. */
  notRecorded: string | null;
};

/** How far the server counts favorites before it says it stopped (`standing.retentionForBody`). */
export const FAVORITES_COUNTED = 1_000;

/** How many years ahead the lanes show (board 5.4.8: today to four years on). */
export const RETENTION_YEARS = 4;

const YEAR_MS = 365.25 * 86_400_000;

/** "2029–30" — a season by the years it spans (the console's one season word). */
export const seasonWord: (season: Season) => string = seasonYears;

/** The last season use at `at` keeps a body active into: `seasonOf(at) + INACTIVE_SEASONS`. */
export function activityHoldsThrough(at: number): Season {
  return seasonOf(at) + INACTIVE_SEASONS;
}

/** The rollover use at `at` stops holding at — the start of the season after it holds through. */
export function activityLapsesAt(at: number): number {
  return seasonStartMs(activityHoldsThrough(at) + 1);
}

/** Each 1 July (UTC, the season boundary) in `(start, end]`. */
export function rolloversBetween(start: number, end: number): number[] {
  const out: number[] = [];
  for (let s = seasonOf(start) + 1; seasonStartMs(s) <= end; s++) out.push(seasonStartMs(s));
  return out;
}

/** "1 Jul 2030" — a rollover, which is a UTC instant, so it reads the same everywhere. */
const rolloverWords = (at: number): string => statusDate(at, 'UTC');

const KIND_WORD: Record<ActivityKind, string> = {
  report: 'a report',
  track: 'a track',
  hazard: 'a hazard',
};

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The lanes for an **active** body. A reason that doesn't hold draws no lane; a reason nobody has
 * read yet draws none either, and is named in `notRecorded` so the foot never claims more than it
 * knows.
 */
export function retentionModel(facts: RetentionFacts, now: number): RetentionModel {
  const start = now;
  const end = now + RETENTION_YEARS * YEAR_MS;
  const rollovers = rolloversBetween(start, end).map((at) => ({
    at,
    label: String(new Date(at).getUTCFullYear()),
  }));

  const lanes: RetentionLane[] = [];
  const boost = facts.curatedBoost;
  if (boost && boost.value > 0) {
    lanes.push({
      key: 'curated',
      label: 'Map boost',
      value: boost.at === null ? String(boost.value) : `${boost.value} · ${dayMonth(boost.at)}`,
      end: null,
    });
  }
  if (facts.favorites !== null && facts.favorites > 0) {
    lanes.push({
      key: 'favorited',
      label: 'Favorites',
      // Past the count's end the number is a floor, never presented as whole.
      value: facts.favoritesCapped
        ? `${facts.favorites.toLocaleString('en-US')}+ skaters`
        : plural(facts.favorites, 'skater', 'skaters'),
      end: null,
    });
  }
  // The lane stands on the rollover's own answer; the count only says how many there are.
  if (facts.putInKeeps === true) {
    lanes.push({
      key: 'put_in',
      label: 'Saved put-ins',
      // Past the read's end the number is a floor, never presented as whole.
      value:
        facts.savedPutIns === null || facts.savedPutIns === 0
          ? 'Keeps it'
          : facts.savedPutInsCapped
            ? `${facts.savedPutIns.toLocaleString('en-US')}+ put-ins`
            : plural(facts.savedPutIns, 'put-in', 'put-ins'),
      end: null,
    });
  }
  const activity = facts.lastActivity;
  const activityHolds =
    activity != null &&
    retentionReason(
      { lastActivityAt: activity.at, favorited: false, hasPutIn: false },
      seasonOf(now) + 1,
    ) === 'activity';
  if (activity && activityHolds) {
    const lapses = activityLapsesAt(activity.at);
    lanes.push({
      key: 'activity',
      label: 'On the water',
      value: `${dayMonth(activity.at)} · ${KIND_WORD[activity.kind]}`,
      end: lapses,
      endLabel: `Until the ${rolloverWords(lapses)} rollover`,
    });
  }

  const missing = [
    facts.curatedBoost === null && 'the map boost',
    facts.favorites === null && 'favorites',
    facts.putInKeeps === null && 'saved put-ins',
    facts.lastActivity === null && 'the last report',
  ].filter((m): m is string => m !== false);

  return {
    start,
    end,
    rollovers,
    lanes,
    foot: footFor(lanes, activity && activityHolds ? activity : null, now, missing.length === 0),
    notRecorded: missing.length === 0 ? null : listWords(missing),
  };
}

function footFor(
  lanes: readonly RetentionLane[],
  activity: { at: number; kind: ActivityKind } | null,
  now: number,
  complete: boolean,
): string {
  const holds = lanes.some((l) => l.end === null);
  if (activity !== null) {
    const through = seasonWord(activityHoldsThrough(activity.at));
    const word = KIND_WORD[activity.kind].replace(/^a /, 'The ');
    return holds
      ? `Any one keeps it. ${word} alone holds through ${through}.`
      : `${word} keeps it through ${through}.`;
  }
  if (holds) return 'Any one keeps it.';
  // Only a complete read may say none of these holds: an unread reason might. And it says only
  // that: the rollover counts its own put-ins (hidden ones too), so the tab never words its
  // numbers as the rollover's reason.
  if (!complete) return '';
  return `None of these keeps it. The ${rolloverWords(seasonStartMs(seasonOf(now) + 1))} rollover decides by its own count.`;
}
