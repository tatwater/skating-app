/**
 * **The summer aerial's committed lists** (B05 §2.1, §2.1.2, D315): the frames struck by review, and
 * the cells the rule's off-season step may reach.
 *
 * Both are code, not config, so a change to either is a reviewed commit and changes the manifest's
 * `exclusionsHash` or the rule's input — never a flag someone passed once.
 */

import type { NaipExclusion } from './naipSelection';

/**
 * Frames confirmed as cloud or glare (§2.1.2). An entry joins only once reviewed — `founder` for a
 * frame that would change a pick, `builder` for a fallback-only one. A score alone never strikes a
 * frame.
 *
 * **The first review (the founder, 2026-11-25)**, of the 60 picks over 3% white on the contact
 * sheet of the first catalog walk (`naip-20261125`):
 *
 * - **Struck:** the two Aroostook picks below, cumulus and their shadows on 22 September 2023; each
 *   falls back to its clear 31 August 2021 0.6 m frame.
 * - **Kept, on purpose — do not re-raise:** the 23 Long Island and New York City picks the
 *   pre-screen thought real (19 of 2 July 2024 and 2 of 13 September 2024 with sun glare on the
 *   bays, 2 with small cumulus over Queens and the East River). The founder: glare and cloud there
 *   don't matter, because nobody skates that water. Also kept: the borderline sea glint off
 *   `4106917sw` and the 35 false positives (dunes, beaches, airports, roofs, gravel pits, Niagara
 *   Falls). The pre-screen's file beside that sheet records each verdict.
 * - **Open:** `4606741sw`, the third Aroostook cell of the same day, scored 2.3% (under the sheet's
 *   threshold); it is a question for the founder, not struck.
 */
export const NAIP_EXCLUSIONS: readonly NaipExclusion[] = [
  // Cumulus and shadow (Aroostook, 22 September 2023) → ME 2021-08-31 at 0.6 m.
  {
    itemId: 'me_m_4606741_se_19_030_20230922_20240103',
    reason: 'cloud',
    reviewedBy: 'founder',
    reviewedOn: '2026-11-25',
  },
  {
    itemId: 'me_m_4606741_ne_19_030_20230922_20240103',
    reason: 'cloud',
    reviewedBy: 'founder',
    reviewedOn: '2026-11-25',
  },
];

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
