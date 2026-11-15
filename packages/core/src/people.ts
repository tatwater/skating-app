/**
 * The People pages' rules (B01 §5.7), defined once: which lanes there are and in what order, what
 * puts a person in each, how a list's arguments are cleaned at the edge, and what counts as a
 * restriction. The server's list, its counts and the Overview's people card all read these; the page
 * reads the lane keys and labels from here too, so a lane can't be spelled two ways.
 */

import { DELETION_GRACE_DAYS } from './profile';
import { MAX_OPEN_BOUNTIES_PER_DAY } from './reputationConfig';

/**
 * The lanes, in the order the sidebar draws them. `appeals` reads support tickets (PII, D37), so a
 * viewer without `inbox.support.read` never gets it — their lanes simply lack it.
 */
export const PEOPLE_LANES = [
  'everyone',
  'staff',
  'suspended',
  'banned',
  'restricted',
  'flagged',
  'appeals',
  'newest',
  'leaving',
  'deleted',
] as const;
export type PeopleLane = (typeof PEOPLE_LANES)[number];

/**
 * The lanes a viewer gets, in the sidebar's order: every lane, but Appeals open only for a viewer who
 * may read support (`inbox.support.read`, PII — D37). The server's lanes and the page read this one
 * rule.
 */
export function peopleLanesFor(readsSupport: boolean): PeopleLane[] {
  return PEOPLE_LANES.filter((lane) => lane !== 'appeals' || readsSupport);
}

/** What each lane is called on the page. */
export const PEOPLE_LANE_LABELS: Record<PeopleLane, string> = {
  everyone: 'Everyone',
  staff: 'Staff',
  suspended: 'Suspended',
  banned: 'Banned',
  restricted: 'Restricted',
  flagged: 'Flagged',
  appeals: 'Appeals open',
  newest: 'Newest',
  leaving: `Leaving · ${DELETION_GRACE_DAYS}-day window`,
  deleted: 'Deleted · tombstones',
};

/** "Newest" is the accounts made in the last this-many days. */
export const NEWEST_DAYS = 7;

/** Rows a list page returns by default, and at most. */
export const PEOPLE_PAGE_SIZE = 50;
export const PEOPLE_PAGE_MAX = 100;

/** The longest search a list takes, in characters, after trimming. */
export const PEOPLE_SEARCH_MAX_CHARS = 80;

/** A lane, a search and a page size, each cleaned once at the edge (unknown lanes are refused). */
export interface PeopleListArgs {
  lane: PeopleLane;
  /** `null` when the search is empty after trimming. */
  search: string | null;
  pageSize: number;
}

export function isPeopleLane(lane: string): lane is PeopleLane {
  return (PEOPLE_LANES as readonly string[]).includes(lane);
}

/**
 * Clean a list's arguments: the lane must be one of {@link PEOPLE_LANES} (else `null`, and the server
 * refuses); the search is trimmed, inner whitespace folded, cut to {@link PEOPLE_SEARCH_MAX_CHARS} and
 * a leading `@` dropped (an operator pastes handles); the page size is a whole number clamped to
 * 1…{@link PEOPLE_PAGE_MAX}, the default when missing or not a number.
 */
export function normalizePeopleListArgs(args: {
  lane: string;
  search?: string | null;
  pageSize?: number | null;
}): PeopleListArgs | null {
  if (!isPeopleLane(args.lane)) return null;
  const folded = (args.search ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s@]+/, '')
    .slice(0, PEOPLE_SEARCH_MAX_CHARS)
    .trim();
  const search = folded.length > 0 ? folded : null;
  const asked = args.pageSize;
  const pageSize =
    asked === undefined || asked === null || !Number.isFinite(asked)
      ? PEOPLE_PAGE_SIZE
      : Math.min(PEOPLE_PAGE_MAX, Math.max(1, Math.floor(asked)));
  return { lane: args.lane, search, pageSize };
}

/** The rights a moderator can switch off one at a time (D57, D222). */
export const RESTRICTIONS = ['reports', 'hazards', 'comments', 'bounties', 'flagging'] as const;
export type Restriction = (typeof RESTRICTIONS)[number];

/** The profile fields the restriction rule reads. Absent means allowed (D57's fail-open default). */
export interface RestrictionFields {
  /** Staff are exempt from the flagging switch (D222), so it never restricts them. */
  role?: 'member' | 'moderator' | 'admin';
  canPostReports?: boolean;
  canPostHazards?: boolean;
  canPostComments?: boolean;
  canFlag?: boolean;
  activeBountyPostLimit?: number;
}

/**
 * Which rights are off, in {@link RESTRICTIONS} order. A bounty limit restricts only when it is below
 * the global cap: a limit at or above it takes nothing away. Flagging switched off restricts only a
 * member — staff are exempt from it, and the flag write lets them flag.
 */
export function restrictionsOf(p: RestrictionFields): Restriction[] {
  const off: Restriction[] = [];
  if (p.canPostReports === false) off.push('reports');
  if (p.canPostHazards === false) off.push('hazards');
  if (p.canPostComments === false) off.push('comments');
  if (bountyLimitRestricts(p.activeBountyPostLimit)) off.push('bounties');
  if (p.canFlag === false && (p.role === undefined || p.role === 'member')) off.push('flagging');
  return off;
}

/** Whether a stored bounty limit takes anything away: set, and below the global cap. */
export function bountyLimitRestricts(limit: number | undefined): boolean {
  return limit !== undefined && Number.isFinite(limit) && limit < MAX_OPEN_BOUNTIES_PER_DAY;
}

/** The bounty limit in force: the person's own, or the global cap. */
export function effectiveBountyLimitOf(limit: number | undefined | null): number {
  return limit !== undefined && limit !== null && Number.isFinite(limit) && limit >= 0
    ? limit
    : MAX_OPEN_BOUNTIES_PER_DAY;
}

/**
 * The longest avatar URL a profile mirrors from Clerk, in UTF-8 bytes. Clerk's image URLs run to a few
 * hundred; past this one is not stored (the person shows their initials) rather than refusing the
 * sync, so a People row — which carries the URL beside the names — stays a light row.
 */
export const AVATAR_URL_MAX_BYTES = 2_048;

/** `url` if a profile may store it as an avatar, else `undefined` ({@link AVATAR_URL_MAX_BYTES}). */
export function storableAvatarUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return new TextEncoder().encode(url).length <= AVATAR_URL_MAX_BYTES ? url : undefined;
}
