import type maplibregl from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_SOURCE_ID, reviewFeatures, showReview } from './reviewMarkers';

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
