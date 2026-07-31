/**
 * The skater-facing recurrence advisory (N5c / §9, D78) — **the most consequential copy in the app**,
 * and the reason it lives in one tested module rather than in two components.
 *
 * *"Ridges usually form here"* and *"there is a ridge here"* are different sentences, and only the
 * first is ours to say (D3). Everything below is built to make the second one unwriteable:
 *
 * - **Both numbers, always.** *"3 of the last 4 winters"*, never *"most winters"* and never a bare
 *   *"3 winters"*. The denominator is what stops a reader inflating it, and a template that can drop it
 *   is a template that will.
 * - **Past tense, with a reporter.** *"Skaters have reported…"*, never *"there is…"*, never
 *   *"expect…"*. The subject of the sentence is the people, not the ice.
 * - **The disclaimer is not decoration.** It says the thing a history panel most easily implies and
 *   most badly needs not to: this is not a report of conditions now.
 * - **No invented geography.** The place phrase comes from a named sub-area (N2/D60) or is omitted
 *   entirely. "Near the north end" would be a guess, and a guess about *where* reads as precision.
 *
 * **An advisory is not a hazard.** No confirm buttons, no decay, no freshness chip, no pin, no halo —
 * and it never enters the on-ice payload. The proximity evaluator turns cached hazard rows into
 * *"⚠ hazard ahead"*, and an advisory reaching that path would turn a statement about past winters into
 * a live warning about ice underfoot, which is the exact inversion D3 forbids. That exclusion is
 * structural rather than a guard: advisories come from `hazardRecurrence.listForBody`, a query the
 * on-ice path never subscribes to.
 */

import type { RecurrenceFamily } from './hazardCluster';
import { timingWindowLabel } from './seasonWindow';

/**
 * What a family is called in a sentence about past winters.
 *
 * A **family**, not a hazard type, because that is the honest granularity: a cluster can hold a
 * `pressure_ridge` and an `ice_heave`, and naming one of them would report a detail the record does not
 * actually carry. Phrased to drop into "skaters have reported ___ here".
 */
export const RECURRENCE_FAMILY_PHRASES: Record<RecurrenceFamily, string> = {
  ridge: 'a pressure ridge',
  spring: 'a spring or open current',
  gas: 'a gas hole',
  reef: 'a hole over a reef',
  volatile: 'thin or open ice',
  // No `crack` entry, and the type will not accept one: `RecurrenceFamily` excludes it, because a
  // recurring working crack is not a permanent feature of a lake and there is no cross-season record
  // for the advisory to be about. The compiler holds that line here rather than a comment.
};

/** Everything the advisory renders from. Deliberately small — anything else would tempt a new claim. */
export interface RecurrenceAdvisoryInput {
  family: RecurrenceFamily;
  /** How many distinct winters. Rendered with its denominator or not at all. */
  seasonsObserved: number;
  windowSeasons: number;
  /** The named sub-area the representative sits in. Omitted from the copy when absent. */
  subAreaName?: string;
  /** The interquartile day-of-season range. Rendered only when `showTiming` is set. */
  firstReportedDayOfSeasonP25?: number;
  firstReportedDayOfSeasonP75?: number;
  /**
   * Whether the timing clause clears its bar. The same constant governs this and the advisory itself
   * (D78), so raising it makes both claims more conservative together and they can never disagree.
   */
  showTiming?: boolean;
}

/** The heading. Says what the panel is before it says anything about the lake. */
export const ADVISORY_HEADING = 'Ice history';

/**
 * The disclaimer, and the single most important string in the phase.
 *
 * Two sentences doing two jobs: the first says what kind of statement this is, and the second closes
 * the gap a reader would otherwise fill in themselves — a history panel with nothing beneath it reads
 * as "and it's here now" unless something says otherwise.
 */
export const ADVISORY_DISCLAIMER =
  'This is what skaters reported in past seasons — not a report of conditions now. Nothing has been reported here yet this winter.';

/**
 * The advisory sentence, or `null` when there is nothing honest to say.
 *
 * `null` rather than a shorter sentence when the numbers are missing: an advisory without its
 * denominator is the one form of this copy that is actively misleading, so it is better to render
 * nothing at all than to render it without.
 */
export function recurrenceAdvisory(input: RecurrenceAdvisoryInput): string | null {
  const { family, seasonsObserved, windowSeasons } = input;
  if (seasonsObserved <= 0 || windowSeasons <= 0) return null;
  // A count that exceeds its window would print "5 of the last 4 winters", which reads as a bug and
  // undermines every other number on the surface. Clamped rather than trusted.
  const seasons = Math.min(seasonsObserved, windowSeasons);

  const what = RECURRENCE_FAMILY_PHRASES[family];
  const where = input.subAreaName ? ` near ${input.subAreaName}` : '';
  const winters = `${seasons} of the last ${windowSeasons} winters`;

  const timing =
    input.showTiming === true &&
    input.firstReportedDayOfSeasonP25 !== undefined &&
    input.firstReportedDayOfSeasonP75 !== undefined
      ? timingWindowLabel(input.firstReportedDayOfSeasonP25, input.firstReportedDayOfSeasonP75)
      : null;
  // "first reported <label>", not "between <label>": the label collapses a fully covered month to its
  // bare name ("January"), and "between January" is not a sentence. Past tense here too — the clause
  // is about when people were standing there, not when the ice does anything.
  const when = timing ? `, first reported ${timing}` : '';

  return `Skaters have reported ${what}${where} in ${winters}${when}.`;
}
