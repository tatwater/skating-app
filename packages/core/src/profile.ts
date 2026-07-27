/**
 * Profile identity + editable-profile fields (06-data-model.md, D13). Single-sourced here so the
 * collection/edit UI (mobile onboarding + the Phase-3 profile editor, web + mobile) and the
 * `upsertFromClerk` / `updateProfile` trust boundary (D37) normalize + validate *identically*: the
 * client gives instant feedback, but the Convex function is what actually enforces these before
 * writing the `profiles` row. Never trust the client's normalization — re-run it server-side.
 */

import { isMinor } from './age';

/** Username length bounds — short enough to type, long enough to stay distinctive. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/**
 * Canonical stored form of a username: trimmed + lowercased. Usernames are
 * case-insensitive so `Ada` and `ada` can't both be claimed — uniqueness
 * (06-data-model.md) is checked against this normalized value.
 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

// Normalized handle: a–z / 0–9 / underscore, and must start *and* end alphanumeric — no
// leading/trailing underscores and no all-underscore handles. Applied to the already
// lowercased value, so it deliberately has no uppercase branch.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/;

/** Whether an already-normalized username is well-formed (length + charset). */
export function isValidUsername(normalized: string): boolean {
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(normalized)
  );
}

/** Display-name length bounds. It's a label, not an identifier, so the rules are loose. */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 50;

/** Canonical stored form of a display name: trimmed, with internal whitespace collapsed. */
export function normalizeDisplayName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** Whether an already-normalized display name is within bounds. */
export function isValidDisplayName(normalized: string): boolean {
  return (
    normalized.length >= DISPLAY_NAME_MIN_LENGTH && normalized.length <= DISPLAY_NAME_MAX_LENGTH
  );
}

/**
 * Editable profile blurb, shown only on a public profile (D13). Optional — an empty bio is valid
 * (the user simply hasn't written one), so the length rule is an upper bound only.
 */
export const BIO_MAX_LENGTH = 500;

/** Canonical stored form of a bio: outer whitespace trimmed, inner formatting preserved. */
export function normalizeBio(input: string): string {
  return input.trim();
}

/** Whether an already-normalized bio is within bounds (empty is allowed — bio is optional). */
export function isValidBio(normalized: string): boolean {
  return normalized.length <= BIO_MAX_LENGTH;
}

/**
 * Optional PUBLIC town/state label (D11) — "Norwich, VT". A short freeform label, not a geocoded
 * place; the private home coordinate is never derived from it. Empty is allowed (optional field).
 */
export const TOWN_LABEL_MAX_LENGTH = 80;

/** Canonical stored form of a town label: trimmed, internal whitespace collapsed. */
export function normalizeTownLabel(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** Whether an already-normalized town label is within bounds (empty allowed — optional). */
export function isValidTownLabel(normalized: string): boolean {
  return normalized.length <= TOWN_LABEL_MAX_LENGTH;
}

/**
 * May this user set their profile to `public` (D13/D41)? **Minors are forced private** — a public
 * profile is searchable and broadcasts town + report history, which we never do for a known minor.
 * Derived from DOB (like the age gate) so it self-corrects at 18; re-enforced in `updateProfile`.
 */
export function canSetProfilePublic(dateOfBirthMs: number, nowMs: number): boolean {
  return !isMinor(dateOfBirthMs, nowMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// The deletion tombstone (D33/D62)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a deletion request sits before it's finalized (D62). The account stays **fully
 * functional** for the whole window — they can sign in, post, and cancel — because the alternative
 * (locking the account on request) locks someone out of the very sign-in they need to undo with.
 */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** What a deleted author's name reads as, everywhere one is rendered (D33). */
export const DELETED_DISPLAY_NAME = 'Deleted skater';

/**
 * The date of birth a tombstone carries. DOB is sensitive PII that gets scrubbed (D41/D33), but the
 * field is required and everything that reads it derives an *age* — so it has to be a real date
 * rather than 0 or a NaN. A fixed 1900 epoch reads unambiguously as "not a person's birthday" and
 * derives to "adult", which is the only safe direction: a tombstone must never be treated as a minor
 * and handed the minor-protection paths meant for a live account.
 */
export const DELETED_DATE_OF_BIRTH = Date.UTC(1900, 0, 1);

/**
 * Per-row-unique tombstone values for the two fields that are read with `.unique()`.
 *
 * This is the sharp edge of the whole feature. `profiles.by_clerk_user_id` and
 * `profiles.by_username` are both queried with `.unique()`, which **throws when it matches more than
 * one row** — so scrubbing either to a shared constant like `'deleted'` works perfectly for the
 * first deleted account and breaks authentication for the entire app on the second. Deriving the
 * sentinel from the profile id keeps it unique by construction, and keeps it obviously synthetic to
 * anyone reading the table.
 *
 * The two use different separators on purpose: a username has to stay inside the `[a-z0-9_]` handle
 * charset (`isValidUsername`) so a tombstone can't be mistaken for a malformed row, while
 * `clerkUserId` is an opaque external string where a colon is the clearer "this is not a Clerk id".
 */
export function deletedUsername(profileId: string): string {
  return `deleted_${profileId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export function deletedClerkUserId(profileId: string): string {
  return `deleted:${profileId}`;
}

/** Whether a `clerkUserId` is a deletion tombstone rather than a real Clerk subject. */
export function isDeletedClerkUserId(value: string): boolean {
  return value.startsWith('deleted:');
}
