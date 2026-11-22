import { formatDurationLabel } from '@skating/core';

import { dayTime, skateSpan } from '../handlers/Flag/flagFormat';

/** A recorded skate as the item serves it (`SkateView`): an ask's, or a drawing's. */
export type SkateTimes = {
  startTime: number;
  endTime: number | null;
  elapsedSeconds: number | null;
};

/**
 * **A recorded skate, in one format** for every Inbox surface (an ask's row, a drawing's *Skate*
 * row): the provider's moving time, then when — "1h 36m · 11 Oct 09:00–11:00". The moving time leaves
 * out stops, so it is never the span's length; with none sent, only when. A skate with no end reads
 * from its start ("11 Oct 09:00"). Never a distance: no row stores one.
 */
export function skateWords(skate: SkateTimes, timeZone?: string): string {
  const when =
    skate.endTime !== null
      ? skateSpan(skate.startTime, skate.endTime, timeZone)
      : dayTime(skate.startTime, timeZone);
  return skate.elapsedSeconds !== null && skate.elapsedSeconds > 0
    ? `${formatDurationLabel(skate.elapsedSeconds / 60)} · ${when}`
    : when;
}
