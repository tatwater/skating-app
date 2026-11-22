import { formatDurationLabel } from '@skating/core';

import { clock, dayKey, dayMonth, dayTime } from '../handlers/Flag/flagFormat';

/** A recorded skate as the item serves it (`SkateView`): an ask's, or a drawing's. */
export type SkateTimes = {
  startTime: number;
  endTime: number | null;
  elapsedSeconds: number | null;
};

/**
 * When a skate ran, by its local days: a skate within one day reads with its start's day ("11 Oct
 * 09:00–11:00"); one that crosses a day names both ("10 Oct 23:00 – 11 Oct 01:00"); one with no end
 * (or an end not after its start) reads from its start ("11 Oct 09:00"). The day the map's legend
 * names is the start's, so the two always agree.
 */
export function skateWhen(
  skate: Pick<SkateTimes, 'startTime' | 'endTime'>,
  timeZone?: string,
): string {
  const { startTime: start, endTime: end } = skate;
  if (end === null || end <= start) return dayTime(start, timeZone);
  if (dayKey(start, timeZone) === dayKey(end, timeZone)) {
    return `${dayMonth(start, timeZone)} ${clock(start, timeZone)}–${clock(end, timeZone)}`;
  }
  return `${dayTime(start, timeZone)} – ${dayTime(end, timeZone)}`;
}

/**
 * **A recorded skate, in one format** for every Inbox surface (an ask's row, a drawing's *Skate*
 * row): the provider's moving time, then when (`skateWhen`) — "1h 36m · 11 Oct 09:00–11:00". The
 * moving time leaves out stops, so it is never the span's length; with none sent, only when. Never a
 * distance: no row stores one.
 */
export function skateWords(skate: SkateTimes, timeZone?: string): string {
  const when = skateWhen(skate, timeZone);
  return skate.elapsedSeconds !== null && skate.elapsedSeconds > 0
    ? `${formatDurationLabel(skate.elapsedSeconds / 60)} · ${when}`
    : when;
}
