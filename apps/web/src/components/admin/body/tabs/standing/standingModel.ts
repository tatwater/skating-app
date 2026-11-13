import {
  INACTIVE_SEASONS,
  retentionReason,
  type Season,
  seasonOf,
  seasonStartMs,
} from '@skating/core';

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
 * What the retention rule reads about one body. `null` is *not recorded* (no read serves it yet),
 * drawn as absent and never as zero; `0` is a real zero.
 */
export type RetentionFacts = {
  /** The newest report, matched track or hazard on the body; `undefined` ⇒ none ever. */
  lastActivity: { at: number; kind: ActivityKind } | undefined | null;
  /** The map boost and when it was set (`at` null when the record doesn't say). */
  curatedBoost: { value: number; at: number | null } | undefined | null;
  /** How many skaters favorited it. */
  favorites: number | null;
  /** How many saved put-ins it has (D245): a visible, unsuppressed stored launch. */
  savedPutIns: number | null;
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

/** How many years ahead the lanes show (board 5.4.8: today to four years on). */
export const RETENTION_YEARS = 4;

const YEAR_MS = 365.25 * 86_400_000;

/** "2029–30" — a season by the years it spans. */
export function seasonWord(season: Season): string {
  return `${season}–${String((season + 1) % 100).padStart(2, '0')}`;
}

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

const DAY_MONTH = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "19 Sep" — a table cell's day-month (Review 13 #7), in the reader's zone. */
export function dayMonth(at: number): string {
  const parts = DAY_MONTH.formatToParts(at);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return `${day} ${month}`;
}

/** "1 Jul 2030" — a rollover, which is a UTC instant, so it reads the same everywhere. */
function rolloverWords(at: number): string {
  const parts = DAY_MONTH_YEAR.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

const KIND_WORD: Record<ActivityKind, string> = {
  report: 'a report',
  track: 'a track',
  hazard: 'a hazard',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
      value: plural(facts.favorites, 'skater', 'skaters'),
      end: null,
    });
  }
  if (facts.savedPutIns !== null && facts.savedPutIns > 0) {
    lanes.push({
      key: 'put_in',
      label: 'Saved put-ins',
      value: plural(facts.savedPutIns, 'put-in', 'put-ins'),
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
    facts.savedPutIns === null && 'saved put-ins',
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
  // Only a complete read may say nothing holds: an unread reason might.
  if (!complete) return '';
  return `Nothing keeps it: the ${rolloverWords(seasonStartMs(seasonOf(now) + 1))} rollover sets it dormant.`;
}

/** "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
