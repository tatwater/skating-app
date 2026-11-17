/**
 * **Each day's words added by B01-2b** — the bounties row and the Reports row's vantage line, in one
 * place for the founder's copy pass. From the Seasons board's Statistics where it has them ("All from
 * shore · none on the ice yet", the founder's call of 2026-11-17 keeping "yet"); the rest — marked *not
 * on the board* — are the plainest parallel forms, and are listed in the phase doc until reviewed.
 *
 * A vantage is never ranked: the parts go in the app's one order (on the ice, from shore,
 * secondhand), in one ink, and none is said to be better. Looking forward to reports from the ice is
 * this line's purpose (the founder); saying ice is safe or ready never is.
 */

import type { VantageCounts } from './metricsModel';

/** The contributors row's two-item legend: solid under outlined — *not on the board*. */
export const CONTRIBUTORS_RETURNING = 'Returning';
export const CONTRIBUTORS_NEW = 'New';

/** The hover plate's row for a day's first-timers — *not on the board*. */
export const NEW_CONTRIBUTORS_ROW = 'New contributors';

/** The contributors total's sub-line: the board's "2 new · 4 returning". */
export const contributorsSplitSub = (fresh: number, total: number) =>
  `${fresh.toLocaleString('en-US')} new · ${Math.max(0, total - fresh).toLocaleString('en-US')} returning`;

/** The row's label (the board's "Bounties"). */
export const BOUNTIES_LABEL = 'Bounties';

/** The row's two-item legend: the bar, then the outlined bar — *not on the board*. */
export const BOUNTIES_POSTED = 'Posted';
export const BOUNTIES_FULFILLED = 'Fulfilled';

/** The hover plate's two rows — *not on the board*. */
export const BOUNTIES_POSTED_ROW = 'Bounties posted';
export const BOUNTIES_FULFILLED_ROW = 'Bounties fulfilled';

/**
 * The season total's sub-line under the posted count (the board's "1 opened · 0 fulfilled", said as
 * posted): "Posted · 1 fulfilled"; a fulfilled total not recorded says so — *not on the board*.
 */
export const bountiesTotalSub = (fulfilled: number | null) =>
  fulfilled === null
    ? 'Posted · fulfilled not recorded yet'
    : `Posted · ${fulfilled.toLocaleString('en-US')} fulfilled`;

/**
 * The total said whole, for a reader: "3 posted · 1 fulfilled"; a total not recorded says so
 * ("Posted not recorded yet · 1 fulfilled") — never a zero.
 */
export const bountiesTotalWords = (posted: number | null, fulfilled: number | null) =>
  `${posted === null ? 'Posted not recorded yet' : `${posted.toLocaleString('en-US')} posted`} · ${
    fulfilled === null
      ? 'fulfilled not recorded yet'
      : `${fulfilled.toLocaleString('en-US')} fulfilled`
  }`;

/** What a strip of each vantage is called in the line, in the app's one order. */
const VANTAGE_PHRASE = {
  on_ice: 'on the ice',
  shore: 'from shore',
  secondhand: 'secondhand',
  unstated: 'not stated',
} as const;

/**
 * The Reports row's vantage line. The board's sentence exactly when every report this season was
 * from shore: "All from shore · none on the ice yet". Otherwise — *not on the board* — each vantage
 * with a report, in the app's order ("2 on the ice · 11 from shore · 1 secondhand"); one vantage
 * holding every report is "All …"; and while none is from the ice the line ends as the board's does,
 * "none on the ice yet". `null` with no reports.
 */
export function vantageLine(counts: VantageCounts): string | null {
  const order = ['on_ice', 'shore', 'secondhand', 'unstated'] as const;
  const total = order.reduce((sum, k) => sum + counts[k], 0);
  if (total === 0) return null;
  const parts = order.filter((k) => counts[k] > 0);
  const said =
    parts.length === 1 && parts[0] !== 'unstated'
      ? [`All ${VANTAGE_PHRASE[parts[0] as Exclude<(typeof parts)[number], 'unstated'>]}`]
      : parts.map((k) => `${counts[k].toLocaleString('en-US')} ${VANTAGE_PHRASE[k]}`);
  if (counts.on_ice === 0) said.push('none on the ice yet');
  return said.join(' · ');
}
