import {
  type DateOfBirthFields,
  type EntryHold,
  type EntryStanding,
  entryStanding,
} from '@skating/core';
import { create } from 'zustand';

import { accountScoped } from './accountScoped';

/**
 * **What the way in keeps in the browser's memory, and nowhere else** (B03 §9.3, D298): the
 * Account step's fields on their way to the Terms step, the receipt hold, the Home step's town
 * on its way to the Profile step, and the standing the server last refused as unable to act.
 *
 * - **The Account step writes nothing.** Its fields ride here to *Record acceptance*, which is
 *   where a profile is born (the governor's R1). A reload loses them and the Terms step falls back
 *   to the Account step — the fields were never anyone's record, so there is nothing to restore.
 * - **The receipt hold.** *Record acceptance* changes the profile at once (a new row, or its terms
 *   version), and the gate would route past the receipt before the skater has read it. So the
 *   acceptance holds the gate where it is (`resolveEntryRoute`'s `hold`), and the receipt's own
 *   button lets go. The hold is set **before** the mutation is sent, not after it answers: Convex
 *   applies a mutation's writes to the live queries no later than it resolves the promise, so a
 *   hold set on the answer can lose the race to the redirect. A refusal lets go at once; `recorded`
 *   is what says the acceptance went through and the receipt may draw.
 *
 * In memory only (a store, never storage): a person's date of birth has no business in a browser's
 * storage, and a hold that outlived a tab would pin someone to a receipt they can't see. Forgotten
 * on sign-out and on a change of person (`accountScoped`).
 */

/** The Account step's values, checked and normalized: what `acceptTerms` takes as `account`. */
export interface AccountDraft {
  displayName: string;
  username: string;
  /** UTC-midnight epoch ms (core's `composeDateOfBirth`). */
  dateOfBirth: number;
}

/** The Account step's fields as typed, so going back to it finds them as they were left. */
export interface AccountFields extends DateOfBirthFields {
  displayName: string;
  username: string;
}

interface EntryState {
  hold: EntryHold;
  /** The acceptance went through: the receipt draws (under the hold). */
  recorded: boolean;
  /** The Account step's values, once it was continued. */
  account: AccountDraft | null;
  /** The fields as typed, for the Account step's return. */
  fields: AccountFields | null;
  /** A username the acceptance refused as taken, marked on the Account step until it changes. */
  taken: string | null;
  /**
   * The town of the address picked on the Home step ("Hanover, NH"), offered as the Profile step's
   * Town. Only a suggestion: nothing saves it but the Profile step's own button.
   */
  homeTown: string | null;
  /**
   * The receipt's *Start the questions* let go: the questions open on the first one, never on the
   * new-season card, which would only say again what the receipt just said.
   */
  questionsFromReceipt: boolean;
  /**
   * The profile's standing (`status`, `suspendedUntil`) when the server last refused this account
   * as unable to act right now — the profile gate's "Account is suspended" or "Account is not
   * active" (core's `isCannotActRefusal`). While the profile still stands so, the gate sends the
   * skater to the app rather than leave them on a step whose every press is refused
   * (`resolveEntryRoute`'s `cannotAct`); a change of either field, or a reload, ends it.
   */
  cannotAct: EntryStanding | null;
}

const EMPTY: EntryState = {
  hold: null,
  recorded: false,
  account: null,
  fields: null,
  taken: null,
  homeTown: null,
  questionsFromReceipt: false,
  cannotAct: null,
};

export const useEntryStore = create<EntryState>(() => ({ ...EMPTY }));

/** The Account step continued: its values ride to the Terms step. */
export function carryAccount(fields: AccountFields, account: AccountDraft): void {
  useEntryStore.setState({ fields, account, taken: null });
}

/** *Record acceptance* was pressed: hold the gate where it is while the mutation goes out. */
export function holdForReceipt(): void {
  useEntryStore.setState({ hold: 'receipt', recorded: false });
}

/** The acceptance went through: the receipt draws, still held. The carried fields are spent. */
export function recordReceipt(): void {
  useEntryStore.setState({ hold: 'receipt', recorded: true, account: null, taken: null });
}

/** The acceptance was refused: let go, so the gate is free again and the reader stays. */
export function releaseHold(): void {
  useEntryStore.setState({ hold: null, recorded: false });
}

/**
 * The receipt's button (*Start the questions*, `startQuestions`, or *Continue*): the route takes
 * over. The typed fields go too — the account exists now, and nothing should be able to send them
 * again.
 */
export function finishReceipt(startQuestions: boolean): void {
  useEntryStore.setState((s) => ({
    ...EMPTY,
    questionsFromReceipt: startQuestions,
    cannotAct: s.cannotAct,
  }));
}

/**
 * The acceptance refused one of the Account step's fields (core's `isAccountRefusal`): back to
 * the Account step with the fields as typed. A handle the server called taken is marked there
 * until it changes; any other refusal leaves the mark as it was.
 */
export function returnToAccount(takenUsername?: string): void {
  useEntryStore.setState((s) => ({
    hold: null,
    recorded: false,
    account: null,
    taken: takenUsername ?? s.taken,
  }));
}

/** The Home step picked an address: its town (if the provider named one) waits for Profile. */
export function carryHomeTown(town: string | null): void {
  useEntryStore.setState({ homeTown: town });
}

/**
 * The server refused this account as unable to act right now: the gate sends it to the app while
 * `profile` (as the refusing screen saw it) still stands so. No profile, nothing to hold: the rule
 * never reads the hold for a caller without a row.
 */
export function markCannotAct(profile: EntryStanding | null | undefined): void {
  if (!profile) return;
  useEntryStore.setState({ cannotAct: entryStanding(profile) });
}

/** Everything forgotten: a sign-out, a change of person, a test. */
export function forgetEntry(): void {
  useEntryStore.setState({ ...EMPTY });
}

accountScoped(forgetEntry);
