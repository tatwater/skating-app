/**
 * **The Bodies list's and preview's words added by the follow-up (B01-3e)** — a search's other
 * standings, Opened recently's ids the library didn't list, and a removed body's record on the
 * preview. In one place for the founder to read; listed in the phase doc until reviewed.
 */

/** Said after the tally when the other standings were counted across the lane's facets. */
export const OTHERS_UNFILTERED = ' (other standings unfiltered)';

/** The other standings' read failed: said in the groups' place, with Try again. */
export const OTHERS_FAILED = 'Other standings couldn’t be checked';

/**
 * "1 opened isn't in the library · 1 is no longer a body": Opened recently's ids the library
 * didn't list, said rather than dropped.
 */
export function notListedWords(
  n: { unlisted: number; unknown: number; dropped: number } | undefined,
): string | null {
  if (n === undefined) return null;
  const parts = [
    n.unlisted > 0 &&
      `${n.unlisted} opened ${n.unlisted === 1 ? 'isn’t' : 'aren’t'} in the library`,
    n.unknown > 0 && `${n.unknown} ${n.unknown === 1 ? 'is' : 'are'} no longer a body`,
    n.dropped > 0 && `${n.dropped} older not read`,
  ].filter((p): p is string => p !== false);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The removed body's record couldn't be read. */
export const RECORD_FAILED = 'What its record still holds couldn’t be read';

/** A removed body's report floor, in the console's words for the same count. */
export const reportsSinceWords = (count: string): string => `${count} since the record began`;
