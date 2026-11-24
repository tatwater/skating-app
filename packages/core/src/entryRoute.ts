/**
 * **Where a skater's way in goes next** (D298, B03 §9.3): the one routing rule both apps' gates share
 * (it replaced the risk acknowledgment's `resolveAuthRoute`, D295). Pure, so each
 * gate's table is unit-testable without a render harness, and the web (paths) and mobile
 * (`Stack.Protected` groups) can only differ in how they draw a state, never in which one it is.
 *
 * First match wins:
 *
 * | # | Condition | Route |
 * |---|---|---|
 * | 1 | Clerk not loaded | `loading` |
 * | 2 | signed out | `auth` |
 * | — | `hold === 'receipt'` | `receipt` |
 * | 1 | `profile` still `undefined` | `loading` |
 * | 3 | `profile === null` | `account` |
 * | 4 | a deletion is pending, or the account can't act at `now` (`canActNow`) | `app` |
 * | 5 | `needsProfileSetup(profile)` (a canceled deletion's emptied row) | `account` |
 * | 1 | `watch` still `undefined` | `loading` |
 * | 6 | `profile.termsVersion !== TERMS.version` | `terms` |
 * | 7 | `knowBeforeYouGoDue(profile.knowBeforeYouGoAt, watch) !== null` | `questions` |
 * | 8 | `profile.welcomeStep` set | `welcome` |
 * | 9 | otherwise | `app` |
 *
 * **The receipt hold is an input**, decided here so the two gates can't hold differently. *Record
 * acceptance* changes the profile at once (a new row, or its terms version), which would route past
 * the receipt before the skater has read it; so a successful acceptance sets the client's hold, and
 * while it is set the rule answers `receipt` — "stay on the screen you're on" (the web's
 * `/onboarding?step=terms` or `/terms`, the phone's current group) — for any signed-in caller,
 * whatever the profile query says, even mid-reload. The receipt's own button clears it (*Start the
 * questions* or *Continue*) and a sign-out does, and the route takes over. Placed after `auth` so a
 * signed-out session never sees a receipt, and before everything else because the acceptance that set
 * it is newer than any profile the query may still be returning.
 *
 * A pending deletion goes to `app` before any consent check: it is read-only, its cancel lives in
 * Settings, and walking someone who is leaving through the questions to reach it would be absurd.
 *
 * So does an account the server's profile gate refuses right now — banned, being finalized, gone, or
 * suspended at `now` (core's `canActNow`, the very rule `lib/auth.ts`'s `requireProfile` applies). The
 * acceptance and the completion refuse it, so the consent steps would trap it with nothing it can do;
 * the app is where its read-only view and the support screen (its appeal) are. When the suspension
 * lapses the same rule lets the consent checks apply again — each gate re-reads the rule then
 * (`entryRouteRecheckIn`). `now` is an argument, so the rule stays pure.
 *
 * The watch is only awaited past row 5, so a signed-out, new or leaving skater never waits on it.
 */

import { type KnowBeforeYouGoWatch, knowBeforeYouGoDue } from './knowBeforeYouGoSeason';
import { TERMS } from './legal/terms';
import { canActNow, isSuspendedNow, needsProfileSetup } from './profile';
import type { UserStatus } from './types';

export type EntryRoute =
  | 'loading'
  | 'auth'
  | 'receipt'
  | 'account'
  | 'terms'
  | 'questions'
  | 'welcome'
  | 'app';

/** The welcome steps a new or re-introduced account still has ahead of it. */
export type WelcomeStep = 'home' | 'profile';

/** The receipt hold, set by a successful acceptance; `null` when nothing is held. */
export type EntryHold = 'receipt' | null;

/** The fields of `profiles.current` the rule reads. */
export interface EntryProfile {
  displayName?: string;
  /** The profile gate's inputs (`canActNow`); absent reads as active. */
  status?: UserStatus;
  suspendedUntil?: number;
  deletionRequestedAt?: number;
  termsVersion?: string;
  knowBeforeYouGoAt?: number;
  welcomeStep?: WelcomeStep;
}

export function resolveEntryRoute({
  isLoaded,
  isSignedIn,
  profile,
  watch,
  hold = null,
  now,
}: {
  isLoaded: boolean;
  // Clerk reports `isSignedIn` as `undefined` until `isLoaded`; read as signed out.
  isSignedIn: boolean | undefined;
  // `undefined` = still resolving; `null` = signed in with no profile row.
  profile: EntryProfile | null | undefined;
  // `undefined` = still resolving; `null` = no season has opened (or the last one was reset).
  watch: KnowBeforeYouGoWatch | null | undefined;
  hold?: EntryHold;
  /** The instant a suspension is judged at (the caller's clock). */
  now: number;
}): EntryRoute {
  if (!isLoaded) return 'loading';
  if (!isSignedIn) return 'auth';
  if (hold === 'receipt') return 'receipt';
  if (profile === undefined) return 'loading';
  if (profile === null) return 'account';
  if (profile.deletionRequestedAt !== undefined) return 'app';
  if (!canActNow(profile, now)) return 'app';
  if (needsProfileSetup(profile)) return 'account';
  if (watch === undefined) return 'loading';
  if (profile.termsVersion !== TERMS.version) return 'terms';
  if (knowBeforeYouGoDue(profile.knowBeforeYouGoAt, watch) !== null) return 'questions';
  if (profile.welcomeStep !== undefined) return 'welcome';
  return 'app';
}

/** The longest delay a browser or React Native timer keeps (2^31 − 1 ms); a longer one fires at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * When a gate should read `resolveEntryRoute` again on its own, in ms from `now`, or `null` when
 * nothing time-bound is pending: a suspension with an end lapses then, and the consent checks apply
 * again. Capped at `MAX_TIMER_DELAY_MS` (a longer suspension just wakes the gate early, and it asks
 * again); one past the end, so the rule reads it as lapsed.
 */
export function entryRouteRecheckIn(
  profile: EntryProfile | null | undefined,
  now: number,
): number | null {
  if (!profile || !isSuspendedNow(profile, now) || profile.suspendedUntil === undefined) {
    return null;
  }
  return Math.min(profile.suspendedUntil - now + 1, MAX_TIMER_DELAY_MS);
}
