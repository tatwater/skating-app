/**
 * The root gate's half that is the phone's own (B03 §9.3, §9.7): which `Stack.Protected` group a
 * route from core's `resolveEntryRoute` opens, and how the receipt hold is kept. The rule itself —
 * which route — is core's and shared with the web; this file only draws it.
 *
 * **The receipt hold.** *Record acceptance* changes the profile at once (a new row, or its terms
 * version), and the route would move straight past the receipt. So a successful acceptance sets the
 * hold, naming the group the skater accepted on (`onboarding` for a new account, `terms` for an
 * existing one); while it is set core answers `receipt`, and the gate keeps that group open. The
 * receipt's button releases it; a sign-out clears it.
 */

import type { EntryHold, EntryRoute } from '@skating/core';

/** The root navigator's groups: each is one `Stack.Protected`, or nothing while loading. */
export type EntryGroup =
  | 'auth'
  | 'onboarding'
  | 'terms'
  | 'know-before-you-go'
  | 'welcome'
  | 'app'
  | null;

/** The groups a receipt can be held on: the two that record an acceptance. */
export type ReceiptGroup = 'onboarding' | 'terms';

/** The group a route opens. `receipt` keeps whichever group the acceptance happened on. */
export function entryGroup(route: EntryRoute, heldOn: ReceiptGroup | null): EntryGroup {
  switch (route) {
    case 'loading':
      return null;
    case 'auth':
      return 'auth';
    case 'receipt':
      // A hold is only ever set from one of the two acceptance screens, which names itself; the
      // fallback is the screen an existing account accepts on.
      return heldOn ?? 'terms';
    case 'account':
      return 'onboarding';
    case 'terms':
      return 'terms';
    case 'questions':
      return 'know-before-you-go';
    case 'welcome':
      return 'welcome';
    case 'app':
      return 'app';
  }
}

/** What the root navigator remembers for this session, beside the queries. */
export interface EntrySession {
  hold: EntryHold;
  /** The group the receipt is held on, while `hold` is set. */
  heldOn: ReceiptGroup | null;
  /**
   * The Account step was on screen this session: a new account, so the steps carry "N of 5". A
   * returning account's terms and questions carry no counter.
   */
  accountSeen: boolean;
  /**
   * The receipt's *Start the questions* released the hold: the questions open on the first one,
   * not on the season card, which would only say again what the receipt just said.
   */
  questionsFromReceipt: boolean;
}

export const EMPTY_ENTRY_SESSION: EntrySession = {
  hold: null,
  heldOn: null,
  accountSeen: false,
  questionsFromReceipt: false,
};

export type EntrySessionEvent =
  | { type: 'accountSeen' }
  /**
   * *Record acceptance* was tapped. The hold is set **before** the call, not after: Convex shows
   * the new profile no later than it resolves the call, and a gate that saw the row first would
   * swap the screen away (and lose its state) before the hold could keep it.
   */
  | { type: 'accepted'; on: ReceiptGroup }
  /** The acceptance was refused: the screen stays on the reader, so nothing is held. */
  | { type: 'acceptFailed' }
  | { type: 'released'; startQuestions: boolean }
  | { type: 'signedOut' };

export function entrySessionReducer(state: EntrySession, event: EntrySessionEvent): EntrySession {
  switch (event.type) {
    case 'accountSeen':
      return state.accountSeen ? state : { ...state, accountSeen: true };
    case 'accepted':
      return { ...state, hold: 'receipt', heldOn: event.on };
    case 'acceptFailed':
      return state.hold === null ? state : { ...state, hold: null, heldOn: null };
    case 'released':
      return {
        ...state,
        hold: null,
        heldOn: null,
        questionsFromReceipt: event.startQuestions,
      };
    case 'signedOut':
      return state === EMPTY_ENTRY_SESSION ? state : EMPTY_ENTRY_SESSION;
  }
}

/**
 * Whether the session should be forgotten: Clerk has loaded and nobody is signed in. Checked every
 * render, so a sign-out from anywhere (the You tab, the season card, a revoked session) clears the
 * hold before the next person signs in.
 */
export function sessionEnded(isLoaded: boolean, isSignedIn: boolean | undefined): boolean {
  return isLoaded && !isSignedIn;
}
