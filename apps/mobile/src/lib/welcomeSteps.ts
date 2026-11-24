/**
 * Home and Profile, the two steps after the questions for a new or re-introduced account (B03 §9.6
 * boards 11.10–11.12). Home sets where drive times are measured from (a typed address or the phone's
 * location); Profile offers a bio, a town (taken from the picked address), and two switches. Both
 * are optional, and *Skip* only moves on.
 *
 * **Show my town stores nothing of its own** (founder, §9.15): on, the Town field is saved as the
 * profile's town; off, it isn't. **Public profile** shows the row's own visibility — on for a new
 * account, off for a canceled deletion's re-introduced one, which stays private (D298) — and is
 * written only when the skater changes it.
 */

import { normalizeBio, normalizeTownLabel } from '@skating/core';
import type { AddressSuggestion } from './addressLookup';

/** What the Home step will save: a picked address, the phone's location, or nothing yet. */
export type HomeChoice =
  | { kind: 'address'; suggestion: AddressSuggestion }
  | { kind: 'location'; lat: number; lng: number }
  | null;

/** The coordinate `profiles.setHome` takes, or `null` when nothing is chosen. */
export function homeCoordOf(choice: HomeChoice): { lat: number; lng: number } | null {
  if (choice === null) return null;
  if (choice.kind === 'location') return { lat: choice.lat, lng: choice.lng };
  return { lat: choice.suggestion.lat, lng: choice.suggestion.lng };
}

/** The Home step's field and what it would save: they change together, so they never disagree. */
export interface HomeField {
  /** The words in the address field. */
  text: string;
  choice: HomeChoice;
}

export const EMPTY_HOME_FIELD: HomeField = { text: '', choice: null };

export type HomeFieldEvent =
  /** Typing un-picks: only a suggestion from the list (or the location) is saved. */
  | { type: 'typed'; text: string }
  | { type: 'picked'; suggestion: AddressSuggestion }
  /** The phone's location: the field empties, and the location is what is saved. */
  | { type: 'located'; lat: number; lng: number }
  /**
   * *Skip for now*: no home, so no town for the Profile step, and the field lets go of the address
   * with it (as the web's does) — a skip that fails must not leave a picked address on the field
   * with nothing chosen behind it, and *Save* disabled under it.
   */
  | { type: 'skipped' };

export function homeFieldReducer(state: HomeField, event: HomeFieldEvent): HomeField {
  switch (event.type) {
    case 'typed':
      return { text: event.text, choice: null };
    case 'picked':
      return {
        text: event.suggestion.label,
        choice: { kind: 'address', suggestion: event.suggestion },
      };
    case 'located':
      return { text: '', choice: { kind: 'location', lat: event.lat, lng: event.lng } };
    case 'skipped':
      return state.text === '' && state.choice === null ? state : EMPTY_HOME_FIELD;
  }
}

/** The Profile step's Town, prefilled from the picked address ("Hanover, NH"), else empty. */
export function townOf(choice: HomeChoice): string {
  return choice?.kind === 'address' ? (choice.suggestion.town ?? '') : '';
}

export interface ProfileDraft {
  bio: string;
  town: string;
  publicProfile: boolean;
  showTown: boolean;
}

export function initialProfileDraft(
  choice: HomeChoice,
  visibility: 'public' | 'private' | undefined,
): ProfileDraft {
  return {
    bio: '',
    town: townOf(choice),
    publicProfile: visibility !== 'private',
    showTown: true,
  };
}

export interface ProfileStepPatch {
  bio?: string;
  homeTownLabel?: string;
  profileVisibility?: 'public' | 'private';
}

/**
 * What *Open the map* sends to `profiles.updateProfile`; `null` when there is nothing to save.
 * `visibility` is the row's as the step opened: the switch writes only when it differs.
 */
export function profileStepPatch(
  draft: ProfileDraft,
  visibility: 'public' | 'private' | undefined,
): ProfileStepPatch | null {
  const patch: ProfileStepPatch = {};
  const bio = normalizeBio(draft.bio);
  if (bio !== '') patch.bio = bio;
  const town = normalizeTownLabel(draft.town);
  if (draft.showTown && town !== '') patch.homeTownLabel = town;
  if (draft.publicProfile !== (visibility !== 'private')) {
    patch.profileVisibility = draft.publicProfile ? 'public' : 'private';
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The step counter on Home and Profile: these steps only exist for a new account. */
export const WELCOME_STEP_NUMBER = { home: 4, profile: 5 } as const;
