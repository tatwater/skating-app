/**
 * **The summer aerial's committed lists** (B05 §2.1.2, §2.1.4, D315, D319): the frames struck by the
 * cloud review and those it kept, and the flights and frames struck by the foliage review.
 *
 * Both are code, not config, so a change to either is a reviewed commit and changes the manifest's
 * `exclusionsHash` or the rule's input — never a flag someone passed once.
 */

import type { NaipExclusion, NaipFoliageStrike } from './naipSelection';

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
 * The 23 Long Island and New York City picks the founder's cloud review **kept on purpose**
 * (2026-11-25): real sun glare or small cumulus, but *glare and cloud there don't matter, because
 * nobody skates that water*. Committed so no later screen raises or strikes them — the foliage screen
 * (D319) never proposes one, though three are September frames and the city reads as not green.
 */
export const NAIP_CLOUD_KEPT: readonly string[] = [
  // Sun glare on the bays and marsh channels, 2 July 2024.
  'ny_m_4007325_ne_18_060_20240702',
  'ny_m_4007325_sw_18_060_20240702',
  'ny_m_4007326_ne_18_060_20240702',
  'ny_m_4007326_nw_18_060_20240702',
  'ny_m_4007327_ne_18_060_20240702',
  'ny_m_4007327_nw_18_060_20240702',
  'ny_m_4007328_ne_18_060_20240702',
  'ny_m_4007328_nw_18_060_20240702',
  'ny_m_4007329_ne_18_060_20240702',
  'ny_m_4007329_nw_18_060_20240702',
  'ny_m_4007330_ne_18_060_20240702',
  'ny_m_4007330_nw_18_060_20240702',
  'ny_m_4007331_nw_18_060_20240702',
  'ny_m_4007430_se_18_060_20240702',
  'ny_m_4007431_nw_18_060_20240702',
  'ny_m_4007431_se_18_060_20240702',
  'ny_m_4007431_sw_18_060_20240702',
  'ny_m_4007432_ne_18_060_20240702',
  'ny_m_4007432_sw_18_060_20240702',
  // Small cumulus over Queens, 2 July 2024, and over the East River shore, 13 September 2024.
  'ny_m_4007317_sw_18_060_20240702',
  'ny_m_4007317_nw_18_060_20240913',
  // Glare over the bay, 13 September 2024.
  'ny_m_4007438_ne_18_060_20240913',
  'ny_m_4007439_nw_18_060_20240913',
];

/**
 * **The founder's foliage review** (§2.1.4, D319): flights and frames flown leaf-on by the calendar
 * but already in autumn color or brown, struck so the cell falls back to its next green frame. The
 * foliage screen (`pnpm --filter @skating/aerial foliage <campaign>`) scores every candidate flown
 * from 1 September, proposes the turned ones by flight day, and writes the review sheet; an entry
 * joins here only once he has confirmed it (`reviewedBy: 'founder'`). Mostly whole flight days, one
 * entry each, with per-frame exceptions either way (`keep` on a struck day; a frame entry on a day
 * not struck).
 *
 * **Empty: awaiting his first review** of the proposal for `naip-20261127`
 * (`scripts/aerial/review/naip-20261127-foliage-proposed.json`, threshold 0.6).
 *
 * Where striking leaves a cell no leaf-on frame that isn't struck, the cell keeps its newest
 * sharpest leaf-on frame through the off-season step (`allTurned`) — the founder's ruling for
 * western Maine's 27 September 2023 cells, which have no green frame at 0.6 m or better. The six
 * October cells north of Rumford reach the same step because nothing there was flown leaf-on at
 * 0.6 m or better (`noLeafOn`), and keep their 2 October 2023 frames at 0.3 m. Neither is a list:
 * the rule says it, and every run names the cells.
 */
export const NAIP_FOLIAGE_STRIKES: readonly NaipFoliageStrike[] = [];
