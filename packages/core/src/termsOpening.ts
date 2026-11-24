/**
 * **A reading whose opening failed is opened again while the skater reads** (B03 §9.6), on both
 * apps: the first failure is said; after that, each burst of scrolling may try again, no more often
 * than `TERMS_OPEN_RETRY_GAP_MS`, without a word unless the answer stops the step (out of date). So
 * by the time the end is reached the server normally has the reading. An end reached while an
 * opening is out waits for its answer: the reading's first opening, answered, stamps the end then;
 * a retry's answer, either way, means most of the text was read with no reading on the server. If
 * the end is reached with no opening (or on a retry's answer), the skater is told why —
 * `terms_not_opened`'s words, or the server's own when the account can't act right now — and the
 * reading starts again from the top, its end counting once the marker has left and been reached
 * again. The stamps say when the server heard, not how long the reading took: a device offline for
 * the whole read sends its opening and its end on reconnect, and both land together.
 */

/** The least time between two tries at opening a reading. */
export const TERMS_OPEN_RETRY_GAP_MS = 5_000;

/**
 * How long a reached end may wait on the server — its opening not yet answered, or its stamp still
 * out (the device offline) — before a quiet line under the agreement says why the box is still
 * locked (`ONBOARDING_COPY.terms.stillConnecting`), on both apps.
 */
export const TERMS_WAITING_LINE_MS = 3_000;

/**
 * The waiting line's timer, the rule both apps' effects run: while `waiting` (a reached end still
 * waiting on the server), calls `show` once it has lasted `TERMS_WAITING_LINE_MS`. Returns the
 * cancel, for the effect's cleanup (a no-op when not waiting).
 */
export function scheduleTermsWaitingLine(waiting: boolean, show: () => void): () => void {
  if (!waiting) return () => {};
  const timer = setTimeout(show, TERMS_WAITING_LINE_MS);
  return () => clearTimeout(timer);
}

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
