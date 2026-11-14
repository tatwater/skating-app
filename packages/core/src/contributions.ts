/**
 * **What a contribution is** (the founder, 2026-11-13; D253) — the one rule every *contributors*
 * figure reads: Metrics' contributors stat and first-timers, the daily contributors strip, the
 * season's contributors and the older `active_contributors` rollup.
 *
 * "My definition of a contribution is an original thought/piece of data that is top-level
 * discoverable within its domain. So like a report is top-level in the newsfeed, a hazard is
 * top-level in a body, a temporary blockage is top-level in a put-in. But a comment is just chatter
 * on a report that may or may not hold value." And: "reporting that a put-in or parking area is
 * temporarily out of commission or that a body of water isn't accessible to the public or things
 * like that absolutely should count as contributions."
 *
 * **Counts**, each only while it stands — an item its author withdrew or retracted, or a moderator
 * removed, hid, declined or dismissed, does not:
 *
 * - a **report** (visible, not withdrawn by its author);
 * - a **hazard** (visible);
 * - an **access alert** — a blockage or condition at a put-in, a lot or a body (not retracted; one
 *   that has since expired or been resolved stood while it was up, and counts);
 * - a **"not publicly accessible" report** — a `no_public_access` flag on a body (not dismissed);
 * - a **put-in a person added** (an `official` put-in with the person who placed it, visible);
 * - a **request about the corpus** — add or activate a body — or a **proposed bay or landmark name**
 *   (not declined).
 *
 * **Does not count:** comments, hazard confirmations and alert votes, ratings and kudos, photos
 * (they belong to a report), and flags on other people's content.
 *
 * Each kind is dated by when it was made (`createdAt`), except a report, which is dated by when its
 * skate ended — the date the reports strip and every report count use.
 */

/** Every kind of contribution, in the order the reads walk them. */
export const CONTRIBUTION_KINDS = [
  'report',
  'hazard',
  'accessAlert',
  'noPublicAccess',
  'putIn',
  'corpusRequest',
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

/** The corpus requests that are contributions: adding or activating a body, or naming a place. */
export const CONTRIBUTING_REQUEST_KINDS = [
  'activate',
  'admit',
  'name_bay',
  'name_landmark',
] as const;

/** The fields each kind's rule reads — the rows' own, so the server passes its documents as they are. */
export interface ContributionRows {
  report: { moderationStatus: string; authorDeletedAt?: number | undefined };
  hazard: { moderationStatus: string };
  accessAlert: { status: string };
  noPublicAccess: { reason: string; targetType: string; status: string };
  putIn: { source: string; status: string; createdByUserId?: unknown };
  corpusRequest: { kind: string; status: string };
}

/**
 * Whether a row of each kind is a contribution that stands. A row of a kind's table that is not a
 * contribution at all (a spam flag, a takedown request, a derived put-in) never stands.
 */
export const contributionStands: {
  [K in ContributionKind]: (row: ContributionRows[K]) => boolean;
} = {
  report: (r) => r.moderationStatus === 'visible' && r.authorDeletedAt === undefined,
  hazard: (h) => h.moderationStatus === 'visible',
  accessAlert: (a) => a.status !== 'retracted',
  noPublicAccess: (f) =>
    f.reason === 'no_public_access' && f.targetType === 'waterbody' && f.status !== 'dismissed',
  putIn: (p) =>
    p.source === 'official' && p.createdByUserId !== undefined && p.status === 'visible',
  corpusRequest: (r) =>
    (CONTRIBUTING_REQUEST_KINDS as readonly string[]).includes(r.kind) && r.status !== 'declined',
};
