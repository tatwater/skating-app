/**
 * **A reading whose opening failed is opened again while the skater reads** (B03 §9.6), on both
 * apps: the first failure is said; after that, each burst of scrolling may try again, no more often
 * than `TERMS_OPEN_RETRY_GAP_MS`, without a word unless the answer changes where the skater goes
 * (out of date, or an account that can't act). So by the time the end is reached the server
 * normally has the reading, and its end is never stamped in the same breath as its opening. If the
 * end is reached with no opening still, the skater is told why (`terms_not_opened`'s words) and
 * the reading starts again from the top.
 */

/** The least time between two tries at opening a reading. */
export const TERMS_OPEN_RETRY_GAP_MS = 5_000;

/**
 * Whether a failed opening may be tried again at `now`, its last try having started at `lastTryAt`
 * (`null`: never tried). A clock stepped back past the last try waits out the gap again.
 */
export function termsOpenRetryDue(lastTryAt: number | null, now: number): boolean {
  if (lastTryAt === null) return true;
  const since = now - lastTryAt;
  return since >= TERMS_OPEN_RETRY_GAP_MS;
}
