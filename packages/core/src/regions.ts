/**
 * The pilot region's admin areas — the set of 2-letter US state codes a body's `states` field may
 * hold (Phase 2.5). Single-sourced here so both the ETL loader (which tags a batch via `--state=XX`)
 * and `waterBodies.importCanonical` (which unions the tag into `states`) reject the same typos,
 * rather than silently persisting a bad code into every body's `states`. Widen when a new region's
 * extract is added.
 */

/** The Northeast lake-skating pilot states (Phase 2.5): NY, VT, NH, ME, MA. */
export const KNOWN_STATE_CODES = ['NY', 'VT', 'NH', 'ME', 'MA'] as const;

export type StateCode = (typeof KNOWN_STATE_CODES)[number];

const KNOWN_STATE_SET: ReadonlySet<string> = new Set(KNOWN_STATE_CODES);

/** True when `code` is one of the region's known 2-letter state codes (exact, case-sensitive). */
export function isKnownStateCode(code: string): code is StateCode {
  return KNOWN_STATE_SET.has(code);
}
