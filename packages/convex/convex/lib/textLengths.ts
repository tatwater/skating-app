/**
 * The one writer of `textLengthEvents` (the founder's ruling, 2026-11-14): every write that sets a
 * report's notes, a photo's caption or a flag's note records how long the text is, so a screen can one
 * day show whether people crowd a cap. Counts only — the kind, the length, its band against the cap in
 * force — never the text, the writer or the item.
 *
 * An insert reads nothing, so it can't conflict with another writer's: a minute of many reports on a
 * busy lake day costs a tiny row each and never retries a skater's write (a shared per-day counter row
 * would). The day rollup folds a day's rows into one snapshot (`analyticsRollup.rollupTextLengthsDay`).
 *
 * An edit records the new length; the old one stays counted (a day's tally is of writes, not of what
 * is stored). A write the server refuses for length records nothing: a refused mutation commits no
 * row at all, so refusals can't be counted from here.
 */
import { lengthBand, metricDay, TEXT_LENGTH_CAPS, type TextLengthKind } from '@skating/core';
import type { MutationCtx } from '../_generated/server';

/** Record one write of `kind` whose text is `text` (absent is empty), as it was stored. */
export async function recordTextLength(
  ctx: MutationCtx,
  kind: TextLengthKind,
  text: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const length = text?.length ?? 0;
  const cap = TEXT_LENGTH_CAPS[kind];
  await ctx.db.insert('textLengthEvents', {
    day: metricDay(now),
    kind,
    length,
    band: lengthBand(length, cap),
    cap,
  });
}
