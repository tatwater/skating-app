import { describe, expect, it } from 'vitest';
import { contourFeature, laneClaim, stampBodyId } from './feature';
import type { ArchivedLake } from './lakes';

function lake(over: Partial<ArchivedLake> = {}): ArchivedLake {
  return {
    sourceKey: 'nh-granit-contours',
    state: 'NH',
    agency: 'NH GRANIT',
    lane: 'contours',
    lakeKey: 'NHLAK-1',
    lakeName: 'Test Lake',
    contours: [],
    ...over,
  };
}

describe('laneClaim', () => {
  it('calls the agency’s own isobaths surveyed', () => {
    expect(laneClaim(lake({ lane: 'contours' }))).toBe('surveyed');
  });

  it('calls our fitted surface interpolated', () => {
    // The single claim this phase most cares about, and it is one string. A surface WE fitted
    // captioned as one the state surveyed is the failure §Maine step 5 exists to prevent.
    expect(laneClaim(lake({ lane: 'soundings' }))).toBe('interpolated');
  });

  it('is decided by the lane, never by the state', () => {
    // Vermont is a sounding lane and New Hampshire a contour lane, but that is a fact about the
    // source, not about the state — a state that started publishing isobaths must not need a code
    // change here.
    expect(laneClaim(lake({ state: 'VT', lane: 'contours' }))).toBe('surveyed');
    expect(laneClaim(lake({ state: 'NH', lane: 'soundings' }))).toBe('interpolated');
  });
});

describe('stampBodyId', () => {
  it('prefers the OSM externalId', () => {
    expect(stampBodyId({ externalId: 'way/456', waterBodyId: 'k17abc' })).toBe('way/456');
  });

  it('falls back to the Convex id rather than emitting an empty filter key', () => {
    // A body without an externalId should still render. Vanishing looks identical to a lake nobody
    // ever surveyed, which is the failure mode this whole package is organised against.
    expect(stampBodyId({ waterBodyId: 'k17abc' })).toBe('k17abc');
    expect(stampBodyId({ externalId: '   ', waterBodyId: 'k17abc' })).toBe('k17abc');
  });
});

describe('contourFeature', () => {
  const coordinates = [
    [-72, 44],
    [-71.99, 44.01],
  ];

  it('stamps every property the clients depend on', () => {
    const f = contourFeature({
      lake: lake(),
      body: { externalId: 'way/456', waterBodyId: 'k1' },
      agency: 'NH GRANIT',
      coordinates,
      depthFt: 20,
      intervalFt: 5,
    });
    expect(f.properties).toEqual({
      bodyId: 'way/456',
      depthFt: 20,
      lane: 'surveyed',
      agency: 'NH GRANIT',
      state: 'NH',
      intervalFt: 5,
    });
    expect(f.geometry).toEqual({ type: 'LineString', coordinates });
  });

  it('marks a sounding lane interpolated even when the agency is a state one', () => {
    const f = contourFeature({
      lake: lake({ lane: 'soundings', state: 'ME', agency: 'Maine DEP / IF&W' }),
      body: { externalId: 'way/9', waterBodyId: 'k' },
      agency: 'Maine DEP / IF&W',
      coordinates,
      depthFt: 15,
      intervalFt: 5,
    });
    expect(f.properties.lane).toBe('interpolated');
    expect(f.properties.agency).toBe('Maine DEP / IF&W');
  });

  it('writes an explicit null interval rather than omitting the key', () => {
    // A property that is sometimes absent and sometimes present is harder for a client to reason
    // about than one that is explicitly unknown.
    const f = contourFeature({
      lake: lake(),
      body: { externalId: 'way/1', waterBodyId: 'k' },
      agency: 'NH GRANIT',
      coordinates,
      depthFt: 10,
    });
    expect(f.properties.intervalFt).toBeNull();
    expect('intervalFt' in f.properties).toBe(true);
  });

  it('takes the agency it is given rather than the lake’s, so the registry stays the source', () => {
    // `sources.ts` is where a credit is maintained; the ArchivedLake copy is for logs.
    const f = contourFeature({
      lake: lake({ agency: 'stale copy' }),
      body: { externalId: 'way/1', waterBodyId: 'k' },
      agency: 'NH Department of Environmental Services · NH Fish and Game (NH GRANIT)',
      coordinates,
      depthFt: 10,
      intervalFt: 5,
    });
    expect(f.properties.agency).toContain('NH Fish and Game');
  });
});
