import { type CorpusTaskLane, LIBRARY_LANES, type LibraryListLane } from '@skating/core';

import type { BodyColumnId, BodySort, BodyStandingKey } from './bodiesModel';
import type { FacetId } from './bodyFacets';

/**
 * The library's lanes — **data, not code.** The sidebar, the page word, the list's columns, its
 * first order and the read the route runs all come from one entry here, so a new lane (a Corpus
 * task folded in as *Name conflicts*, say) is an entry, not a rewrite: give it a `read` the route
 * knows how to run, and the page draws it.
 *
 * The sidebar picks **which list** (one lane at a time); what narrows the list on screen is a
 * facet over it, never a lane (the founder's rule).
 */

/**
 * The read behind a lane, as the route resolves it. A new `kind` is a new reader in the route's
 * registry (`BodiesRoute`); the page never looks inside.
 */
export type BodyLaneRead =
  /**
   * A lane of the server's library (`bodies.listPage`): every body, a standing lane, or *Changed
   * this week* — core's `LIBRARY_LIST_LANES`.
   */
  | { kind: 'library'; lane: LibraryListLane }
  /** Bodies the viewer opened, newest first. */
  | { kind: 'openedByViewer' }
  /** A Corpus task lane's queue (`BodiesRoute` draws it as `CorpusTaskView`). */
  | { kind: 'corpusTask'; task: CorpusTaskLane };

export interface BodyLane {
  /** The lane in the URL (`?lane=`) and in the sidebar. */
  id: string;
  /** The sidebar group's kicker. */
  group: string;
  /** The sidebar's words ("Dormant · inactive"). */
  label: string;
  /** The page word — the list's subject ("Active bodies"). */
  title: string;
  /** The lane in a word, for the kicker's "187 of 1,412 active". */
  word: string;
  read: BodyLaneRead;
  /** The table's columns, in order. `name` leads. */
  columns: readonly BodyColumnId[];
  /** The order the lane opens in. */
  sort: Exclude<BodySort, { column: 'match' }>;
  /** The state tabs over the list (off for a lane that's already one place). */
  stateTabs: boolean;
  /** The facets its Filter menu offers. */
  facets: readonly FacetId[];
  /** Rows say their standing under the name (a lane that holds more than one). */
  showStanding: boolean;
}

const ALL_COLUMNS: readonly BodyColumnId[] = [
  'name',
  'class',
  'state',
  'acres',
  'complete',
  'asks',
  'reports',
  'changed',
];

const ALL_FACETS: readonly FacetId[] = [
  'class',
  'size',
  'outline',
  'putins',
  'reports',
  'complete',
  'curation',
];

const lane = (
  l: Omit<BodyLane, 'columns' | 'facets' | 'stateTabs' | 'showStanding'> & Partial<BodyLane>,
): BodyLane => ({
  columns: ALL_COLUMNS,
  facets: ALL_FACETS,
  stateTabs: true,
  showStanding: false,
  ...l,
});

const BY_REPORTS = { column: 'reports', dir: 'desc' } as const;
const BY_CHANGE = { column: 'changed', dir: 'desc' } as const;

export const BODY_LANES: readonly BodyLane[] = [
  lane({
    id: 'opened',
    group: 'Views',
    label: 'Opened recently',
    title: 'Opened recently',
    word: 'opened',
    read: { kind: 'openedByViewer' },
    sort: BY_CHANGE,
    showStanding: true,
  }),
  lane({
    id: 'changed',
    group: 'Views',
    label: 'Changed this week',
    title: 'Changed this week',
    word: 'changed',
    read: { kind: 'library', lane: 'changed' },
    sort: BY_CHANGE,
    showStanding: true,
  }),
  lane({
    id: 'all',
    group: 'Standing',
    label: 'All bodies',
    title: 'All bodies',
    word: 'bodies',
    read: { kind: 'library', lane: 'all' },
    sort: BY_REPORTS,
    showStanding: true,
  }),
  lane({
    id: 'active',
    group: 'Standing',
    label: 'Active',
    title: 'Active bodies',
    word: 'active',
    read: { kind: 'library', lane: 'active' },
    sort: BY_REPORTS,
  }),
  lane({
    id: 'inactive',
    group: 'Standing',
    label: 'Dormant · inactive',
    title: 'Inactive bodies',
    word: 'inactive',
    read: { kind: 'library', lane: 'inactive' },
    sort: BY_CHANGE,
  }),
  lane({
    id: 'not-in-campaign',
    group: 'Standing',
    label: 'Dormant · not in campaign',
    title: 'Not in campaign',
    word: 'not in campaign',
    read: { kind: 'library', lane: 'not_in_campaign' },
    sort: BY_CHANGE,
  }),
  lane({
    id: 'moderator',
    group: 'Standing',
    label: 'Dormant · moderator',
    title: 'Dormant by a moderator',
    word: 'dormant',
    read: { kind: 'library', lane: 'moderator' },
    sort: BY_CHANGE,
  }),
  lane({
    id: 'no-public-access',
    group: 'Standing',
    label: 'No public access',
    title: 'No public access',
    word: 'ruled',
    read: { kind: 'library', lane: 'no_public_access' },
    sort: BY_CHANGE,
  }),
  lane({
    id: 'removed',
    group: 'Standing',
    label: 'Removed · rejected',
    title: 'Removed · rejected',
    word: 'removed',
    read: { kind: 'library', lane: 'removed' },
    sort: BY_CHANGE,
    showStanding: true,
  }),
];

/**
 * The one standing a lane holds, if it holds one (`active` for Active): its rows say no standing of
 * their own. *Removed · rejected* holds two, *All* and the views every one.
 */
export function laneStanding(lane: BodyLane): BodyStandingKey | null {
  if (lane.read.kind !== 'library') return null;
  const l = lane.read.lane;
  return (LIBRARY_LANES as readonly string[]).includes(l) && l !== 'removed'
    ? (l as BodyStandingKey)
    : null;
}

/** The lane the library opens on. */
export const DEFAULT_LANE_ID = 'active';

export function laneById(
  id: string | undefined,
  lanes: readonly BodyLane[] = BODY_LANES,
): BodyLane {
  return (
    lanes.find((l) => l.id === id) ??
    // The default lane is always in the list (`bodyLanes.test.ts`).
    (lanes.find((l) => l.id === DEFAULT_LANE_ID) as BodyLane)
  );
}

/** The lanes grouped as the sidebar draws them, groups in their first lane's order. */
export function laneGroups(lanes: readonly BodyLane[]): { label: string; lanes: BodyLane[] }[] {
  const groups: { label: string; lanes: BodyLane[] }[] = [];
  for (const l of lanes) {
    const group = groups.find((g) => g.label === l.group);
    if (group) group.lanes.push(l);
    else groups.push({ label: l.group, lanes: [l] });
  }
  return groups;
}
