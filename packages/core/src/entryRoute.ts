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
 * | 4 | a deletion is pending, or the account can't act (`canActNow` at `now`, or a can't-act hold still standing) | `app` |
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
 * **`now` is the device's clock; the server's is the one that counts.** The rule judges a suspension
 * at `now` exactly, as the server does, so with a correct clock a lapsed suspension goes straight on
 * to whatever consent it owes. A device running ahead would send a still-suspended account to a step
 * whose every call is refused; the server catches that itself. A refusal that says the account can't
 * act right now (`isCannotActRefusal`), heard on a way-in step, records the profile's standing as it
 * was then (`entryStanding`: its `status` and `suspendedUntil`) as the client's `cannotAct` hold, and
 * the rule sends the skater to the app for as long as the profile still stands that way
 * (`cannotActHolds`). No timer and no retry: the hold ends when either field changes (a moderator's
 * lift, a new suspension) or the session restarts (a reload, a relaunch: the hold is in memory), so a
 * clock that stays ahead can never bounce the skater between the app and a refused step.
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

/** What the profile gate judges an account by: the two fields a can't-act hold is keyed on. */
export type EntryStanding = Pick<EntryProfile, 'status' | 'suspendedUntil'>;

/** The profile's standing, alone: what a can't-act refusal records as its hold. */
export function entryStanding(profile: EntryStanding): EntryStanding {
  return {
    ...(profile.status !== undefined ? { status: profile.status } : {}),
    ...(profile.suspendedUntil !== undefined ? { suspendedUntil: profile.suspendedUntil } : {}),
  };
}

/**
 * Whether a can't-act hold (the standing recorded when the server refused this account as unable to
 * act) still holds for `profile`: only while its `status` and `suspendedUntil` are both what they
 * were. Either changing ends it; nothing about the clock does.
 */
export function cannotActHolds(
  hold: EntryStanding | null | undefined,
  profile: EntryStanding,
): boolean {
  if (hold === null || hold === undefined) return false;
  return hold.status === profile.status && hold.suspendedUntil === profile.suspendedUntil;
}

export function resolveEntryRoute({
  isLoaded,
  isSignedIn,
  profile,
  watch,
  hold = null,
  now,
  cannotAct = null,
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
  /**
   * The profile's standing when the server last refused this account as unable to act right now
   * (`isCannotActRefusal`), or `null`: while the profile still stands so (`cannotActHolds`), the
   * skater is in the app.
   */
  cannotAct?: EntryStanding | null;
}): EntryRoute {
  if (!isLoaded) return 'loading';
  if (!isSignedIn) return 'auth';
  if (hold === 'receipt') return 'receipt';
  if (profile === undefined) return 'loading';
  if (profile === null) return 'account';
  if (profile.deletionRequestedAt !== undefined) return 'app';
  if (!canActNow(profile, now) || cannotActHolds(cannotAct, profile)) return 'app';
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
 * again); one past the end, so the rule reads it as lapsed. A can't-act hold has no end in time.
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
