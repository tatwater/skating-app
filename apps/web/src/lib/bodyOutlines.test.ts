import { act, renderHook } from '@testing-library/react';
import type { Polygon } from 'geojson';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordBodyOutline, resetBodyOutlinesForTests, useBodyOutlines } from './bodyOutlines';

const square = (south: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-72.15, south],
      [-72.12, south],
      [-72.12, 43.65],
      [-72.15, 43.65],
      [-72.15, south],
    ],
  ],
});

describe('bodyOutlines', () => {
  beforeEach(() => resetBodyOutlinesForTests());

  it('publishes a lake’s outline once and keeps the snapshot stable for an unchanged one', () => {
    const { result } = renderHook(() => useBodyOutlines());
    expect(result.current).toEqual({});
    act(() => recordBodyOutline('wb1', square(43.63)));
    expect(result.current.wb1).toEqual(square(43.63));
    const snapshot = result.current;
    // The same outline re-fetched is not a new snapshot — the pool must not re-run for nothing.
    act(() => recordBodyOutline('wb1', square(43.63)));
    expect(result.current).toBe(snapshot);
    act(() => recordBodyOutline('wb1', snapshot.wb1 as Polygon));
    expect(result.current).toBe(snapshot);
    // A redrawn outline is.
    act(() => recordBodyOutline('wb1', square(43.62)));
    expect(result.current).not.toBe(snapshot);
    act(() =>
      recordBodyOutline('wb2', {
        type: 'MultiPolygon',
        coordinates: [square(43.7).coordinates],
      }),
    );
    expect(Object.keys(result.current)).toEqual(['wb1', 'wb2']);
  });
});
