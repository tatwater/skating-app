import { describe, expect, it } from 'vitest';
import {
  isWeatherCellKeyForTier,
  WEATHER_TIER_SPECS,
  type WeatherTier,
  weatherCellFor,
} from './weatherCell';

// A real Vermont lake (Willoughby, roughly) — the numbers below are checked against hand arithmetic
// rather than against the implementation, so a sign flip or an off-by-one grid shift fails here.
const LAT = 44.7361;
const LNG = -72.0553;
const ELEV = 338;

describe('weatherCellFor — the D152 two-tier key', () => {
  it('snaps browse coordinates to the 0.05° cell centre', () => {
    const cell = weatherCellFor('browse', LAT, LNG, ELEV);
    // 44.7361 / 0.05 = 894.722 → 895 → 44.75;  -72.0553 / 0.05 = -1441.106 → -1441 → -72.05
    expect(cell.lat).toBe(44.75);
    expect(cell.lng).toBe(-72.05);
    // 338 / 100 = 3.38 → band 3 → centre 300 m
    expect(cell.elevationM).toBe(300);
    expect(cell.key).toBe('b:895:-1441:3');
  });

  it('snaps filter coordinates to the 0.1° cell and never bands by elevation', () => {
    const cell = weatherCellFor('filter', LAT, LNG, ELEV);
    expect(cell.lat).toBe(44.7);
    expect(cell.lng).toBe(-72.1);
    expect(cell.elevationM).toBeUndefined();
    expect(cell.key).toBe('f:447:-721:-');
  });

  it('gives the two tiers disjoint key spaces', () => {
    // The indices genuinely collide across tiers (895 vs 447 here do not, but they can), so the
    // prefix is what guarantees a browse row is never served to a filter reader.
    const browse = weatherCellFor('browse', LAT, LNG, ELEV);
    const filter = weatherCellFor('filter', LAT, LNG, ELEV);
    expect(browse.key).not.toBe(filter.key);
    expect(isWeatherCellKeyForTier(browse.key, 'browse')).toBe(true);
    expect(isWeatherCellKeyForTier(browse.key, 'filter')).toBe(false);
    expect(isWeatherCellKeyForTier(filter.key, 'filter')).toBe(true);
  });

  it('collapses two points inside one cell onto one key AND one request', () => {
    // ~1 km apart, same cell, and both elevations round to band 3 (338→3.38, 320→3.20).
    const a = weatherCellFor('browse', 44.7361, -72.0553, 338);
    const b = weatherCellFor('browse', 44.7402, -72.0498, 320);
    expect(b.key).toBe(a.key);
    // The point of D152: the *request* must match too, or the shared entry describes whichever
    // body fetched first.
    expect(b.lat).toBe(a.lat);
    expect(b.lng).toBe(a.lng);
    expect(b.elevationM).toBe(a.elevationM);
  });

  it('splits neighbours that straddle a band boundary — inherent to banding, and priced in', () => {
    // 338 m and 351 m are 13 m apart and land either side of the 350 m edge. This is *why* banding
    // costs ~1.16× rather than nothing, and it is correct: the two get different `elevation` params,
    // so they must not share a cache entry.
    const below = weatherCellFor('browse', 44.7361, -72.0553, 338);
    const above = weatherCellFor('browse', 44.7362, -72.0554, 351);
    expect(below.key).toBe('b:895:-1441:3');
    expect(above.key).toBe('b:895:-1441:4');
    expect(below.elevationM).toBe(300);
    expect(above.elevationM).toBe(400);
  });

  it('separates two points in one cell that sit in different elevation bands', () => {
    // Same 0.05° cell, 400 m apart vertically — a valley lake and a ridge pond.
    const valley = weatherCellFor('browse', 44.7361, -72.0553, 180);
    const ridge = weatherCellFor('browse', 44.7365, -72.0549, 620);
    expect(ridge.key).not.toBe(valley.key);
    expect(valley.elevationM).toBe(200);
    expect(ridge.elevationM).toBe(600);
    // Same cell centre, different elevation — which is the whole point of banding rather than
    // simply rounding coordinates coarser.
    expect(ridge.lat).toBe(valley.lat);
    expect(ridge.lng).toBe(valley.lng);
  });

  it('falls back to an unbanded key when elevation is missing, and cannot collide with a banded one', () => {
    const banded = weatherCellFor('browse', LAT, LNG, 0);
    const unbanded = weatherCellFor('browse', LAT, LNG, undefined);
    const nulled = weatherCellFor('browse', LAT, LNG, null);
    expect(unbanded.key).toBe('b:895:-1441:-');
    expect(nulled.key).toBe(unbanded.key);
    expect(unbanded.elevationM).toBeUndefined();
    // 0 m is a real elevation and bands to index 0 — it must NOT read as "no elevation", because the
    // two produce different Open-Meteo requests.
    expect(banded.key).toBe('b:895:-1441:0');
    expect(banded.key).not.toBe(unbanded.key);
    expect(banded.elevationM).toBe(0);
  });

  it('treats a non-finite elevation as absent rather than producing NaN in the key', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const cell = weatherCellFor('browse', LAT, LNG, bad);
      expect(cell.key).toBe('b:895:-1441:-');
      expect(cell.elevationM).toBeUndefined();
    }
  });

  it('emits float-clean coordinates — the snapped centre must be byte-identical between callers', () => {
    // 895 * 0.05 is 44.75000000000001 in IEEE-754 without the rounding guard, which would reach
    // Open-Meteo as a different URL for the same cell.
    for (let i = -2000; i < 2000; i += 137) {
      const cell = weatherCellFor('browse', i * 0.05, i * 0.05, 100);
      expect(String(cell.lat)).not.toMatch(/\d{10}/);
      expect(String(cell.lng)).not.toMatch(/\d{10}/);
    }
  });

  it('is idempotent — re-snapping a snapped point lands on the same cell', () => {
    for (const tier of ['browse', 'filter'] as WeatherTier[]) {
      const once = weatherCellFor(tier, LAT, LNG, ELEV);
      const twice = weatherCellFor(tier, once.lat, once.lng, once.elevationM ?? ELEV);
      expect(twice.key).toBe(once.key);
      expect(twice.lat).toBe(once.lat);
      expect(twice.lng).toBe(once.lng);
    }
  });

  it('keeps the browse grid strictly finer than the filter grid', () => {
    // Guards the D152 premise itself: if these ever invert, the "filter narrows, browse refines"
    // story is backwards and the cron would be the expensive tier.
    expect(WEATHER_TIER_SPECS.browse.cellDeg).toBeLessThan(WEATHER_TIER_SPECS.filter.cellDeg);
    expect(WEATHER_TIER_SPECS.browse.elevationBandM).not.toBeNull();
    expect(WEATHER_TIER_SPECS.filter.elevationBandM).toBeNull();
  });

  it('handles the southern hemisphere and the antimeridian without special-casing', () => {
    const south = weatherCellFor('browse', -44.7361, 172.0553, 338);
    expect(south.lat).toBe(-44.75);
    expect(south.lng).toBe(172.05);
    expect(south.key).toBe('b:-895:3441:3');
  });
});
