/**
 * **The summer aerial's committed lists** (B05 §2.1, §2.1.2, D315): the frames struck by review, and
 * the cells the rule's off-season step may reach.
 *
 * Both are code, not config, so a change to either is a reviewed commit and changes the manifest's
 * `exclusionsHash` or the rule's input — never a flag someone passed once.
 */

import type { NaipExclusion } from './naipSelection';

/**
 * Frames confirmed as cloud or glare (§2.1.2). Empty until the pre-screen: an entry joins only once
 * reviewed — `founder` for a frame that would change a pick, `builder` for a fallback-only one.
 * A score alone never strikes a frame.
 */
export const NAIP_EXCLUSIONS: readonly NaipExclusion[] = [];

/**
 * The six quarter-quads with no leaf-on frame at 0.6 m or better — one north–south strip in Maine's
 * western mountains at 70.53°W, 44.6°N to 45.0°N, running north from Rumford. Flown only in October
 * (2018, 2021, 2023) at 0.6 m or better; their summer frames are 1 m (July 2015), which the rule
 * drops. Each takes its **2 October 2023 frame at 0.3 m** (the founder, 2026-11-25), through the
 * off-season step.
 *
 * Final. The select stage refuses a build in which the off-season step reaches any other cell: a
 * seventh is a look for the founder, never a silent foliage pick.
 */
export const NAIP_OFF_SEASON_CELLS: readonly string[] = [
  '4407028ne',
  '4407020se',
  '4407020ne',
  '4407012ne',
  '4407004se',
  '4407004ne',
];
