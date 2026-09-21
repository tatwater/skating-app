/**
 * Per-field precision floors (A10 §1.4 / D188) — the confidence at or above which an extracted
 * value arrives **pre-selected** on the sheet, and below which it is a ghost.
 *
 * A wrong ghost chip costs a tap to dismiss; a wrong *confident* chip on thickness is a claim we
 * suggested. So the floors are per field, set from the eval's measured precision, and the
 * safety-flavored fields (thickness, suitability, sighting, hazards) get the strictest. **They are
 * set from a run, never before it**: an absent floor means "everything is a ghost", which is the
 * safe default and what `DEFAULT_PRECISION_FLOOR` in the sheet reducer enforces.
 *
 * `basis` says how much to trust the table: `provisional` floors come from Sonnet-drafted labels
 * (the harness proven, the numbers indicative); `verified` floors come from the founder's
 * verification pass. Nothing ships to a skater on a provisional floor — A10-4 checks `basis`.
 */

import type { ExtractedFieldKey } from './contract';

export interface PrecisionFloors {
  /** ISO date the table was set. */
  setOn: string;
  basis: 'provisional' | 'verified';
  /** The eval run the numbers came from, for the phase doc. */
  fromRun?: string;
  fields: Partial<Record<ExtractedFieldKey, number>>;
}

/**
 * The current table. Empty until §1.3's first run fills it — see the phase doc's §1.4 record for
 * the numbers and the run they came from.
 */
export const PRECISION_FLOORS: PrecisionFloors = {
  setOn: '2026-09-21',
  basis: 'provisional',
  fields: {},
};

/** The D188 tier a confidence earns for a field under a floors table. No floor ⇒ ghost. */
export function tierFor(
  field: ExtractedFieldKey,
  confidence: number,
  floors: PrecisionFloors = PRECISION_FLOORS,
): 'extracted' | 'ghost' {
  const floor = floors.fields[field];
  return floor !== undefined && confidence >= floor ? 'extracted' : 'ghost';
}
