/**
 * Profile identity fields — `username` and `displayName` (06-data-model.md). Single-sourced
 * here so the collection UI (mobile onboarding, later the web sign-up) and the
 * `upsertFromClerk` trust boundary (D37) normalize + validate *identically*: the client
 * gives instant feedback, but the Convex function is what actually enforces these before
 * writing the `profiles` row. Never trust the client's normalization — re-run it server-side.
 */

/** Username length bounds — short enough to type, long enough to stay distinctive. */
export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 30

/**
 * Canonical stored form of a username: trimmed + lowercased. Usernames are
 * case-insensitive so `Ada` and `ada` can't both be claimed — uniqueness
 * (06-data-model.md) is checked against this normalized value.
 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase()
}

// Normalized handle: a–z / 0–9 / underscore, and must start *and* end alphanumeric — no
// leading/trailing underscores and no all-underscore handles. Applied to the already
// lowercased value, so it deliberately has no uppercase branch.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/

/** Whether an already-normalized username is well-formed (length + charset). */
export function isValidUsername(normalized: string): boolean {
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(normalized)
  )
}

/** Display-name length bounds. It's a label, not an identifier, so the rules are loose. */
export const DISPLAY_NAME_MIN_LENGTH = 1
export const DISPLAY_NAME_MAX_LENGTH = 50

/** Canonical stored form of a display name: trimmed, with internal whitespace collapsed. */
export function normalizeDisplayName(input: string): string {
  return input.trim().replace(/\s+/g, ' ')
}

/** Whether an already-normalized display name is within bounds. */
export function isValidDisplayName(normalized: string): boolean {
  return (
    normalized.length >= DISPLAY_NAME_MIN_LENGTH && normalized.length <= DISPLAY_NAME_MAX_LENGTH
  )
}
