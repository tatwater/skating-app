/**
 * **A reading whose opening failed is opened again while the skater reads** (B03 §9.6), on both
 * apps: the first failure is said; after that, each burst of scrolling may try again, no more often
 * than `TERMS_OPEN_RETRY_GAP_MS`, without a word unless the answer stops the step (out of date). So
 * by the time the end is reached the server normally has the reading. An end reached while an
 * opening is out never counts on it: once it answers, the end marker must leave the screen and
 * come back, so the end is never stamped in the same breath as its opening. If the end is reached
 * with no opening still, the skater is told why (`terms_not_opened`'s words) and the reading starts
 * again from the top — or, when the account can't act right now, the server's own words, and
 * nothing restarts.
 */

/** The least time between two tries at opening a reading. */
export const TERMS_OPEN_RETRY_GAP_MS = 5_000;

/**
 * Whether a failed opening may be tried again at `now`, its last try having started at `lastTryAt`
 * (`null`: never tried). A clock set back past the last try is due at once: waiting for it to pass
 * the last try again would stop the retries for as long as the step back.
 */
export function termsOpenRetryDue(lastTryAt: number | null, now: number): boolean {
  if (lastTryAt === null) return true;
  const since = now - lastTryAt;
  return since < 0 || since >= TERMS_OPEN_RETRY_GAP_MS;
}
