/**
 * Board 5.4.4's Mascoma Lake (dev putIns / parkingAreaBodies on relation/4056603), as the Access tab
 * draws it, on the board's day (14 Oct 2026). Constants only — reached from stories and tests.
 */
import type { AccessData, PutInRow } from './accessModel';

/** The board's today: Wednesday 14 October 2026, local midday. */
export const BOARD_TODAY = new Date(2026, 9, 14, 12).getTime();
/** The ruling: 21 September 2026, local midday. */
const RULED = new Date(2026, 8, 21, 12).getTime();

const putIn = (
  id: string,
  source: PutInRow['source'],
  name: string,
  at: [number, number],
  walkM: number | null,
  where: string | null = null,
): PutInRow => ({
  id,
  source,
  name,
  at: { lat: at[0], lng: at[1] },
  walkM,
  approach: null,
  where,
});

export const MASCOMA_ACCESS: AccessData = {
  ruling: {
    verdict: 'open',
    statement: 'Accessible to the public',
    decidedAt: RULED,
    decidedBy: { name: 'Teagan', handle: 'teagan' },
    before: null,
    history: { earlier: 0, capped: false },
  },
  putIns: [
    putIn('pi-launch', 'official', 'Mascoma Lake Boat Launch', [43.6309, -72.1576], 32),
    putIn('pi-park', 'official', 'Mascoma Lakeside Park Boat Ramp', [43.6354, -72.1546], 48),
    putIn('pi-shakoma', 'official', 'Shakoma Beach', [43.6306, -72.1574], 82),
    putIn('pi-dam', 'osm', 'NW launch', [43.6489, -72.1793], 715, 'Mascoma Lake Dam'),
    putIn('pi-lower', 'osm', 'NW launch', [43.62266, -72.14666], null, 'Lower Shaker Village'),
    putIn('pi-knox', 'osm', 'SE launch', [43.6098, -72.1301], null, 'Knox River'),
  ],
  lots: [
    { id: 'lot-1', name: null, at: { lat: 43.63029, lng: -72.15763 } },
    { id: 'lot-2', name: null, at: { lat: 43.63073, lng: -72.1573 } },
    { id: 'lot-3', name: null, at: { lat: 43.63539, lng: -72.15435 } },
    {
      id: 'lot-smith',
      name: 'Smith Pond Shaker Forest Conservation Area Trailhead Parking',
      at: { lat: 43.60929, lng: -72.13765 },
    },
    { id: 'lot-5', name: null, at: { lat: 43.64954, lng: -72.17899 } },
  ],
  postedRule: null,
  alerts: [],
  failures: [],
};

/** No public access, ruled over an earlier accessible ruling, with an alert pinned on a launch. */
export const NO_ACCESS: AccessData = {
  ...MASCOMA_ACCESS,
  ruling: {
    verdict: 'none',
    statement:
      'A moderator reviewed this on 2 Oct 2026 and found no public access — every approach crosses private land.',
    decidedAt: new Date(2026, 9, 2, 12).getTime(),
    decidedBy: { name: 'Matt Steinberg', handle: 'matt' },
    before: 'open',
    // The accessible ruling it replaced.
    history: { earlier: 1, capped: false },
  },
  postedRule: 'Open sunrise to sunset',
  alerts: [{ id: 'al-1', label: 'Gate locked', on: 'Mascoma Lake Boat Launch', official: true }],
};
