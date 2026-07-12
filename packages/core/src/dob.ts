/**
 * Strict date-of-birth parsing for the signup age gate (D41). Both apps collect DOB as a
 * `YYYY-MM-DD` string and convert to UTC ms so the age math (`meetsMinimumAge`, `isMinor`)
 * can consume it. Pure + tested — the safety-relevant bit (rejecting garbage / impossible
 * dates) lives here, shared across surfaces (D7), not in any one screen.
 */
/**
 * Plausible birth-year window. Without a lower bound, an implausibly ancient date like
 * `0100-01-01` parses fine and reads as ~1900 years old — sailing past the ≥16 gate as
 * junk data. We cap at a sane human lifespan so garbage can't masquerade as "old enough".
 * (Future dates are already rejected downstream: a not-yet-born DOB fails `meetsMinimumAge`.)
 */
const MIN_BIRTH_YEAR = 1900

export function parseDateOfBirth(input: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < MIN_BIRTH_YEAR) return null
  const ms = Date.UTC(year, month - 1, day)
  const dt = new Date(ms)
  // Reject overflow (e.g. 2021-02-31 rolling into March) and impossible months/days.
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return ms
}
