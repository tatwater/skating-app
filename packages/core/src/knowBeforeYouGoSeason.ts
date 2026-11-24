/**
 * **When Know Before You Go is due** (D296, B03 §9.3). Pure: every instant is an argument, so the
 * rule is the same on the server, in both apps and in a test with a pinned clock (D243).
 *
 * The anchor is the Ice Watch's opening — `detectedAt` on the live `imageryIngestSeasons` row with
 * the greatest season, the instant the system recorded it (not `opensOn`, a backdated observation).
 * A reset moves that row aside, which postpones the opening, so a superseded row never anchors; the
 * caller passes `null` until a season is open again. Answers given in the 30 days before the anchor
 * count toward it, so someone who joins in early November isn't asked again a fortnight later.
 */

import { seasonStartYear } from './seasonWatch';

/** How long before a season's opening a completion still counts for it: 30 × 24 hours, elapsed. */
export const KNOW_BEFORE_YOU_GO_EARLY_MS = 30 * 24 * 60 * 60 * 1000;

/** The Ice Watch's newest live opening, as the rule needs it. */
export interface KnowBeforeYouGoWatch {
  /** Epoch ms the system recorded the opening (`detectedAt`). */
  openedAt: number;
}

/**
 * Why the questions are due, or `null` when they aren't:
 * - `'never'` — never answered (`lastAt` undefined): asked whatever the watch says, and the screen
 *   opens straight on the first question;
 * - `'season'` — answered, but before this season's window: the screen opens on *A new season on the
 *   ice*;
 * - `null` — no season has opened (`watch` null), or the last answer is on or after
 *   `watch.openedAt − KNOW_BEFORE_YOU_GO_EARLY_MS`.
 */
export type KnowBeforeYouGoDue = 'never' | 'season';

export function knowBeforeYouGoDue(
  lastAt: number | undefined,
  watch: KnowBeforeYouGoWatch | null,
): KnowBeforeYouGoDue | null {
  if (lastAt === undefined) return 'never';
  if (watch === null) return null;
  return lastAt >= watch.openedAt - KNOW_BEFORE_YOU_GO_EARLY_MS ? null : 'season';
}

/**
 * The season card's kicker for a watch season key: `winter-2027-28` → "Winter 2027–28" (an en dash,
 * as drawn). Throws on anything that isn't a season key, as `seasonStartYear` does.
 */
export function watchSeasonTitle(season: string): string {
  const start = seasonStartYear(season);
  return `Winter ${start}–${season.slice(-2)}`;
}
