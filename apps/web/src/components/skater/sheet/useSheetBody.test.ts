import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBodyOutlinesForTests, useBodyOutlines } from '@/lib/bodyOutlines';
import { convexReact, fakes, resetFakes } from '../testMocks';

vi.mock('convex/react', () => convexReact);

const { useSheetBody } = await import('./useSheetBody');

const POLY = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-72.2, 43.6],
      [-72.1, 43.6],
      [-72.1, 43.7],
      [-72.2, 43.7],
      [-72.2, 43.6],
    ],
  ],
};

function answerAll() {
  fakes.queries.set('waterBodies:get', {
    available: true,
    body: { name: 'Mascoma Lake', polygon: POLY, interiorPoint: { lat: 43.65, lng: -72.15 } },
  });
  fakes.queries.set('subAreas:listForBody', [
    { _id: 'north', name: 'Mascoma North' },
    { _id: 'gone', name: 'Old bay', removed: true },
  ]);
  fakes.queries.set('accessPoints:accessForBody', {
    putIns: [
      { id: 'p1', coord: { lat: 43.61, lng: -72.19 }, name: 'Town beach' },
      { id: 'p2', coord: { lat: 43.62, lng: -72.18 } },
    ],
    parking: [{ id: 'l1', coord: { lat: 43.6, lng: -72.2 } }],
  });
  fakes.queries.set('landmarks:listForBody', [{ id: 'lm1', name: 'The narrows' }]);
  fakes.queries.set('hazards:listForBody', [
    {
      _id: 'h1',
      status: 'active',
      type: 'open_water',
      geometryKind: 'point',
      geometry: { type: 'Point', coordinates: [-72.15, 43.65] },
      radiusMeters: 30,
      bbox: [-72.16, 43.64, -72.14, 43.66],
      createdByUserId: 'user_9',
    },
    {
      _id: 'h2',
      status: 'active',
      type: 'pressure_ridge',
      geometryKind: 'line',
      geometry: { type: 'LineString', coordinates: [] },
      bufferMeters: 5,
      clippedFootprint: { type: 'Polygon', coordinates: [] },
      bbox: [0, 0, 0, 0],
    },
    { _id: 'h3', status: 'resolved', type: 'thin_ice', geometryKind: 'point', bbox: [0, 0, 0, 0] },
  ]);
  fakes.queries.set('reports:recentCardsForBodies', [{ reportId: 'r1' }]);
}

beforeEach(() => {
  resetFakes();
  resetBodyOutlinesForTests();
});

describe('useSheetBody', () => {
  it('is null for a sheet with no lake yet, and asks nothing', () => {
    const { result } = renderHook(() => useSheetBody(undefined));
    expect(result.current).toBeNull();
    expect(fakes.calls).toEqual([]);
  });

  it('gathers the lake: outline, live bays, launches and lots named, live hazards only', () => {
    answerAll();
    const { result } = renderHook(() => useSheetBody('mascoma'));
    const body = result.current;
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.name).toBe('Mascoma Lake');
    expect(body.polygon).toEqual(POLY);
    expect(body.frame).not.toBeNull();
    expect(body.silhouette?.origin).toEqual(body.frame?.origin);
    expect(body.bays).toEqual([{ id: 'north', name: 'Mascoma North' }]);
    expect(body.landmarks).toEqual([{ id: 'lm1', name: 'The narrows' }]);
    expect(body.putIns.map((p) => p.name)).toEqual(['Town beach', 'Launch']);
    expect(body.parking).toEqual([
      { id: 'l1', coord: { lat: 43.6, lng: -72.2 }, name: 'Parking', kind: 'parking' },
    ]);
    // A resolved hazard is not one the tick-through asks about.
    expect(body.hazards.map((h) => h.id)).toEqual(['h1', 'h2']);
    expect(body.hazards[0]).toMatchObject({
      label: 'open water',
      createdByUserId: 'user_9',
      shape: { radiusMeters: 30 },
    });
    expect(body.hazards[1]).toMatchObject({ label: 'pressure ridge', shape: { bufferMeters: 5 } });
    expect(body.hazards[1]?.clippedFootprint).toBeDefined();
    expect(body.recentCards).toEqual([{ reportId: 'r1' }]);
    expect(body.sunAt(Date.UTC(2027, 0, 16, 17))).not.toBeNull();
    // The outline is recorded for the photo pool's location rules.
    expect(renderHook(() => useBodyOutlines()).result.current.mascoma).toEqual(POLY);
  });

  it('holds an empty lake while the queries load or the lake is unavailable', () => {
    fakes.queries.set('waterBodies:get', { available: false });
    const { result } = renderHook(() => useSheetBody('mascoma'));
    expect(result.current).toMatchObject({
      waterBodyId: 'mascoma',
      name: '',
      polygon: null,
      silhouette: null,
      frame: null,
      bays: [],
      landmarks: [],
      putIns: [],
      parking: [],
      hazards: [],
      recentCards: [],
    });
    // No outline and no centroid: no sun to compute.
    expect(result.current?.sunAt(Date.UTC(2027, 0, 16, 17))).toBeNull();
    expect(renderHook(() => useBodyOutlines()).result.current.mascoma).toBeUndefined();
  });
});
