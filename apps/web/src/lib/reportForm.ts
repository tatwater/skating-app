/**
 * Web-only adapters between the shared report sheet (from `@skating/core`, which carries times as
 * epoch ms) and the browser's `<input type="time">` value (a wall-clock string). The pure
 * form ⇆ domain logic (`buildReportInput`, `emptyReportForm`, …) lives in `@skating/core` so
 * mobile shares it; only this input-boundary glue is web-specific.
 */

import { zonedMinuteOfDay } from '@skating/core';

/** `<input type="time">` value for an instant, read on the body's clock — never the viewer's. */
export function toTimeInput(ms: number, timeZone: string): string {
  const minute = zonedMinuteOfDay(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** Parse an `<input type="time">` value to minutes after local midnight; `NaN` when blank. */
export function timeInputToMinuteOfDay(value: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (m === null) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  // A reading no clock shows (a browser never emits one, but a test or a stray event can) would
  // otherwise overflow into the next day downstream — refuse it here instead.
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}
