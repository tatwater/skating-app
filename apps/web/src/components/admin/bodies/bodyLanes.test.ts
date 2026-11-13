import { describe, expect, it } from 'vitest';

import { searchesByName, standingLaneOf } from './bodiesReads';
import { FACET_IDS } from './bodyFacets';
import { BODY_LANES, type BodyLane, DEFAULT_LANE_ID, laneById, laneGroups } from './bodyLanes';

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
    expect(standingLaneOf(names)).toBeNull();
    expect(searchesByName(names)).toBe(false);
  });
  it('know which existing read serves each standing lane', () => {
    expect(BODY_LANES.map((l) => [l.id, standingLaneOf(l), searchesByName(l)])).toEqual([
      ['opened', null, false],
      ['changed', null, false],
      ['all', null, true],
      ['active', null, true],
      ['inactive', 'inactive', false],
      ['not-in-campaign', 'not_in_campaign', false],
      ['moderator', 'moderator', false],
      ['no-public-access', 'no_public_access', false],
      ['removed', 'removed', false],
    ]);
  });
});
