/**
 * Home and Profile, the two steps after the questions for a new or re-introduced account (B03 §9.6
 * boards 11.10–11.12). Home sets where drive times are measured from (a typed address or the phone's
 * location); Profile offers a bio, a town (taken from the picked address), and two switches. Both
 * are optional, and *Skip* only moves on.
 *
 * **Show my town stores nothing of its own** (founder, §9.15): on, the Town field is saved as the
 * profile's town; off, it isn't. **Public profile** is on for every new account already, so it is
 * written only when it is switched off.
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

/** What *Open the map* sends to `profiles.updateProfile`; `null` when there is nothing to save. */
export function profileStepPatch(draft: ProfileDraft): {
  bio?: string;
  homeTownLabel?: string;
  profileVisibility?: 'private';
} | null {
  const patch: { bio?: string; homeTownLabel?: string; profileVisibility?: 'private' } = {};
  const bio = normalizeBio(draft.bio);
  if (bio !== '') patch.bio = bio;
  const town = normalizeTownLabel(draft.town);
  if (draft.showTown && town !== '') patch.homeTownLabel = town;
  if (!draft.publicProfile) patch.profileVisibility = 'private';
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The step counter on Home and Profile: these steps only exist for a new account. */
export const WELCOME_STEP_NUMBER = { home: 4, profile: 5 } as const;
