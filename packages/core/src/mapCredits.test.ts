import { describe, expect, it } from 'vitest';
import { AERIAL_CREDIT, copernicusCredit, mapCreditsFor, OSM_CREDIT } from './mapCredits';

describe('mapCreditsFor — derived from what is showing', () => {
  it('always credits OpenStreetMap, and puts it first', () => {
    // The one with a placement obligation, and the one a compliance reader looks for.
    expect(mapCreditsFor()).toEqual([{ credit: OSM_CREDIT, required: true }]);
  });

  it('adds the aerial credit only while the aerial is showing', () => {
    expect(mapCreditsFor({ aerial: true }).map((c) => c.credit)).toEqual([
      OSM_CREDIT,
      AERIAL_CREDIT,
    ]);
    expect(mapCreditsFor({ aerial: false }).map((c) => c.credit)).toEqual([OSM_CREDIT]);
  });

  it('⚠ marks NAIP as courtesy, because federal work carries no obligation', () => {
    // Worth stating rather than assuming: a renderer is allowed to de-emphasise this one and is not
    // allowed to de-emphasise Copernicus, and nothing in the strings themselves says so.
    const aerial = mapCreditsFor({ aerial: true }).find((c) => c.credit === AERIAL_CREDIT);
    expect(aerial?.required).toBe(false);
  });

  it('adds Copernicus only while a freeze-up frame is showing, and marks it required', () => {
    const credits = mapCreditsFor({ freezeUpSeason: 'winter-2025-26' });
    expect(credits[1]).toEqual({ credit: 'Copernicus Sentinel data 2025–2026', required: true });
    expect(mapCreditsFor({ freezeUpSeason: null })).toHaveLength(1);
  });

  it('carries the contour credit through as required', () => {
    const credits = mapCreditsFor({ contourCredit: 'NH Department of Environmental Services' });
    expect(credits[1]).toEqual({
      credit: 'NH Department of Environmental Services',
      required: true,
    });
  });

  it('composes every layer at once, in the order they were put on', () => {
    expect(
      mapCreditsFor({
        aerial: true,
        freezeUpSeason: 'winter-2025-26',
        contourCredit: 'MassGIS',
      }).map((c) => c.credit),
    ).toEqual([OSM_CREDIT, AERIAL_CREDIT, 'Copernicus Sentinel data 2025–2026', 'MassGIS']);
  });

  it('never drops a required credit, whatever else is on', () => {
    for (const context of [
      {},
      { aerial: true },
      { freezeUpSeason: 'winter-2025-26' },
      { aerial: true, freezeUpSeason: 'winter-2025-26', contourCredit: 'VCGI' },
    ]) {
      expect(mapCreditsFor(context).some((c) => c.required && c.credit === OSM_CREDIT)).toBe(true);
    }
  });
});

describe('copernicusCredit — a winter spans two calendar years', () => {
  it('names both, because the frames come from both', () => {
    expect(copernicusCredit('winter-2025-26')).toBe('Copernicus Sentinel data 2025–2026');
    expect(copernicusCredit('winter-2099-00')).toBe('Copernicus Sentinel data 2099–2100');
  });

  it('degrades to the bare required form rather than inventing a year', () => {
    // ESA's terms ask for "Copernicus Sentinel data [year]". A wrong year is worse than none, and an
    // unparseable season is not a reason to omit a required credit entirely.
    expect(copernicusCredit('not-a-season')).toBe('Copernicus Sentinel data');
  });
});
