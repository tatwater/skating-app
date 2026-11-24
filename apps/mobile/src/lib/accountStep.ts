/**
 * The Account step (B03 §9.6 boards 11.1–11.2): full name, `@`username with a live availability
 * check, and the date of birth as a month by name plus a typed day and year. Nothing is written
 * here — the fields ride in memory to the Terms step, where *Record acceptance* creates the row
 * (D298). This file decides what each field says and whether *Continue* is on; the rules are
 * core's (`normalizeUsername`, `dateOfBirthProblem`, …), the same ones the server applies.
 */

import {
  CONSENT_REFUSAL_MESSAGES,
  composeDateOfBirth,
  DATE_OF_BIRTH_MESSAGES,
  type DateOfBirthFields,
  type DateOfBirthProblem,
  dateOfBirthProblem,
  isValidDisplayName,
  isValidUsername,
  normalizeDisplayName,
  normalizeUsername,
} from '@skating/core';
import { ONBOARDING_COPY_MOBILE } from './onboardingCopyMobile';

export interface AccountDraft {
  displayName: string;
  username: string;
  dob: DateOfBirthFields;
}

export const EMPTY_ACCOUNT_DRAFT: AccountDraft = {
  displayName: '',
  username: '',
  dob: { month: null, day: '', year: '' },
};

/** What `profiles.usernameAvailable` answered (`undefined` while it loads or is skipped). */
export interface UsernameCheck {
  username: string;
  available: boolean;
  reason?: 'invalid' | 'taken';
  current?: true;
}

/**
 * - `empty` — nothing typed;
 * - `checking` — still being typed, or the check for this exact name hasn't answered;
 * - `invalid` — not a username by core's rule (said once the typing pauses);
 * - `available` — free (or already the caller's own);
 * - `taken` — someone else has it, by the live check or by an acceptance that was refused for it.
 */
export type UsernameField = 'empty' | 'checking' | 'invalid' | 'available' | 'taken';

/**
 * `typed` is the field as it stands; `settled` is the same value once the typing has paused (the
 * debounce), the only one ever sent to the check. `refused` holds names an acceptance was refused
 * for (`username_taken`), so the field says so even before the live check catches up.
 */
export function usernameField(
  typed: string,
  settled: string,
  check: UsernameCheck | undefined,
  refused: ReadonlySet<string>,
): UsernameField {
  const name = normalizeUsername(typed);
  if (name === '') return 'empty';
  if (typed !== settled) return 'checking';
  if (!isValidUsername(name)) return 'invalid';
  if (refused.has(name)) return 'taken';
  if (check === undefined || check.username !== name) return 'checking';
  if (check.available) return 'available';
  return check.reason === 'invalid' ? 'invalid' : 'taken';
}

/** What the live check should be asked, or `null` to skip it (nothing worth asking yet). */
export function usernameQuery(settled: string): string | null {
  const name = normalizeUsername(settled);
  return isValidUsername(name) ? name : null;
}

export interface AccountStepView {
  nameOk: boolean;
  username: UsernameField;
  dob: DateOfBirthProblem | null;
  /** The amber lines under each field, when there is something to say. */
  messages: { name?: string; username?: string; dob?: string };
  /** The fields as the acceptance sends them, once every one is right; else `null`. */
  account: { displayName: string; username: string; dateOfBirth: number } | null;
}

export function accountStepView(
  draft: AccountDraft,
  username: UsernameField,
  nowMs: number,
): AccountStepView {
  const displayName = normalizeDisplayName(draft.displayName);
  const nameOk = isValidDisplayName(displayName);
  const dob = dateOfBirthProblem(draft.dob, nowMs);
  const messages: AccountStepView['messages'] = {};
  // An empty name says nothing (Continue stays off); only a name that can't be stored is called out.
  if (!nameOk && displayName !== '') messages.name = CONSENT_REFUSAL_MESSAGES.name_invalid;
  if (username === 'invalid') messages.username = CONSENT_REFUSAL_MESSAGES.username_invalid;
  if (username === 'taken') messages.username = ONBOARDING_COPY_MOBILE.account.usernameTaken;
  if (dob === 'invalid' || dob === 'underage') messages.dob = DATE_OF_BIRTH_MESSAGES[dob];
  const dateOfBirth = composeDateOfBirth(draft.dob);
  const ready = nameOk && username === 'available' && dob === null && dateOfBirth !== null;
  return {
    nameOk,
    username,
    dob,
    messages,
    account: ready
      ? { displayName, username: normalizeUsername(draft.username), dateOfBirth }
      : null,
  };
}

/** The day and year fields take digits only, up to their length. */
export function digitsOnly(text: string, max: number): string {
  return text.replace(/\D/g, '').slice(0, max);
}
