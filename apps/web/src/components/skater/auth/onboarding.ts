import { isValidUsername, normalizeDisplayName, normalizeUsername } from '@skating/core';
import { ConvexError } from 'convex/values';

/** Why `upsertFromClerk` said no, in terms of what the form does about it. */
export type OnboardingRefusal =
  | { kind: 'taken' }
  | { kind: 'badname' }
  | { kind: 'message'; message: string };

const GENERIC = 'Could not finish setting up your profile';

/**
 * The mutation's refusals are `ConvexError`s with a user-safe string, the two about the username
 * matched here because the form draws them in the field (8.18, 8.19) rather than as a line. Anything
 * that isn't a `ConvexError` is Convex's own redacted text, so it gets the generic.
 */
export function classifyUpsertError(error: unknown): OnboardingRefusal {
  if (!(error instanceof ConvexError)) return { kind: 'message', message: GENERIC };
  // A structured refusal (the rename cooldown) carries its words on `message`.
  const raw: unknown = error.data;
  if (typeof raw === 'object' && raw !== null) {
    const message = (raw as { message?: unknown }).message;
    return { kind: 'message', message: typeof message === 'string' ? message : GENERIC };
  }
  const data = String(raw);
  if (data === 'Username is already taken') return { kind: 'taken' };
  if (data.startsWith('Username must')) return { kind: 'badname' };
  return { kind: 'message', message: data };
}

/** What a username that isn't allowed is told. One rule: `isValidUsername`, stated (8.19). */
export const USERNAME_RULE =
  'Use 3 to 30 letters, numbers, and underscores, starting and ending with a letter or number.';

/**
 * Whether a username in progress is worth flagging yet. Characters that can never be allowed say so
 * at once; too short, or a trailing underscore, is only wrong once someone has moved on, otherwise
 * every handle reads as a mistake for its first two letters.
 */
export function usernameNeedsFixing(raw: string, leftField: boolean): boolean {
  const username = normalizeUsername(raw);
  if (username.length === 0 || isValidUsername(username)) return false;
  return leftField || !/^[a-z0-9][a-z0-9_]{0,29}$/.test(username);
}

/**
 * Three handles to try when one is taken (8.18). These are **unchecked**: no query can say which are
 * free yet, so the copy offers them without promising, and the server re-checks on submit.
 */
export function suggestUsernames(taken: string, displayName: string): string[] {
  const words = normalizeDisplayName(displayName)
    .toLowerCase()
    .split(' ')
    .map((word) => word.replace(/[^a-z0-9]/g, ''))
    .filter((word) => word.length > 0);
  const candidates = [words.join(''), words.join('_'), `${taken}2`, `${taken}3`, `${taken}_gli`];
  return [...new Set(candidates)].filter((c) => c !== taken && isValidUsername(c)).slice(0, 3);
}
