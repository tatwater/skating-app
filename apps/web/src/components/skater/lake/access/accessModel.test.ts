import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_NOW, MASCOMA_ACCESS } from './accessFixtures';
import {
  type AccessData,
  derivedPutIns,
  detectPlatform,
  directionsFor,
  lotDirections,
  lotLine,
  otherParking,
  putInCards,
  reasonLabel,
} from './accessModel';

const cards = putInCards(MASCOMA_ACCESS, 'web', ACCESS_NOW);
const byId = (id: string) => {
  const card = cards.find((c) => c.id === id);
  if (!card) throw new Error(`no card ${id}`);
  return card;
};

describe('putInCards', () => {
  it('draws the whole list in core’s order, the recommended way in at the top', () => {
    expect(cards.map((c) => c.id)).toEqual(['launch', 'beach', 'ramp', 'dam', 'shaker', 'knox']);
    expect(cards.filter((c) => c.recommended).map((c) => c.id)).toEqual(['launch']);
  });

  /**
   * The fixture arrives in core's order already, so the assertion above cannot tell the two rules
   * apart. Shuffled, it can: the list is **sorted**, not "best first then whatever arrived".
   */
  it('re-orders rows the server hands over in another order', () => {
    const shuffled = {
      ...MASCOMA_ACCESS,
      putIns: [...MASCOMA_ACCESS.putIns].reverse(),
    } as AccessData;
    const out = putInCards(shuffled, 'web', ACCESS_NOW);
    expect(out.map((c) => c.id)).toEqual(['launch', 'beach', 'ramp', 'knox', 'shaker', 'dam']);
    expect(out.filter((c) => c.recommended).map((c) => c.id)).toEqual(['launch']);
  });

  it('demotes a blocked launch but never hides it', () => {
    const blocked = { ...MASCOMA_ACCESS, blockedIds: ['lot-launch'] } as AccessData;
    const out = putInCards(blocked, 'web', ACCESS_NOW);
    expect(out).toHaveLength(6);
    expect(out[0]?.id).not.toBe('launch');
    expect(out.some((c) => c.id === 'launch')).toBe(true);
  });

  it('says what to do when there is a lot, and nothing extra when there is not', () => {
    expect(byId('launch').lede).toBe(
      'Park at the boat launch lot, then put in at Mascoma Lake Boat Launch.',
    );
    expect(byId('launch').sub).toBe('Put-in with a lot · the boat launch lot');
    expect(byId('dam').lede).toBeNull();
    expect(byId('dam').sub).toBe('Shore put-in');
    expect(byId('dam').here).toBeNull();
  });

  it('keeps the hike-in apart, in core’s words', () => {
    const ramp = byId('ramp');
    expect(ramp.hikeIn).toBe(true);
    expect(ramp.approach).toBe('Park here, then about 0.3 mi on foot, 39 ft of climb.');
    // A drive-up launch has no walk to describe.
    expect(byId('launch').hikeIn).toBe(false);
    expect(byId('launch').approach).toBeNull();
  });

  it('carries the launch’s sign and its lot’s, never merged', () => {
    expect(byId('launch').posted).toHaveLength(1);
    const withLotRule = {
      ...MASCOMA_ACCESS,
      parking: MASCOMA_ACCESS.parking.map((p) =>
        p.id === 'lot-launch' ? { ...p, postedAccess: { permitRequired: true } } : p,
      ),
    } as AccessData;
    const launch = putInCards(withLotRule, 'web', ACCESS_NOW).find((c) => c.id === 'launch');
    expect(launch?.posted.map((p) => p.coord)).toEqual([
      { lat: 43.6297, lng: -72.1551 },
      { lat: 43.6299, lng: -72.1553 },
    ]);
  });

  it('hangs a lot’s alert on every launch that parks there', () => {
    const beach = byId('beach');
    expect(beach.alerts).toEqual([
      {
        id: 'alert-snow',
        reason: 'Snowed in',
        when: expect.stringMatching(/^reported Thu/),
        note: null,
        official: false,
        isOwn: false,
      },
    ]);
    expect(byId('launch').alerts).toEqual([]);
  });

  it('routes the car to the lot when there is one, else to the put-in', () => {
    expect(byId('launch').directions).toMatchObject({
      target: 'parking',
      label: 'Directions to parking',
      href: 'https://www.google.com/maps/dir/?api=1&destination=43.6299,-72.1553',
    });
    expect(byId('dam').directions).toMatchObject({
      target: 'put_in',
      label: 'Directions to the put-in',
    });
    expect(byId('dam').directions.tip).toMatch(/approximate/);
  });

  it('names the maps app per platform, and an official spot is not approximate', () => {
    const [target] = [
      {
        coord: { lat: 1, lng: 2 },
        via: 'put_in' as const,
        putIn: { id: 'x', coord: { lat: 1, lng: 2 }, source: 'official' as const },
        alerted: false,
      },
    ];
    const d = directionsFor(target, 'ios');
    expect(d.href).toBe('https://maps.apple.com/?daddr=1,2');
    expect(d.tip).toBe('Opens Apple Maps with this put-in as the destination');
  });

  it('handles a lake with no launch', () => {
    expect(putInCards({ ...MASCOMA_ACCESS, putIns: [] } as AccessData, 'web', ACCESS_NOW)).toEqual(
      [],
    );
  });

  it('reads a partial answer (no alerts, a lot with no amenities) without falling over', () => {
    const partial = {
      putIns: [{ id: 'p', coord: { lat: 1, lng: 2 }, source: 'official', parkingAreaId: 'l' }],
      parking: [{ id: 'l', coord: { lat: 1, lng: 2 }, source: 'osm' }],
      blockedIds: [],
    } as unknown as AccessData;
    const [card] = putInCards(partial, 'web', ACCESS_NOW);
    expect(card?.alerts).toEqual([]);
    expect(card?.here).toBe('Parking lot');
  });

  it('falls back to a name when a stored row has none', () => {
    const nameless = {
      ...MASCOMA_ACCESS,
      putIns: [{ ...MASCOMA_ACCESS.putIns[3], name: undefined }],
    } as AccessData;
    const [card] = putInCards(nameless, 'web', ACCESS_NOW);
    expect(card?.name).toBe('Put-in');
  });
});

