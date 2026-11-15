import { PEOPLE_LANE_LABELS, PEOPLE_LANES, type PeopleLane } from '@skating/core';

import { LANE_WORDS } from './peopleWords';

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

/** What each lane's rows age from, and the count's tone. */
const LANE_FACTS: Readonly<Record<PeopleLane, { age: AgeFrom; tone?: 'warn' }>> = {
  everyone: { age: 'joined' },
  staff: { age: 'seen' },
  suspended: { age: 'status', tone: 'warn' },
  banned: { age: 'status' },
  restricted: { age: 'restricted' },
  // Until the server gives each person's oldest open flag or ticket, these age from joining.
  flagged: { age: 'joined' },
  appeals: { age: 'joined' },
  newest: { age: 'joined' },
  leaving: { age: 'leaving' },
  deleted: { age: 'status' },
};

export const PEOPLE_LANE_INFO: Readonly<Record<PeopleLane, PeopleLaneInfo>> = Object.fromEntries(
  PEOPLE_LANES.map((id) => [
    id,
    { id, label: PEOPLE_LANE_LABELS[id], ...LANE_WORDS[id], ...LANE_FACTS[id] },
  ]),
) as Record<PeopleLane, PeopleLaneInfo>;

/**
 * The lanes a viewer has, in the sidebar's order: Appeals open only with support's read (D37) —
 * the server's own rule (`people.lanes`), asked here so the page knows before the counts land.
 */
export function lanesFor(canReadSupport: boolean): PeopleLane[] {
  return PEOPLE_LANES.filter((lane) => lane !== 'appeals' || canReadSupport);
}
