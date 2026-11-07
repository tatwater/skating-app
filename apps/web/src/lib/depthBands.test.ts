import { describe, expect, it } from 'vitest';
import { contourFilter } from './contourMap';
import {
  BANDS_FADE_MS,
  BANDS_SOURCE_ID,
  bandsFilter,
  bandsSourceSpec,
  isBandsSourceError,
} from './depthBands';

describe('the band archive’s source', () => {
  it('range-reads an absolute archive as given', () => {
    expect(bandsSourceSpec('https://tiles.test/bands.pmtiles')).toEqual({
      type: 'vector',
      url: 'pmtiles://https://tiles.test/bands.pmtiles',
    });
  });

  it('resolves a root-relative dev file against the page', () => {
    expect(bandsSourceSpec('/dev-tiles/bands.pmtiles', 'http://localhost:3000/water/x').url).toBe(
      'pmtiles://http://localhost:3000/dev-tiles/bands.pmtiles',
    );
    // jsdom has a page, so the default base is the window's.
    expect(bandsSourceSpec('/dev-tiles/bands.pmtiles').url).toMatch(
      /^pmtiles:\/\/http:\/\/[^/]+\/dev-tiles\/bands\.pmtiles$/,
    );
  });

  it('leaves a relative path alone where there is no page to resolve it against', () => {
    expect(bandsSourceSpec('/dev-tiles/bands.pmtiles', null).url).toBe(
      'pmtiles:///dev-tiles/bands.pmtiles',
    );
  });
});

describe('the band filter', () => {
  it('is the contours’ own: one key scopes both layers, and no lake draws no band', () => {
    expect(bandsFilter).toBe(contourFilter);
    expect(bandsFilter('way/1')).toEqual(['==', ['get', 'bodyId'], 'way/1']);
    expect(bandsFilter(null)).toEqual(['==', ['literal', true], ['literal', false]]);
  });

  it('arrives with the contours', () => {
    expect(BANDS_FADE_MS).toBe(220);
  });
});

describe('isBandsSourceError', () => {
  it('knows its own source’s failures, and nothing else', () => {
    expect(isBandsSourceError({ sourceId: BANDS_SOURCE_ID, error: new Error('404') })).toBe(true);
    expect(isBandsSourceError({ sourceId: 'bathymetry', error: new Error('404') })).toBe(false);
    expect(isBandsSourceError({ error: new Error('style') })).toBe(false);
    expect(isBandsSourceError(null)).toBe(false);
    expect(isBandsSourceError('error')).toBe(false);
  });
});
