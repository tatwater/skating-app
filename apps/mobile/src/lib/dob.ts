/**
 * Strict date-of-birth parsing for the signup age gate (D41). We collect DOB as a
 * `YYYY-MM-DD` string and convert to UTC ms so `@skating/core`'s age math
 * (`meetsMinimumAge`, `isMinor`) can consume it. Pure + tested — the safety-relevant
 * bit (rejecting garbage / impossible dates) lives here, not in the screen.
 */
export function parseDateOfBirth(input: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  const dt = new Date(ms)
  // Reject overflow (e.g. 2021-02-31 rolling into March) and impossible months/days.
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return ms
}
