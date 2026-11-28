/**
 * **Why a cron's piece of work failed** (D345, D349, B01-8c): the one vocabulary a weather job sorts
 * its failures by, so a run row carries *3 · timed out* rather than three log lines, and the page's
 * words are the web's.
 *
 * - `timeout` — an attempt's deadline passed, or Convex's fetch timed out.
 * - `rateLimit` — HTTP 429.
 * - `serverError` — any 5xx.
 * - `refused` — any other 4xx.
 * - `unreachable` — the connection failed (DNS, reset, refused socket).
 * - `badAnswer` — the body didn't parse, or was cut off.
 * - `emptyAnswer` — a 200 with no usable hour.
 * - `writeFailed` — a Convex write threw (a write conflict, a limit).
 * - `other` — anything else.
 *
 * Single-sourced here; the Convex package's `lib/enums.ts` re-exports it for the schema.
 */

export const CRON_FAILURE_CAUSES = [
  'timeout',
  'rateLimit',
  'serverError',
  'refused',
  'unreachable',
  'badAnswer',
  'emptyAnswer',
  'writeFailed',
  'other',
] as const;
export type CronFailureCause = (typeof CRON_FAILURE_CAUSES)[number];

/** A sample's text, in characters: the recorder trims to it. */
export const CRON_CAUSE_SAMPLE_MAX = 300;

/**
 * One cause's tally on a run: how many items failed for it, and the first one seen. `sampleKey` is a
 * cell key, a state code or a hazard id — never content.
 */
export interface CronCauseTally {
  cause: CronFailureCause;
  count: number;
  sampleKey?: string;
  sampleText: string;
  sampleAt: number;
}

/** What a failed piece of work looked like: an HTTP status, a thrown value, or a 200 with nothing in it. */
export interface FetchFailure {
  status?: number;
  error?: unknown;
  empty?: boolean;
}

/**
 * The cause of one failure — the one rule every weather job sorts by.
 *
 * PLACEHOLDER (B01-8c-1 seams): answers `other` for everything; the chain's builder writes the rule
 * and its property tests.
 */
export function fetchFailureCause(_failure: FetchFailure): CronFailureCause {
  return 'other';
}
