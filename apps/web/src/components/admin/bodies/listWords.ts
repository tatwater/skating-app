/**
 * **The Bodies list's and preview's words added by the follow-up (B01-3e)** — a search's other
 * standings, Opened recently's ids the library didn't list (each by name since B01-3n), and a
 * removed body's record on the preview. In one place for the founder to read; listed in the phase
 * doc until reviewed.
 */

import type { NotListed } from './bodiesData';

/** Said after the tally when the other standings were counted across the lane's facets. */
export const OTHERS_UNFILTERED = ' (other standings unfiltered)';

/** The other standings' read failed: said in the groups' place, with Try again. */
export const OTHERS_FAILED = 'Other standings couldn’t be checked';

/**
 * The way from a group's best matches to all of them, in their lane's own list: "See all 26 in
 * Dormant · inactive" (the lane by its sidebar words; "50+" when the count is a floor).
 */
export function seeAllWords(count: string, laneLabel: string): string {
  return `See all ${count} in ${laneLabel}`;
}

/** The list's end under a search this lane has no match for, while other standings do. */
export const NOTHING_HERE_MATCHES = (q: string) => `Nothing here matches “${q}”`;

/** A body opened here that the read gave no name for (a read from before it named them). */
export const UNNAMED_OPENED = 'A body opened here';

/** One body the library didn't list, by name, with why. */
function notListedBody(b: NotListed['bodies'][number]): string {
  if (b.why === 'merged') {
    return b.survivor === null
      ? `${b.name} was merged into a body that can’t be found`
      : `${b.name} was merged into ${b.survivor}, which isn’t listed yet`;
  }
  if (b.why === 'removed') return `${b.name} was removed and isn’t listed yet`;
  if (b.why === 'rejected') return `${b.name} was rejected and isn’t listed yet`;
  return `${b.name} isn’t listed yet`;
}

/**
 * Opened recently's ids the library didn't list, said rather than dropped: each body by name with
 * why it isn't listed ("Old Lake was merged into Lake Morey, which isn't listed yet"), then the ids
 * that are no body ("1 opened body no longer exists") and those past one read ("1 older not read").
 */
export function notListedWords(n: NotListed | undefined): string | null {
  if (n === undefined) return null;
  const parts = [
    ...n.bodies.map(notListedBody),
    n.unknown > 0 &&
      (n.unknown === 1
        ? '1 opened body no longer exists'
        : `${n.unknown} opened bodies no longer exist`),
    n.dropped > 0 && `${n.dropped} older not read`,
  ].filter((p): p is string => typeof p === 'string');
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The removed body's record couldn't be read. */
export const RECORD_FAILED = 'What its record still holds couldn’t be read';

/** A removed body's report floor, in the console's words for the same count. */
export const reportsSinceWords = (count: string): string => `${count} since the record began`;

/** The way back to the list from an open body on a narrow screen, where the body takes the page. */
export const BACK_TO_LIST = 'Back to the list';
