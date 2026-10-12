import { renderHook } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  REVIEW_SOURCE_ID,
  type ReviewRow,
  type ReviewShow,
  reviewFeatures,
  rowReview,
  showReview,
  useRowReview,
} from './reviewMarkers';

const ask = { lat: 44.5, lng: -73.3 };
const point = { lat: 44.6, lng: -73.1 };

describe('reviewFeatures', () => {
  it('is empty with no review, the ask alone with nothing to compare', () => {
    expect(reviewFeatures(null).features).toEqual([]);
    expect(reviewFeatures({ ask, name: 'Long Point' }).features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-73.3, 44.5] },
        properties: { role: 'ask', label: 'Long Point' },
      },
    ]);
    expect(reviewFeatures({ ask }).features[0]?.properties).toEqual({ role: 'ask', label: '' });
  });

  it('draws a pair as the line, the ask and the other, labeled by what the other is', () => {
    const landmark = reviewFeatures({
      ask,
      other: { point, kind: 'landmark', name: 'Long Point' },
    });
    expect(landmark.features.map((f) => f.properties?.role)).toEqual(['link', 'ask', 'other']);
    expect(landmark.features[0]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-73.3, 44.5],
        [-73.1, 44.6],
      ],
    });
    expect(landmark.features[2]?.properties?.label).toBe('Long Point (landmark)');
    const proposal = reviewFeatures({
      ask,
      other: { point, kind: 'proposal', name: 'Long Point' },
    });
    expect(proposal.features[2]?.properties?.label).toBe('Long Point (proposal)');
  });
});

describe('showReview', () => {
  function fakeMap() {
    const setData = vi.fn();
    const map = {
      getSource: vi.fn((id: string) => (id === REVIEW_SOURCE_ID ? { setData } : undefined)),
      flyTo: vi.fn(),
      fitBounds: vi.fn(),
    };
    return { map, setData, asMap: map as unknown as maplibregl.Map };
  }

  it('flies to a lone ask, frames a pair, and only clears for none', () => {
    const lone = fakeMap();
    showReview(lone.asMap, { ask });
    expect(lone.map.flyTo).toHaveBeenCalledWith({ center: [-73.3, 44.5], zoom: 14, animate: true });

    const pair = fakeMap();
    showReview(pair.asMap, { ask, other: { point, kind: 'landmark', name: 'x' } }, { zoom: 13 });
    expect(pair.map.fitBounds).toHaveBeenCalledWith(
      [
        [-73.3, 44.5],
        [-73.1, 44.6],
      ],
      { padding: 60, maxZoom: 13, animate: true },
    );

    const none = fakeMap();
    showReview(none.asMap, null);
    expect(none.setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: [] });
    expect(none.map.flyTo).not.toHaveBeenCalled();
    expect(none.map.fitBounds).not.toHaveBeenCalled();
  });
});

describe('rowReview — the map draws what the row says now (Greptile P2 on #88)', () => {
  const row = {
    coord: ask,
    name: 'Gull Rock',
    similarLandmark: { point, name: 'Gull Rock' },
    similarProposal: { coord: { lat: 44.8, lng: -73.3 }, name: 'gull rock' },
  };

  it('is the spot alone, or the spot with the lookalike asked for', () => {
    expect(rowReview(row, 'spot')).toEqual({ ask, name: 'Gull Rock' });
    expect(rowReview(row, 'landmark')).toEqual({
      ask,
      name: 'Gull Rock',
      other: { point, kind: 'landmark', name: 'Gull Rock' },
    });
    expect(rowReview(row, 'proposal')?.other).toEqual({
      point: { lat: 44.8, lng: -73.3 },
      kind: 'proposal',
      name: 'gull rock',
    });
    expect(rowReview({ coord: ask }, 'spot')).toEqual({ ask });
  });

  it('drops a pair end the row no longer reports — decided, removed or displaced', () => {
    const { similarProposal: _, ...decided } = row;
    expect(rowReview(decided, 'proposal')).toEqual({ ask, name: 'Gull Rock' });
    const { similarLandmark: __, ...removed } = row;
    expect(rowReview(removed, 'landmark')).toEqual({ ask, name: 'Gull Rock' });
    // A landmark moved (or a nearer one in its place) draws where the row says it is now.
    const moved = {
      ...row,
      similarLandmark: { point: { lat: 44.7, lng: -73.2 }, name: 'Gull Rock' },
    };
    expect(rowReview(moved, 'landmark').other?.point).toEqual({ lat: 44.7, lng: -73.2 });
  });
});

describe('useRowReview — steady across re-emits, fresh on a click', () => {
  type Props = { row: ReviewRow | undefined; show: ReviewShow; pick: unknown };

  it('holds one object while the row says the same, and hands a new one on a change or a pick', () => {
    const pick = { id: 'a' };
    const { result, rerender } = renderHook(
      ({ row, show, pick }: Props) => useRowReview(row, show, pick),
      { initialProps: { row: { coord: ask, name: 'Gull Rock' }, show: 'spot', pick } as Props },
    );
    const first = result.current;
    expect(first).toEqual({ ask, name: 'Gull Rock' });
    // The query re-emits: fresh objects, the same values — the map holds still.
    rerender({ row: { coord: { ...ask }, name: 'Gull Rock' }, show: 'spot', pick });
    expect(result.current).toBe(first);
    // The moderator clicks Show again: the same drawing, a new object, so the canvas re-centers.
    const again = { id: 'a' };
    rerender({ row: { coord: ask, name: 'Gull Rock' }, show: 'spot', pick: again });
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    // What it draws changes, with no click: a new review. No row: nothing.
    rerender({ row: { coord: point, name: 'Gull Rock' }, show: 'spot', pick: again });
    expect(result.current).not.toBe(second);
    expect(result.current?.ask).toEqual(point);
    rerender({ row: undefined, show: 'spot', pick: again });
    expect(result.current).toBeNull();
  });
});
