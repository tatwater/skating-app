import { describe, expect, it } from 'vitest';

import {
  draftShape,
  LOT_PICK_RADIUS_M,
  modeBarOf,
  nearestLot,
  needsHikeIn,
  pickedLot,
  saveBlocker,
  savedTitle,
  startLink,
  startLot,
  startPutIn,
  straightMeters,
  taskHeading,
  withPick,
} from './accessDraft';
import { MASCOMA_ACCESS } from './accessFixtures';

/** Access's map tasks as data (B01-6b): each step's words, the pick, and what blocks the save. */

const LOTS = MASCOMA_ACCESS.lots;
const SMITH = LOTS.find((l) => l.id === 'lot-smith');
const LAUNCH = {
  id: 'pi-dam',
  name: 'NW launch',
  at: { lat: 43.6489, lng: -72.1793 },
  lotId: null,
  hikeIn: false,
};

describe('placing a put-in or a lot', () => {
  it('waits for a click, then saves; each starts a session of its own', () => {
    const a = startPutIn();
    const b = startLot();
    expect(a.session).not.toBe(b.session);
    expect(saveBlocker(a)).toBe('Click the shore where people get on the ice');
    expect(saveBlocker(b)).toBe('Click where the cars park');
    expect(modeBarOf(a)).toMatchObject({ mode: 'Put-in mode', step: 'Step 1 of 2' });
    expect(modeBarOf(b)).toMatchObject({ mode: 'Parking mode', step: 'Step 1 of 2' });
    const at = { lat: 43.63, lng: -72.15 };
    const placedA = withPick(a, at, LOTS);
    const placedB = withPick(b, at, LOTS);
    expect(saveBlocker(placedA)).toBeNull();
    expect(saveBlocker(placedB)).toBeNull();
    expect(modeBarOf(placedA).step).toBe('Step 2 of 2');
    expect(modeBarOf(placedB).step).toBe('Step 2 of 2');
    expect([taskHeading(a), taskHeading(b)]).toEqual(['New put-in', 'New lot']);
    // A placement draws its own mark; it adds no draft.
    expect(draftShape(placedA, LOTS)).toBeNull();
    expect(pickedLot(placedA, LOTS)).toBeNull();
    expect(straightMeters(placedA, LOTS)).toBeNull();
  });

  it('names what was placed, when it was named', () => {
    expect(savedTitle({ ...startPutIn(), name: ' Town Beach ' }, LOTS)).toBe(
      'Put-in placed · Town Beach',
    );
    expect(savedTitle(startPutIn(), LOTS)).toBe('Put-in placed');
    expect(savedTitle({ ...startLot(), name: 'Town lot' }, LOTS)).toBe('Lot placed · Town lot');
    expect(savedTitle(startLot(), LOTS)).toBe('Lot placed');
  });
});

describe('linking a lot', () => {
  it('picks the nearest lot within reach, and says a miss', () => {
    expect(nearestLot(LOTS, { lat: 43.63029, lng: -72.15763 })?.id).toBe('lot-1');
    expect(nearestLot(LOTS, { lat: 43.63071, lng: -72.15731 })?.id).toBe('lot-2');
    expect(nearestLot(LOTS, { lat: 43.7, lng: -72.3 })).toBeNull();
    expect(LOT_PICK_RADIUS_M).toBeGreaterThan(50);

    const start = startLink(LAUNCH);
    expect(saveBlocker(start)).toBe('Click a lot on the map, or choose No parking');
    expect(modeBarOf(start)).toMatchObject({ mode: 'Link mode', step: 'Step 1 of 2' });
    expect(taskHeading(start)).toBe('Link a lot · NW launch');
    const missed = withPick(start, { lat: 43.7, lng: -72.3 }, LOTS);
    expect(missed).toMatchObject({ misses: 1, choice: null });
    expect(saveBlocker(missed)).toMatch(/wasn’t on a lot/);
    const picked = withPick(missed, SMITH?.at ?? { lat: 0, lng: 0 }, LOTS);
    expect(pickedLot(picked, LOTS)?.id).toBe('lot-smith');
    expect(modeBarOf(picked).step).toBe('Step 2 of 2');
    expect(saveBlocker(picked)).toBeNull();
    // A later miss keeps the lot picked.
    expect(pickedLot(withPick(picked, { lat: 43.7, lng: -72.3 }, LOTS), LOTS)?.id).toBe(
      'lot-smith',
    );
    expect(savedTitle(picked, LOTS)).toBe(
      'Linked Smith Pond Shaker Forest Conservation Area Trailhead Parking to NW launch',
    );
    // The two ends as hollow rings, never a line between them.
    expect(draftShape(start, LOTS)).toEqual({
      type: 'MultiPoint',
      coordinates: [[-72.1793, 43.6489]],
    });
    expect(draftShape(picked, LOTS)).toMatchObject({ type: 'MultiPoint' });
    expect((draftShape(picked, LOTS) as GeoJSON.MultiPoint).coordinates).toHaveLength(2);
  });

  it('measures the straight line, and asks for the hike-in past the D144 line', () => {
    const near = withPick(startLink(LAUNCH), { lat: 43.64954, lng: -72.17899 }, LOTS);
    expect(straightMeters(near, LOTS)).toBeLessThan(200);
    expect(needsHikeIn(near, LOTS)).toBe(false);
    const far = withPick(startLink(LAUNCH), SMITH?.at ?? { lat: 0, lng: 0 }, LOTS);
    expect(straightMeters(far, LOTS)).toBeGreaterThan(1_600);
    expect(needsHikeIn(far, LOTS)).toBe(true);
    expect(needsHikeIn(startLink(LAUNCH), LOTS)).toBe(false);
    // An unnamed lot is named for what it is.
    expect(savedTitle(near, LOTS)).toBe('Lot linked to NW launch');
  });

  it('refuses a save that changes nothing; No parking, or a new assertion, is a change', () => {
    const linked = { ...LAUNCH, lotId: 'lot-5' };
    const same = withPick(startLink(linked), { lat: 43.64954, lng: -72.17899 }, LOTS);
    expect(saveBlocker(same)).toBe('That’s the lot it has already');
    expect(saveBlocker({ ...same, hikeIn: true })).toBeNull();
    const none = { ...startLink(linked), choice: 'none' as const };
    expect(saveBlocker(none)).toBeNull();
    expect(savedTitle(none, LOTS)).toBe('No parking for NW launch');
    expect(saveBlocker({ ...startLink(LAUNCH), choice: 'none' as const })).toBe(
      'It has no lot already',
    );
    // A lot no longer listed is no pick.
    expect(pickedLot({ ...startLink(LAUNCH), choice: { lotId: 'gone' } }, LOTS)).toBeNull();
    expect(pickedLot({ ...startLink(LAUNCH), choice: 'none' }, LOTS)).toBeNull();
  });
});
