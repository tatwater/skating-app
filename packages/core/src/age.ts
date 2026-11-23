/**
 * Age math (D41, D294). The signup age gate and minor status are **derived** from a stored
 * date of birth, so the minor→adult transition happens automatically on the 18th
 * birthday — no birthdate re-attestation, no scheduled job. This is the same
 * "compute at read time" pattern the account-suspension lapse uses (`suspendedUntil`).
 *
 * Comparisons are in UTC for determinism (a birthday is a calendar date, not an instant);
 * store `dateOfBirth` as UTC-midnight epoch milliseconds. The one nuance is the signup
 * gate — see `meetsMinimumAge` and `MAX_UTC_OFFSET_BEHIND_MS` for which way it errs at the
 * timezone boundary without giving up determinism.
 */

/**
 * Hard minimum signup age: adults only (D294, raising D41's 16). It equals `ADULT_AGE`, so no
 * new account is a minor and whoever accepts the terms is of age to accept them. The under-18
 * protections that key off `isMinor` stay in the code, unreachable by a new signup; lowering
 * the minimum again is this constant plus the policy work in `docs/minors-and-age-policy.md`.
 */
export const MINIMUM_SIGNUP_AGE = 18;
/** Age of majority — below this, protective defaults apply (D41). */
export const ADULT_AGE = 18;

/**
 * Widest real-world timezone offset west of UTC (UTC−12, Baker Island). The signup gate
 * evaluates age at `now − this`, so it admits someone only once they have reached the minimum
 * age on every calendar on Earth (D294). It's a fixed constant, not the device timezone, so it
 * stays deterministic and client + server (both passing `Date.now()`) still agree.
 *
 * Erring toward refusing is the intended direction at 18: the gate is what lets the terms be
 * accepted by an adult, so a self-attested birthday is never read generously. The cost is that
 * a skater waits until at most noon UTC on their 18th birthday (7 AM Eastern). Under D41's 16
 * the gate erred the other way (`now + 14 h`), which at 18 would admit a 17-year-old for the
 * last hours before their birthday and leave the new account a minor until it passed.
 */
const MAX_UTC_OFFSET_BEHIND_MS = 12 * 60 * 60 * 1000;

/** Whole years between a date of birth and `now` (both epoch ms, interpreted in UTC). */
export function ageInYears(dateOfBirthMs: number, nowMs: number): number {
  const dob = new Date(dateOfBirthMs);
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  // Not yet reached this year's birthday → subtract one.
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Is the person under 18 as of `now`? Protective defaults key off this (D41).
 *
 * Kept on plain UTC (no timezone cushion, unlike `meetsMinimumAge`) on purpose: the
 * protective defaults it drives persist past 18 regardless (D41 — a birthday never widens
 * anything already set), so a sub-day boundary skew here removes no protection early and
 * is immaterial. Anyone `meetsMinimumAge` admits is already an adult here (D294): the gate's
 * clock runs behind this one.
 */
export function isMinor(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs) < ADULT_AGE;
}

/**
 * Does the person meet the hard signup minimum (`MINIMUM_SIGNUP_AGE`) as of `now`? (D41, D294)
 *
 * Evaluated at `now − MAX_UTC_OFFSET_BEHIND_MS`, so nobody is admitted while it is still the
 * day before their birthday anywhere, whatever timezone their device claims.
 */
export function meetsMinimumAge(dateOfBirthMs: number, nowMs: number): boolean {
  return ageInYears(dateOfBirthMs, nowMs - MAX_UTC_OFFSET_BEHIND_MS) >= MINIMUM_SIGNUP_AGE;
}
