/**
 * Web-only adapters between the shared `ReportFormState` (from `@skating/core`, which carries
 * `skateTime` as epoch ms) and the browser's `<input type="datetime-local">` value (a local-time
 * string). The pure form ⇆ domain logic (`buildReportInput`, `visibilityOptions`, `emptyReportForm`,
 * …) lives in `@skating/core` so mobile shares it; only this input-boundary glue is web-specific.
 */

/** `<input type="datetime-local">` value for a timestamp, in the viewer's local zone. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parse a `datetime-local` value back to epoch ms (local zone); `NaN` if blank/invalid. */
export function datetimeLocalToMs(value: string): number {
  return new Date(value).getTime()
}
