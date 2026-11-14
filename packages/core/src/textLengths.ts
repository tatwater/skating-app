/**
 * How long people's capped texts actually are (B01, the founder's ruling of 2026-11-14): "tons of
 * people getting high-4000s for report length" should be something a screen can show beside each cap,
 * rather than something nobody ever knows. Counts only — a length and a band, never the text.
 *
 * Bands are relative to the cap in force at the write, so a cap that changes stays readable: a note at
 * 4,900 of 5,000 and a note at 980 of 1,000 are both crowding their cap.
 */

import { REPORT_NOTES_MAX_CHARS } from './report';
import { FLAG_NOTE_MAX_CHARS, PHOTO_CAPTION_MAX_CHARS } from './writeCaps';

/** The capped texts whose lengths are recorded. */
export const TEXT_LENGTH_KINDS = ['report_notes', 'photo_caption', 'flag_note'] as const;
export type TextLengthKind = (typeof TEXT_LENGTH_KINDS)[number];

/** The cap in force for each, as its writer enforces it. */
export const TEXT_LENGTH_CAPS: Record<TextLengthKind, number> = {
  report_notes: REPORT_NOTES_MAX_CHARS,
  photo_caption: PHOTO_CAPTION_MAX_CHARS,
  flag_note: FLAG_NOTE_MAX_CHARS,
};

/** Where a length sits against its cap, from nothing to the cap itself. */
export const LENGTH_BANDS = ['empty', 'to25', 'to50', 'to75', 'to90', 'to99', 'atCap'] as const;
export type LengthBand = (typeof LENGTH_BANDS)[number];

/** Each band as a screen would label it. */
export const LENGTH_BAND_LABELS: Record<LengthBand, string> = {
  empty: 'Empty',
  to25: '1–25%',
  to50: '25–50%',
  to75: '50–75%',
  to90: '75–90%',
  to99: '90–99%',
  atCap: 'At the cap',
};

/**
 * The band of a `length` against `cap`: empty at 0; then up to 25%, 50%, 75% and 90% of the cap
 * (each upper bound inclusive); then anything short of the cap; then the cap itself (or past it, for a
 * cap since lowered).
 */
export function lengthBand(length: number, cap: number): LengthBand {
  if (length <= 0) return 'empty';
  if (length >= cap) return 'atCap';
  const share = length / cap;
  if (share <= 0.25) return 'to25';
  if (share <= 0.5) return 'to50';
  if (share <= 0.75) return 'to75';
  if (share <= 0.9) return 'to90';
  return 'to99';
}

/** A day's lengths of one kind: how many writes fell in each band, and the longest. */
export interface LengthTally {
  bands: Record<LengthBand, number>;
  longest: number;
  writes: number;
}

/** A tally of `lengths` against `cap`. */
export function tallyLengths(lengths: readonly number[], cap: number): LengthTally {
  return tallyRecorded(lengths.map((length) => ({ length, band: lengthBand(length, cap) })));
}

/**
 * A tally of writes as they were recorded: each counted in the band it was given against the cap in
 * force at its write, so a cap changed mid-day doesn't re-band what came before.
 */
export function tallyRecorded(
  writes: ReadonlyArray<{ length: number; band: LengthBand }>,
): LengthTally {
  const bands = Object.fromEntries(LENGTH_BANDS.map((b) => [b, 0])) as Record<LengthBand, number>;
  let longest = 0;
  for (const write of writes) {
    bands[write.band]++;
    if (write.length > longest) longest = write.length;
  }
  return { bands, longest, writes: writes.length };
}

/** Days' tallies added up, over the days recorded; `null` when none was. */
export function sumTallies(days: ReadonlyArray<LengthTally | null>): LengthTally | null {
  let out: LengthTally | null = null;
  for (const day of days) {
    if (day === null) continue;
    if (out === null) {
      out = { bands: { ...day.bands }, longest: day.longest, writes: day.writes };
      continue;
    }
    for (const band of LENGTH_BANDS) out.bands[band] += day.bands[band];
    out.longest = Math.max(out.longest, day.longest);
    out.writes += day.writes;
  }
  return out;
}