describe('the lot words', () => {
  it('lists what is at a lot', () => {
    const [launchLot, beachLot, parkLot, churchLot] = MASCOMA_ACCESS.parking;
    if (!launchLot || !beachLot || !parkLot || !churchLot) throw new Error('fixture');
    expect(lotLine(launchLot)).toBe('Toilets · Boat ramp · About 12 cars');
    expect(lotLine(beachLot)).toBe('Parking lot');
    expect(lotLine(parkLot)).toBe('Fee');
    expect(lotLine({ ...churchLot, amenities: ['playground'] })).toBe('playground');
  });

  it('finds the lots no launch names, with directions to the lot', () => {
    const lots = otherParking(MASCOMA_ACCESS);
    expect(lots.map((l) => l.id)).toEqual(['lot-church']);
    const lot = lots[0];
    if (!lot) throw new Error('fixture');
    expect(lotDirections(lot, 'web')).toMatchObject({
      target: 'parking',
      tip: 'Opens Google Maps with this lot as the destination',
    });
    expect(lotDirections(lot, 'ios').tip).toMatch(/Apple Maps/);
  });

  it('words a reason, with the generic fallback', () => {
    expect(reasonLabel('gate_locked')).toBe('Gate locked');
    expect(reasonLabel('who_knows')).toBe('Access problem');
  });
});

describe('derivedPutIns', () => {
  it('lists only the report-derived spots, saying how old they are', () => {
    const out = derivedPutIns(
      [
        { coord: { lat: 1, lng: 2 }, source: 'official', id: 'o' },
        {
          coord: { lat: 3, lng: 4 },
          source: 'derived',
          reportCount: 1,
          lastUsedAt: ACCESS_NOW - 3 * 86_400_000,
        },
        { coord: { lat: 5, lng: 6 }, source: 'derived', reportCount: 4 },
        { coord: { lat: 7, lng: 8 }, source: 'derived' },
      ],
      'web',
      ACCESS_NOW,
    );
    expect(out.map((d) => d.key)).toEqual(['3,4', '5,6', '7,8']);
    expect(out[0]?.sub).toMatch(/^From skaters’ reports · 1 report · last used Wed/);
    expect(out[1]?.sub).toBe('From skaters’ reports · 4 reports');
    expect(out[2]?.sub).toBe('From skaters’ reports');
    expect(out[0]?.directions).toMatchObject({ target: 'put_in' });
    expect(
      derivedPutIns([{ coord: { lat: 1, lng: 2 }, source: 'derived' }], 'ios', 0)[0]?.directions
        .tip,
    ).toMatch(/Apple Maps/);
  });
});

describe('detectPlatform', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks Apple Maps on iOS and Google Maps elsewhere', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
    expect(detectPlatform()).toBe('ios');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(detectPlatform()).toBe('web');
    vi.stubGlobal('navigator', undefined);
    expect(detectPlatform()).toBe('web');
  });
});
