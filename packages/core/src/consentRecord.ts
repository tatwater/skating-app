/**
 * The pure parts of the consent record (D297, B03 §9.4): its vocabulary, how long it outlives an
 * account, and the cap on what a client reports about itself. The record itself, and every write to
 * it, lives in `packages/convex/convex/consent.ts`; these are here so the server, the export and the
 * tests read one rule.
 */

/** Which kind of moment a record is: a terms acceptance or a Know Before You Go completion. */
export type ConsentRecordKind = 'terms' | 'questions';

/** Where the client says it ran. Client-reported, and stored labeled so. */
export type ConsentSurface = 'web' | 'android' | 'ios';

/**
 * Why a terms acceptance happened:
 * - `first_run` — it created the account;
 * - `reintroduced` — it re-introduced a canceled deletion's emptied row;
 * - `returning` — an existing account accepting for the first time (it came in under the old risk
 *   acknowledgment and never held a terms version);
 * - `version_change` — an account that had accepted an older version.
 */
export type TermsAcceptanceContext = 'first_run' | 'reintroduced' | 'returning' | 'version_change';

/** Why a completion happened: the first answers ever, or a season's asking. */
export type KnowBeforeYouGoContext = 'first_run' | 'season';

/**
 * The context of an acceptance, from what the server found before writing: no row, a row that
 * `needsProfileSetup` says is a canceled deletion's, or a live row with the terms version it held.
 */
export function termsAcceptanceContext(found: {
  profile: 'none' | 'emptied' | 'live';
  termsVersion?: string;
}): TermsAcceptanceContext {
  if (found.profile === 'none') return 'first_run';
  if (found.profile === 'emptied') return 'reintroduced';
  return found.termsVersion === undefined ? 'returning' : 'version_change';
}

/** How many calendar years a record outlives the account it was severed from (D297). */
export const CONSENT_RETENTION_YEARS = 6;

/**
 * When a severed record is purged: `severedAt` plus six calendar years, in UTC, at the same time of
 * day. A 29 February lands on 1 March: six is not a multiple of four, so the year six on from a leap
 * day never has one, and `Date.UTC` rolls the missing day forward.
 */
export function consentPurgeAt(severedAt: number): number {
  const d = new Date(severedAt);
  return Date.UTC(
    d.getUTCFullYear() + CONSENT_RETENTION_YEARS,
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** The longest client-reported string a record keeps (a user agent, a surface): longer is cut. */
export const CLIENT_REPORTED_MAX_LENGTH = 512;

/** A client-reported string as a record stores it: trimmed, then cut to the cap. */
export function capClientReported(value: string): string {
  return value.trim().slice(0, CLIENT_REPORTED_MAX_LENGTH);
}

/** A second completion within this long of the first returns the first's answer and writes nothing. */
export const KNOW_BEFORE_YOU_GO_REPEAT_MS = 60 * 1000;
