import { isValidUsername, normalizeDisplayName, normalizeUsername } from '@skating/core';

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
