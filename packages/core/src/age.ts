/**
 * Age math (D41). The signup age gate and minor status are **derived** from a stored
 * date of birth, so the minor→adult transition happens automatically on the 18th
 * birthday — no birthdate re-attestation, no scheduled job. This is the same
 * "compute at read time" pattern the account-suspension lapse uses (`suspendedUntil`).
 *
 * Comparisons are in UTC for determinism (a birthday is a calendar date, not an instant);
 * store `dateOfBirth` as UTC-midnight epoch milliseconds. The one nuance is the signup
 * gate — see `meetsMinimumAge` and `MAX_UTC_OFFSET_AHEAD_MS` for how it avoids the
 * timezone-boundary bug without giving up determinism.
 */

/** Hard minimum signup age — under-16 accounts are not permitted (D41). */
export const MINIMUM_SIGNUP_AGE = 16
/** Age of majority — below this, protective defaults apply (D41). */
export const ADULT_AGE = 18

/**
 * Widest real-world timezone offset east of UTC (UTC+14, e.g. Kiribati). The signup gate
 * evaluates age at `now + this` so it never rejects someone who has already reached the
 * minimum age on their *local* calendar while UTC is still a day behind (review finding 4).
 * It's a fixed constant, not the device timezone, so it stays deterministic and client +
 * server (both passing `Date.now()`) still agree. Erring toward admitting is the intended
 * direction: the 16 gate is about service obligations, not physical safety, and a sub-day
 * boundary on a self-attested date is immaterial.
 */
const MAX_UTC_OFFSET_AHEAD_MS = 14 * 60 * 60 * 1000

/** Whole years between a date of birth and `now` (both epoch ms, interpreted in UTC). */
export function ageInYears(dateOfBirthMs: number, nowMs: number): number {
  const dob = new Date(dateOfBirthMs)
  const now = new Date(nowMs)
  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth()
  // Not yet reached this year's birthday → subtract one.
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1
  }
  return age
}

/**
 * Is the person under 18 as of `now`? Protective defaults key off this (D41).
 *
 * Kept on plain UTC (no timezone cushion, unlike `meetsMinimumAge`) on purpose: the
 * protective defaults it drives persist past 18 regardless (D41 — a birthday never widens
 * anything already set), so a sub-day boundary skew here removes no protection early and
 * is immaterial.
 */
export function isMinor(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs) < ADULT_AGE
}

/**
 * Does the person meet the hard 16+ signup minimum as of `now`? (D41)
 *
 * Evaluated at `now + MAX_UTC_OFFSET_AHEAD_MS` so a user who is already 16 on their local
 * calendar (in a timezone ahead of UTC) isn't wrongly rejected while UTC lags a day behind.
 */
export function meetsMinimumAge(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs + MAX_UTC_OFFSET_AHEAD_MS) >= MINIMUM_SIGNUP_AGE
}
