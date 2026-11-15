import { type Count, countText } from '../overview/overviewModel';

/**
 * **The three answers that aren't a number**, worded once for both People pages (the list's words in
 * `list/peopleWords.ts`, the person page's in `person/personWords.ts` read these):
 *
 * - **Not ready** — a backfill after a deploy hasn't finished, so a figure resting on it may be
 *   *wrong*: {@link STILL_PREPARING}, never a number, never a "+".
 * - **A floor** — a read stopped at its cap: {@link floorText}, "200+" (the console's count form).
 * - **Not recorded** — nothing on record: {@link NOT_RECORDED}, never a zero.
 *
 * And the few words both pages say of the same fact ({@link ranItsCourse}).
 */

export const STILL_PREPARING = 'Still being prepared';
export const NOT_RECORDED = 'Not recorded yet';

/** A count as every People figure writes it: "283", "1,204", or "200+" once a read stopped short. */
export const floorText = (count: Count): string => countText(count);

// ── Words both pages say ─────────────────────────────────────────────────────────────────────

/**
 * A suspension whose end has passed but which the lapse sweep hasn't lifted yet (it runs every
 * fifteen minutes): never its end date as if it were still ahead.
 */
export const ranItsCourse = (moment: string) => `Ran its course ${moment} · lifting on its own`;
