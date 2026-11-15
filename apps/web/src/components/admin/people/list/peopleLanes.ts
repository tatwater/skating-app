import { PEOPLE_LANE_LABELS, PEOPLE_LANES, type PeopleLane } from '@skating/core';

/**
 * What the page says about each lane — its name in the sidebar (core's, so a lane can't be spelled
 * two ways), its display word, the order its list comes in (the server's: the page never re-sorts),
 * what its rows' age means, and what it says when it's empty. The lanes themselves, and which a
 * viewer has, are the server's (`people.lanes`); this only words them.
 */

/** What a row's age counts from, which depends on the lane. */
export type AgeFrom =
  /** Since the person's status began (suspended, banned, deleted). */
  | 'status'
  /** Since the restriction began. */
  | 'restricted'
  /** Since the account was made. */
  | 'joined'
  /** The time left in the deletion window. */
  | 'leaving'
  /** When they were last seen in the console — no read gives it yet, so no age is drawn. */
  | 'seen';

export interface PeopleLaneInfo {
  id: PeopleLane;
  /** The sidebar's name ("Leaving · 30-day window"). */
  label: string;
  /** The display word over the list (the lane, said shortly). */
  title: string;
  /** The order the server returns it in, as the kicker says it. */
  order: string;
  age: AgeFrom;
  /** What the list says when it has no one in it. */
  empty: string;
  /** The count's ink in the sidebar when it isn't zero: amber waits on a person. */
  tone?: 'warn';
}

export const PEOPLE_LANE_INFO: Readonly<Record<PeopleLane, PeopleLaneInfo>> = {
  everyone: {
    id: 'everyone',
    label: PEOPLE_LANE_LABELS.everyone,
    title: 'Everyone',
    order: 'by name',
    age: 'joined',
    empty: 'No accounts yet',
  },
  staff: {
    id: 'staff',
    label: PEOPLE_LANE_LABELS.staff,
    title: 'Staff',
    order: 'admins first',
    age: 'seen',
    empty: 'No staff yet',
  },
  suspended: {
    id: 'suspended',
    label: PEOPLE_LANE_LABELS.suspended,
    title: 'Suspended',
    order: 'soonest to lapse first',
    age: 'status',
    empty: 'No one is suspended',
    tone: 'warn',
  },
  banned: {
    id: 'banned',
    label: PEOPLE_LANE_LABELS.banned,
    title: 'Banned',
    order: 'most recent first',
    age: 'status',
    empty: 'No one is banned',
  },
  restricted: {
    id: 'restricted',
    label: PEOPLE_LANE_LABELS.restricted,
    title: 'Restricted',
    order: 'most recently restricted first',
    age: 'restricted',
    empty: 'No one is restricted',
  },
  flagged: {
    id: 'flagged',
    label: PEOPLE_LANE_LABELS.flagged,
    title: 'Flagged',
    order: 'oldest first',
    age: 'joined',
    empty: 'No open flags on anyone or their content',
  },
  appeals: {
    id: 'appeals',
    label: PEOPLE_LANE_LABELS.appeals,
    title: 'Appeals open',
    order: 'oldest first',
    age: 'joined',
    empty: 'No appeals waiting',
  },
  newest: {
    id: 'newest',
    label: PEOPLE_LANE_LABELS.newest,
    title: 'Newest',
    order: 'newest first',
    age: 'joined',
    empty: 'No accounts made this week',
  },
  leaving: {
    id: 'leaving',
    label: PEOPLE_LANE_LABELS.leaving,
    title: 'Leaving',
    order: 'ending soonest first',
    age: 'leaving',
    empty: 'No one is leaving',
  },
  deleted: {
    id: 'deleted',
    label: PEOPLE_LANE_LABELS.deleted,
    title: 'Deleted',
    order: 'most recent first',
    age: 'status',
    empty: 'No deleted accounts',
  },
};

/** The display word and order while a search runs: it ignores the lane and ranks by match. */
export const SEARCH_INFO = { title: 'Search', order: 'best match first' } as const;

/** The sidebar's group over the lanes. */
export const LANES_GROUP = 'Lists';

/**
 * The lanes a viewer has, in the sidebar's order: Appeals open only with support's read (D37) —
 * the server's own rule (`people.lanes`), asked here so the page knows before the counts land.
 */
export function lanesFor(canReadSupport: boolean): PeopleLane[] {
  return PEOPLE_LANES.filter((lane) => lane !== 'appeals' || canReadSupport);
}
