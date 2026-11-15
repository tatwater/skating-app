/**
 * The pilot region's admin areas — the set of 2-letter US state codes a body's `states` field may
 * hold (Phase 02b). Single-sourced here so `waterBodies.importCanonical` refuses any code outside
 * it in a record's `states` (the merge's region rule, D266), and the admin-areas loader any typo in
 * its `--state=XX`, rather than silently persisting a bad code. Widen when a new region's extract is
 * added.
 */

/** The Northeast lake-skating pilot states (Phase 02b): NY, VT, NH, ME, MA. */
export const KNOWN_STATE_CODES = ['NY', 'VT', 'NH', 'ME', 'MA'] as const;

export type StateCode = (typeof KNOWN_STATE_CODES)[number];

const KNOWN_STATE_SET: ReadonlySet<string> = new Set(KNOWN_STATE_CODES);

/** True when `code` is one of the region's known 2-letter state codes (exact, case-sensitive). */
export function isKnownStateCode(code: string): code is StateCode {
  return KNOWN_STATE_SET.has(code);
}
