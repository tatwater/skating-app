/**
 * The consent record's validators (D297, B03 §9.4), shared by `schema.ts` and `consent.ts` so the
 * table and the functions that write it can't disagree about a value. The vocabulary itself — what
 * each value means — is core's (`@skating/core` `consentRecord.ts`); these are its Convex shapes.
 */

import { v } from 'convex/values';

/** Where the client says it ran (`ConsentSurface`). Client-reported, and stored labeled so. */
export const consentSurface = v.union(v.literal('web'), v.literal('android'), v.literal('ios'));

/** Which reader's end was on screen: the page's own, or the desk's full-screen one. */
export const termsReaderVia = v.union(v.literal('inline'), v.literal('fullscreen'));

/** The welcome steps a new or re-introduced account still has ahead of it (`WelcomeStep`). */
export const welcomeStep = v.union(v.literal('home'), v.literal('profile'));

/** What the client says about itself, labeled as such (a string is capped, `capClientReported`). */
const CLIENT_REPORTED = v.literal('client_reported');
export const clientReportedSurface = v.object({ value: consentSurface, source: CLIENT_REPORTED });
export const clientReportedString = v.object({ value: v.string(), source: CLIENT_REPORTED });

/** How the IP's session was matched to the caller (B03 §9.2, R4). */
export const ipMatch = v.union(
  v.literal('token_sid'),
  v.literal('client_session'),
  v.literal('most_recent_session'),
);

/** Why a record holds no IP. */
export const ipUnavailableReason = v.union(
  v.literal('no_key'),
  v.literal('no_session'),
  v.literal('no_activity'),
  v.literal('error'),
);

/** What became of the emailed copy (`lib/resend.SendOutcome`'s kind, or still waiting). */
export const copyEmailStatus = v.union(
  v.literal('pending'),
  v.literal('accepted'),
  v.literal('rejected'),
  v.literal('unknown'),
);

/** Why the record was made: a terms acceptance's four, a completion's two (`consentRecord.ts`). */
export const consentContext = v.union(
  v.literal('first_run'),
  v.literal('reintroduced'),
  v.literal('returning'),
  v.literal('version_change'),
  v.literal('season'),
);

/** The `consentRecords` row (B03 §9.4). Sealed: see `consent.ts` for the only writes after the insert. */
export const consentRecordFields = {
  kind: v.union(v.literal('terms'), v.literal('questions')),
  /** The pointers to the account, both cleared by the finalize `consent` stage. */
  profileId: v.optional(v.id('profiles')),
  clerkUserId: v.optional(v.string()),
  /**
   * Who made it, as attested: the Account step's values for a new or re-introduced account, the
   * profile's for a returning one. `email` from the token, else the profile's mirror, else filled
   * once by the copy's send.
   */
  identity: v.object({
    fullName: v.string(),
    email: v.optional(v.string()),
    dateOfBirth: v.number(),
  }),
  /** What was accepted or answered: core's committed version and SHA-256. */
  version: v.string(),
  contentHash: v.string(),
  /** Terms only: the Privacy Notice the agree line named. */
  privacyVersion: v.optional(v.string()),
  privacyHash: v.optional(v.string()),
  context: consentContext,
  /** Terms only: the reading's server stamps, copied from its `termsReadings` row. */
  openedAt: v.optional(v.number()),
  reachedEndAt: v.optional(v.number()),
  reachedEndVia: v.optional(termsReaderVia),
  /** The server's `now` at the acceptance or the completion. */
  recordedAt: v.number(),
  /** Questions only: the newest opened season at `recordedAt`, or `null` before any. */
  season: v.optional(v.union(v.string(), v.null())),
  surface: clientReportedSurface,
  userAgent: v.optional(clientReportedString),
  ip: v.optional(
    v.object({
      address: v.string(),
      source: v.literal('clerk_session_activity'),
      match: ipMatch,
      fetchedAt: v.number(),
    }),
  ),
  ipStatus: v.union(v.literal('pending'), v.literal('captured'), v.literal('unavailable')),
  ipUnavailable: v.optional(ipUnavailableReason),
  /** Terms only: the emailed copy, `pending` until its send settles, then filled once. */
  copyEmail: v.optional(v.object({ status: copyEmailStatus, at: v.optional(v.number()) })),
  /** Set together by the finalize `consent` stage; `purgeAt` is six calendar years on. */
  severedAt: v.optional(v.number()),
  purgeAt: v.optional(v.number()),
};
