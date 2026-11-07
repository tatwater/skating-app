import { BAND_SOURCE_LAYER, CONTOUR_SOURCE_LAYER } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { contourFilter } from './contourMap';
import {
  BANDS_FADE_MS,
  BANDS_SOURCE_LAYER,
  bandRangeLabel,
  bandsFilter,
  lakeBands,
  sameBands,
} from './depthBands';

describe('the band layer', () => {
  it('is the pipeline’s second layer in the contour archive, beside the lines', () => {
    expect(BANDS_SOURCE_LAYER).toBe('bathymetry_bands');
    expect(BANDS_SOURCE_LAYER).toBe(BAND_SOURCE_LAYER);
    expect(BANDS_SOURCE_LAYER).not.toBe(CONTOUR_SOURCE_LAYER);
  });

  it('filters on the contours’ own key: one filter scopes both layers, and no lake draws no band', () => {
    expect(bandsFilter).toBe(contourFilter);
    expect(bandsFilter('way/1')).toEqual(['==', ['get', 'bodyId'], 'way/1']);
    expect(bandsFilter(null)).toEqual(['==', ['literal', true], ['literal', false]]);
  });

  it('arrives with the contours', () => {
    expect(BANDS_FADE_MS).toBe(220);
  });
});

describe('lakeBands', () => {
  it('keeps one per band index, shallow first, across the tiles a band spans', () => {
    expect(
      lakeBands([
        { bandIndex: 6, minDepthFt: 70, lane: 'surveyed' },
        { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
        { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
        { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
      ]),
    ).toEqual([
      { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
      { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
      { bandIndex: 6, minDepthFt: 70 },
    ]);
  });

  it('skips what it can’t read rather than guessing, and drops a junk ceiling', () => {
    expect(
      lakeBands([
        { minDepthFt: 0 },
        { bandIndex: 1.5, minDepthFt: 5 },
        { bandIndex: 3 },
        { bandIndex: 4, minDepthFt: 30, maxDepthFt: Number.NaN },
      ]),
    ).toEqual([{ bandIndex: 4, minDepthFt: 30 }]);
  });
});

describe('sameBands', () => {
  const a = [{ bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 }];
  it('compares by value', () => {
    expect(sameBands(a, [{ bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 }])).toBe(true);
    expect(sameBands(a, [])).toBe(false);
    expect(sameBands(a, [{ bandIndex: 0, minDepthFt: 0 }])).toBe(false);
    expect(sameBands(a, [{ bandIndex: 1, minDepthFt: 0, maxDepthFt: 10 }])).toBe(false);
    expect(sameBands(a, [{ bandIndex: 0, minDepthFt: 5, maxDepthFt: 10 }])).toBe(false);
  });
});

describe('bandRangeLabel', () => {
  it('reads the contours that bound the band, not the ramp', () => {
    expect(bandRangeLabel({ bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 })).toBe('0–10 ft');
    expect(bandRangeLabel({ bandIndex: 4, minDepthFt: 30, maxDepthFt: 50 })).toBe('30–50 ft');
    expect(bandRangeLabel({ bandIndex: 6, minDepthFt: 70 })).toBe('70+ ft');
  });
});
