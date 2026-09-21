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
 * The current table — §1.3's first run (2026-09-21): the Claude + Jev pipeline over the 147-email
 * stratified sample, scored against Sonnet-drafted (unverified) value labels, loose match. Only
 * fields that reached their target precision with ≥ 10 supporting values have a floor; the rest
 * stay ghosts. Thickness reached 90% at 0.98 on one pass and lost it on the re-run (support 10 on
 * the line), so it has no floor until the verified labels say. The phase doc's §1.4 record has the
 * tables; `training_data/google_group/eval/` has the runs. Re-set from the verified labels.
 */
export const PRECISION_FLOORS: PrecisionFloors = {
  setOn: '2026-09-21',
  basis: 'provisional',
  fromRun: 'jev:haiku × sample-150 (seed 20260921) vs claude:sonnet draft labels',
  fields: {
    iceTypes: 0.93, // 81% precision, 121 values
    surfaceTags: 0.99, // 82%, 38
    hazards: 0.98, // 94%, 17
    accessConditions: 0.66, // 80%, 10
  },
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
