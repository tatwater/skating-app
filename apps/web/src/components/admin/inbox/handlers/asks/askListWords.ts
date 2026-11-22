import { countOf } from '../../words/inboxWords';

/**
 * **The ask list's words** — shared by the request handler (2.3) and the place handler (2.4), so an
 * ask reads the same in both. From the board (2.3's *The ask*): the byline's "12 Oct · 2 d ago" and
 * *With a recorded skate*. The rest is invented, for the founder's copy pass.
 */
export const ASK_LIST_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  /** An ask's time on its byline: "12 Oct · 2 d ago". */
  when: (day: string, age: string) => `${day} · ${age} ago`,
  /** An ask filed with a recorded skate (the board adds "· 2.1 km · 48 min", which no read serves). */
  withSkate: 'With a recorded skate',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  /** An asker whose profile is gone: no name, no handle, never a made-up person. */
  goneAsker: 'A former skater',
  /** An ask filed from a report's where (a landmark ask, D202). */
  fromReport: (day: string) => `From their report · ${day}`,
  /** Under a list the server cut short: how many of how many are shown ("500+" past its count). */
  shownOf: (shown: number, total: number, floor: boolean) =>
    `Showing ${countOf(shown)} of ${countOf(total, floor)} asks`,
  /** The list's accessible name. */
  list: 'The asks',
} as const;
