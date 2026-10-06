/** A site's own calendar day, for Open-Meteo's local-day series (A06i). */

/**
 * The site's own calendar day right now. ⚠ **Today's low is a forecast** — the night is not over —
 * so it is dropped before anything is stored or decided (D140: observed, never forecast). Keeping it
 * would let a forecast 19 °F record the one-way imagery-line date and send its email before the
 * night had happened.
 */
export function siteToday(nowMs: number, utcOffsetSeconds = 0): string {
  return new Date(nowMs + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}
