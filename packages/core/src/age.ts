/**
 * Age math (D41). The signup age gate and minor status are **derived** from a stored
 * date of birth, so the minor→adult transition happens automatically on the 18th
 * birthday — no birthdate re-attestation, no scheduled job. This is the same
 * "compute at read time" pattern the account-suspension lapse uses (`suspendedUntil`).
 *
 * All comparisons are in UTC for determinism (a birthday is a calendar date, not an
 * instant); store `dateOfBirth` as UTC-midnight epoch milliseconds.
 */

/** Hard minimum signup age — under-16 accounts are not permitted (D41). */
export const MINIMUM_SIGNUP_AGE = 16
/** Age of majority — below this, protective defaults apply (D41). */
export const ADULT_AGE = 18

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

/** Is the person under 18 as of `now`? Protective defaults key off this (D41). */
export function isMinor(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs) < ADULT_AGE
}

/** Does the person meet the hard 16+ signup minimum as of `now`? (D41) */
export function meetsMinimumAge(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs) >= MINIMUM_SIGNUP_AGE
}
