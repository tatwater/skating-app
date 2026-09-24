import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordBodyBox, resetBodyBoxesForTests, useBodyBoxes } from './bodyBoxes';

const box = { minLat: 43.63, maxLat: 43.65, minLng: -72.15, maxLng: -72.12 };

describe('bodyBoxes', () => {
  beforeEach(() => resetBodyBoxesForTests());

  it('publishes a lake’s box once and keeps the snapshot stable for an unchanged one', () => {
    const { result } = renderHook(() => useBodyBoxes());
    expect(result.current).toEqual({});
    act(() => recordBodyBox('wb1', box));
    expect(result.current.wb1).toEqual(box);
    const snapshot = result.current;
    act(() => recordBodyBox('wb1', { ...box }));
    // The same box again is not a new snapshot — the pool must not re-run for nothing.
    expect(result.current).toBe(snapshot);
    act(() => recordBodyBox('wb2', { ...box, minLat: 43.7 }));
    expect(Object.keys(result.current)).toEqual(['wb1', 'wb2']);
  });
});
