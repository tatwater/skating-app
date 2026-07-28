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
 * How long a deletion request sits before it's finalized (D62). The account stays **signed-in-able
 * and readable** for the whole window — locking the login on request would lock someone out of the
 * very sign-in they need to undo with — but it is **read-only**: contributing is closed for the
 * duration (D62 amendment), so the window can't collect content it has already decided to erase.
 *
 * **It is no longer the same number as {@link DEPARTED_CONTENT_MAX_AGE_DAYS}, and the split is the
 * point.** This one answers *"how long can I change my mind?"*; that one answers *"how long do my words
 * stay up while I still can?"*. They were described as one coupled number because finalization used to
 * be age-gated, so a grace window shorter than the content age would have stranded prose forever. The
 * finalize pass ignores the cutoff now (`lib/contentPurge`'s `final` mode), which frees the two to mean
 * what they say. They're both 30 because that reads as one clean promise, not because either requires
 * it — see the invariant test for the one relationship that still matters.
 */
export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** What a deleted author's name reads as, everywhere one is rendered (D33). */
export const DELETED_DISPLAY_NAME = 'Deleted skater';

/**
 * How long a built export bundle stays downloadable (D33/D62).
 *
 * **Deliberately the same 30 as the grace window, and deliberately not shorter than it** (founder
 * call, 2026-07-27). It used to be 7 days, which interacted badly with the thing an export is most
 * often *for*: someone exports and then deletes, the account finalizes on day 30, and a bundle
 * requested on day 28 was reclaimed by the finalize sweep two days later — with no account left to
 * sign in and fetch it with. So the TTL runs from when the bundle is **ready**, and a bundle still
 * inside it survives the deletion that prompted it (see `accountDeletion.erasePrivate`).
 *
 * The counterweight, since this is the densest concentration of one person's data anywhere in the
 * system: it survives only if it was actually **emailed**, because otherwise there is no way left to
 * reach it and retaining it would be pure cost.
 */
export const DATA_EXPORT_TTL_DAYS = 30;
export const DATA_EXPORT_TTL_MS = DATA_EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * How long a departed skater's **words** outlive their skate (D62 second amendment).
 *
 * **The same 30 as {@link DELETION_GRACE_DAYS}, but no longer welded to it.** The equality used to be
 * load-bearing: because a pending account is read-only its newest `skateEndTime` can't postdate the
 * request, so by finalization everything it held had aged out — and the finalize pass leaned on that,
 * which produced three separate bugs where the cutoff silently spared content nothing could ever come
 * back for. Finalization ignores the cutoff outright now, so this governs exactly one thing: the
 * **ghost-window sweep**, i.e. how fast your words come off while cancelling is still possible.
 *
 * The one relationship still worth pinning is `DEPARTED_CONTENT_MAX_AGE_DAYS <= DELETION_GRACE_DAYS`
 * (asserted in the tests). Above it, no ghost-window sweep ever fires — every account would reach
 * finalization with its prose fully intact, and the promise in {@link LEAVING_PROFILE_NOTICE} would be
 * kept only at the very end, which is not what it says.
 *
 * **What this is a deadline for changed, and the name didn't.** Under the first amendment it was how
 * long the *content* survived; the content is now kept and anonymized, and this is how long the free
 * text on it survives — report notes, thickness-reading notes, hazard descriptions, photo captions,
 * comment bodies. The observation has no expiry at all. See `lib/contentPurge`.
 */
export const DEPARTED_CONTENT_MAX_AGE_DAYS = 30;
export const DEPARTED_CONTENT_MAX_AGE_MS = DEPARTED_CONTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether this account is a **ghost** — a deletion has been requested and not yet finalized.
 *
 * This is not a pending flag that does nothing until day 30. From the moment it's set the account is
 * already mostly gone (D62 amendment, founder 2026-07-27): the profile is *actually* scrubbed, the
 * public profile 404s to everyone, surviving content reads as `DELETED_DISPLAY_NAME`, and content
 * older than {@link DEPARTED_CONTENT_MAX_AGE_DAYS} days is erased for good. What the 30 days preserve
 * is the **login** — so the decision can be reversed — and the **still-useful** reports, which are
 * kept for the community rather than for the person leaving.
 *
 * So the client mirror of `requireContributor` also governs what a ghost sees: no compose affordances,
 * and their own profile shown as what it now is. The rule keeping the two honest: **hide exactly what
 * the server blocks, no more and no less** — hiding something still allowed (flagging, blocking,
 * cancelling) removes a safety tool for nothing; leaving a blocked one visible invites someone to
 * write a report and only then refuses it.
 */
export function isLeaving(profile: { deletionRequestedAt?: number } | null | undefined): boolean {
  return profile?.deletionRequestedAt !== undefined;
}

/**
 * The line that stands where a compose affordance used to be. Single-sourced because it appears on
 * six surfaces across two apps, and because it has one job: say *why* the app went quiet, and name
 * the way back in the same breath. A blank space where a button was reads as a bug.
 */
export const LEAVING_NOTICE =
  'Your account is scheduled for deletion, so posting is turned off. Cancel it in Settings to post again.';

/**
 * What a ghost sees on their own profile (D62 amendment, founder call). Not a preview — the row really
 * is empty by the time this renders, and cancelling does **not** bring any of it back.
 *
 * Nobody else can reach this page at all: to the rest of the platform, a ghost does not exist. That
 * asymmetry is the whole design — your contributions stay for their safety value, you don't.
 */
export const LEAVING_PROFILE_NOTICE =
  'Your profile has been cleared. Your reports and hazards are still helping other skaters, under "Deleted skater" — but the notes, comments and captions you wrote alongside them are deleted once they\'re 30 days old. Cancel the deletion if you want to keep the account — you\'ll set your profile up again from scratch.';

/**
 * What stands where a departed skater's comment used to be (D62 second amendment).
 *
 * The row survives so the thread keeps its shape — a reply to a vanished parent is unreachable — and
 * this line is what makes the empty shell honest. It names the deletion rather than the person: the
 * byline already reads {@link DELETED_DISPLAY_NAME}, and repeating "deleted" twice in two fields
 * would read as moderation rather than as somebody leaving.
 */
export const REDACTED_COMMENT_NOTICE = 'This comment was deleted.';

/**
 * Whether a profile row exists but has been emptied by a deletion request, so the person must set it
 * up again before using the app (founder call: *"you'll have to re-add a profile photo and name, bio,
 * all of it"*).
 *
 * Keyed off the scrubbed display name rather than a second flag, because that field is exactly what
 * the wipe clears and what onboarding rewrites — one source of truth, and no way for a marker to
 * disagree with the data it describes. The handle is deliberately **not** part of the test: it's
 * reserved through the window so nobody can take it, so it stays valid the whole time.
 */
export function needsProfileSetup(
  profile: { displayName?: string; deletionRequestedAt?: number } | null | undefined,
): boolean {
  if (!profile) return false;
  // Still leaving ⇒ the empty profile is the *correct* state, not a setup prompt. Only a cancelled
  // deletion leaves a live account holding a cleared row.
  if (profile.deletionRequestedAt !== undefined) return false;
  return profile.displayName === DELETED_DISPLAY_NAME;
}

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
