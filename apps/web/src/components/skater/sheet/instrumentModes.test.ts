import type { Projection, Where } from '@skating/core';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleMode } from './ConsoleMode';
import type { InstrumentPin } from './instrumentFeatures';
import { holdInstrument, useInstrumentHeld } from './instrumentLease';
import { instrumentRing, PIN_SNAP_PX, pickOnInstrument, snapPin } from './instrumentPick';
import { mapProjection, type ProjectingMap } from './instrumentProjection';

/** A flat fake map: 1,000 px per degree, the origin of x at 73°W and of y at 44°N. */
export function fakeMap(width = 600, height = 400): ProjectingMap {
  const container = { clientWidth: width, clientHeight: height } as HTMLElement;
  return {
    project: ([lng, lat]) => ({ x: (lng + 73) * 1000, y: (44 - lat) * 1000 }),
    unproject: ([x, y]) => ({ lng: x / 1000 - 73, lat: 44 - y / 1000 }),
    getContainer: () => container,
    getCenter: () => ({ lng: -72.7, lat: 43.8 }),
  };
}

const projection: Projection = mapProjection(fakeMap());
// The origin at the frame's middle: (300, 200) px.
const ORIGIN = { lng: -72.7, lat: 43.8 };
const coordAt = (x: number, y: number) => ({ lng: x / 1000 - 73, lat: 44 - y / 1000 });

describe('mapProjection', () => {
  it('turns the map into core’s projection: pixels both ways, the frame, the scale', () => {
    expect(projection.width).toBe(600);
    expect(projection.height).toBe(400);
    const [x, y] = projection.toXY([-72.7, 43.8]);
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(200);
    const [lng, lat] = projection.fromXY([300, 200]);
    expect(lng).toBeCloseTo(-72.7);
    expect(lat).toBeCloseTo(43.8);
    // 100 px is a tenth of a degree of longitude at 43.8°N: about 8 km.
    expect(100 / projection.pxPerMeter).toBeGreaterThan(7_500);
    expect(100 / projection.pxPerMeter).toBeLessThan(8_500);
  });

  it('has no scale on a degenerate map', () => {
    const flat = { ...fakeMap(), unproject: () => ({ lng: -72.7, lat: 43.8 }) };
    expect(mapProjection(flat).pxPerMeter).toBe(0);
  });
});

describe('snapPin', () => {
  const pins: InstrumentPin[] = [
    { id: 'a', coord: coordAt(100, 100), name: 'Launch A', kind: 'putIn' },
    { id: 'b', coord: coordAt(110, 100), name: 'Lot B', kind: 'parking' },
  ];
  it('takes the nearest pin within reach', () => {
    expect(snapPin(pins, projection, [108, 101])?.id).toBe('b');
    expect(snapPin(pins, projection, [99, 100])?.id).toBe('a');
  });
  it('takes none past the reach', () => {
    expect(snapPin(pins, projection, [100, 100 + PIN_SNAP_PX + 1])).toBeNull();
  });
});

describe('pickOnInstrument', () => {
  const where = (w: Where | undefined) => {
    const onChange = vi.fn();
    const mode: ConsoleMode = { kind: 'where', label: 'Snow covered', where: w, onChange };
    return { mode, onChange };
  };
  const ctx = { projection, origin: ORIGIN, pins: [] as InstrumentPin[], landmarks: [] };

  it('does nothing with no mode open', () => {
    expect(() => pickOnInstrument(null, ORIGIN, ctx)).not.toThrow();
  });

  it('names a sector by bearing from outside the ring, and a second click takes it back', () => {
    const ring = instrumentRing(projection, ORIGIN);
    expect(ring).not.toBeNull();
    const r = ring?.r ?? 0;
    const below = coordAt(300, 200 + r + 10);
    const first = where(undefined);
    pickOnInstrument(first.mode, below, ctx);
    expect(first.onChange).toHaveBeenCalledWith({ sector: 'S' });
    const again = where({ sector: 'S', extent: 'patches' });
    pickOnInstrument(again.mode, below, ctx);
    expect(again.onChange).toHaveBeenCalledWith({ extent: 'patches' });
  });

  it('places a point from inside the ring', () => {
    const { mode, onChange } = where(undefined);
    pickOnInstrument(mode, coordAt(310, 205), ctx);
    const next = onChange.mock.calls[0]?.[0] as Where;
    expect(next.point?.coord.lat).toBeCloseTo(44 - 0.205);
  });

  it('places a point when the map has not loaded (no ring to read)', () => {
    const { mode, onChange } = where(undefined);
    pickOnInstrument(mode, ORIGIN, { ...ctx, projection: undefined });
    expect((onChange.mock.calls[0]?.[0] as Where).point).toBeDefined();
  });

  it('has no ring without an origin', () => {
    expect(instrumentRing(projection, null)).toBeNull();
  });

  it('snaps a put-in click to a launch, else takes the shore', () => {
    const onPickPin = vi.fn();
    const onPickShore = vi.fn();
    const mode: ConsoleMode = { kind: 'putIn', onPickPin, onPickShore };
    const pins: InstrumentPin[] = [
      { id: 'p', coord: coordAt(100, 100), name: 'Launch', kind: 'putIn' },
    ];
    pickOnInstrument(mode, coordAt(104, 103), { ...ctx, pins });
    expect(onPickPin).toHaveBeenCalledWith('p', 'putIn');
    pickOnInstrument(mode, coordAt(200, 200), { ...ctx, pins });
    expect(onPickShore).toHaveBeenCalledWith(coordAt(200, 200));
    pickOnInstrument(mode, coordAt(100, 100), { ...ctx, pins, projection: undefined });
    expect(onPickShore).toHaveBeenCalledTimes(2);
  });

  it('places a photo where the click is', () => {
    const onPlace = vi.fn();
    pickOnInstrument({ kind: 'place', photoId: 'x', onPlace }, ORIGIN, ctx);
    expect(onPlace).toHaveBeenCalledWith(ORIGIN);
  });
});

describe('instrumentLease', () => {
  it('holds the slot while any stacked sheet holds it, and a release counts once', () => {
    const { result } = renderHook(() => useInstrumentHeld());
    expect(result.current).toBe(false);
    let a = () => {};
    let b = () => {};
    act(() => {
      a = holdInstrument();
      b = holdInstrument();
    });
    expect(result.current).toBe(true);
    act(() => {
      a();
      a();
    });
    expect(result.current).toBe(true);
    act(() => b());
    expect(result.current).toBe(false);
  });
});
