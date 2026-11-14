import { LIBRARY_LIST_LANES } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { libraryLaneOf } from './bodiesReads';
import { FACET_IDS } from './bodyFacets';
import {
  BODY_LANES,
  type BodyLane,
  DEFAULT_LANE_ID,
  laneById,
  laneGroups,
  laneStanding,
} from './bodyLanes';

describe('the lanes', () => {
  it('have unique ids, the default among them', () => {
    const ids = BODY_LANES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_LANE_ID);
  });
  it('group as the board draws them: Views, then Standing', () => {
    expect(laneGroups(BODY_LANES).map((g) => [g.label, g.lanes.map((l) => l.label)])).toEqual([
      ['Views', ['Opened recently', 'Changed this week']],
      [
        'Standing',
        [
          'All bodies',
          'Active',
          'Dormant · inactive',
          'Dormant · not in campaign',
          'Dormant · moderator',
          'No public access',
          'Removed · rejected',
        ],
      ],
    ]);
  });
  it('each lead with the name column, sort by one of their columns and offer known facets', () => {
    for (const lane of BODY_LANES) {
      expect(lane.columns[0]).toBe('name');
      expect(lane.columns).toContain(lane.sort.column);
      for (const f of lane.facets) expect(FACET_IDS).toContain(f);
    }
  });
  it('a new lane is an entry: one whose read the route has no reader for draws unread', () => {
    const names: BodyLane = {
      ...(BODY_LANES[0] as BodyLane),
      id: 'name-conflicts',
      group: 'Corpus',
      label: 'Name conflicts',
      read: { kind: 'corpusTask', task: 'nameConflicts' },
    };
    const lanes = [...BODY_LANES, names];
    expect(laneById('name-conflicts', lanes)).toBe(names);
    expect(laneGroups(lanes).at(-1)?.label).toBe('Corpus');
    expect(libraryLaneOf(names)).toBeNull();
    expect(laneStanding(names)).toBeNull();
  });
  it('know which server lane lists each, and the one standing a lane holds', () => {
    expect(BODY_LANES.map((l) => [l.id, libraryLaneOf(l), laneStanding(l)])).toEqual([
      ['opened', null, null],
      ['changed', 'changed', null],
      ['all', 'all', null],
      ['active', 'active', 'active'],
      ['inactive', 'inactive', 'inactive'],
      ['not-in-campaign', 'not_in_campaign', 'not_in_campaign'],
      ['moderator', 'moderator', 'moderator'],
      ['no-public-access', 'no_public_access', 'no_public_access'],
      // Removed and rejected share a lane, so its rows say which.
      ['removed', 'removed', null],
    ]);
  });
  it('cover every lane the server lists', () => {
    const served = BODY_LANES.map(libraryLaneOf).filter((l) => l !== null);
    expect([...served].sort()).toEqual([...LIBRARY_LIST_LANES].sort());
  });
});
