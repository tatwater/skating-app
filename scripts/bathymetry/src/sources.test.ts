import { CONTOUR_SOURCE_TERMS } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { coveredStates, SOURCES, sourceByKey, sourcesForState } from './sources';

describe('the source registry', () => {
  it('has a unique, stable key per source — the key is the archive directory name', () => {
    const keys = SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Keys name a directory under `.raw/` that we keep forever, so they must be filesystem-safe.
    for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
  });

  it('records a datum for every source, because they do not share one', () => {
    // The Champlain/ANR datum split is the trap the plan flagged; the rule only holds if every
    // source can state its reference, so an empty datum is a registry bug rather than a detail.
    for (const source of SOURCES) expect(source.datum.length).toBeGreaterThan(0);
  });

  it('records an attribution and a source URL for every source (§5)', () => {
    for (const source of SOURCES) {
      expect(source.attribution.length).toBeGreaterThan(0);
      expect(source.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('gives ArcGIS sources a bare layer endpoint — no query string, no trailing slash', () => {
    for (const source of SOURCES) {
      if (source.fetch.type !== 'arcgis') continue;
      expect(source.fetch.url).not.toContain('?');
      expect(source.fetch.url).not.toMatch(/\/$/);
      expect(source.fetch.url).toMatch(/\/(Feature|Map)Server\/\d+$/);
    }
  });

  it('gives file sources a filename with an extension, stored byte-faithful', () => {
    for (const source of SOURCES) {
      if (source.fetch.type !== 'file') continue;
      expect(source.fetch.filename).toMatch(/\.\w+$/);
    }
  });

  it('covers the four states that publish, and treats every VT/ME source as a sounding lane', () => {
    expect(coveredStates()).toEqual(['MA', 'ME', 'NH', 'VT']);
    // The correction that reshaped the phase: Vermont publishes points, not isobaths, so it belongs
    // in Maine's lane rather than New Hampshire's. A regression here would silently restore the
    // plan's original (wrong) premise that VT is a clean contour download.
    for (const source of sourcesForState('VT')) expect(source.kind).toBe('soundings');
    for (const source of sourcesForState('ME')) expect(source.kind).toBe('soundings');
    for (const source of sourcesForState('NH')) expect(source.kind).toBe('contours');
    for (const source of sourcesForState('MA')) expect(source.kind).toBe('contours');
  });

  it('does not list New York — its absence is a checked finding, not a gap to fill in later', () => {
    expect(sourcesForState('NY')).toEqual([]);
  });

  it('carries feet as the native unit everywhere, so there is no cross-state unit seam', () => {
    // D83's premise was that VT publishes metres and NH/MA feet, which would put a unit change on a
    // state line. Every source we actually fetch is feet, so the rule stands and the seam does not.
    for (const source of SOURCES) expect(source.unit).toBe('ft');
  });

  it('looks a source up by key, and says so when there is none', () => {
    expect(sourceByKey('nh-granit-contours')?.state).toBe('NH');
    expect(sourceByKey('nope')).toBeUndefined();
  });

  it('is case-insensitive about state lookups', () => {
    expect(sourcesForState('nh')).toHaveLength(1);
  });
});

describe('attribution and notices', () => {
  it('gives every source a credit line, because the drawer has to render one', () => {
    for (const source of SOURCES) {
      expect(source.attribution.trim().length).toBeGreaterThan(0);
    }
  });

  it('credits Champlain to the holders VCGI actually names, not to NOAA alone', () => {
    // VCGI's own `copyrightText` is "University of Vermont (JEFF LAIBLE), VCGI". The placeholder
    // credit omitted UVM — the named copyright holder — and added two agencies who are not in it.
    const champlain = sourceByKey('vt-vcgi-champlain-soundings');
    expect(champlain?.attribution).toContain('University of Vermont');
    expect(champlain?.attribution).toContain('VCGI');
  });

  it('says the Champlain soundings were digitised rather than surveyed by NOAA', () => {
    // NOAA asks that attribution not imply endorsement or affiliation, and that modified data not be
    // presented as unaltered NOAA data. Ours is doubly derived: chart -> digitised -> interpolated.
    const champlain = sourceByKey('vt-vcgi-champlain-soundings');
    expect(champlain?.attribution).toMatch(/digitised|digitized/i);
    expect(champlain?.attribution).toContain('NOAA nautical charts');
  });

  it('carries the not-for-navigation notice on the chart-derived source and nowhere else', () => {
    for (const source of SOURCES) {
      if (source.key === 'vt-vcgi-champlain-soundings') {
        expect(source.notice).toMatch(/not for navigation/i);
      } else {
        expect(source.notice).toBeUndefined();
      }
    }
  });
});

/**
 * The credit contract across the ETL/app boundary.
 *
 * The tile carries each line's short `agency` label, not its attribution — so the client resolves
 * the label back to the required wording through `CONTOUR_SOURCE_TERMS` in `@skating/core`. That
 * table is a hand-mirrored copy of the `attribution`/`notice` fields above, because the app cannot
 * import from `scripts/`, and a copy nobody checks is how a credit goes quietly stale the first time
 * an agency restates its terms.
 *
 * This is that check. It fails in the direction that matters: adding a source here without adding it
 * there ships lines with **no credit at all**, and editing an attribution here without editing there
 * ships the old wording — neither of which is visible on a rendered map.
 */
describe('the credit registry the client renders', () => {
  it('resolves every source agency to its required wording, verbatim', () => {
    for (const source of SOURCES) {
      const terms = CONTOUR_SOURCE_TERMS[source.agency];
      expect(terms, `no client credit registered for "${source.agency}"`).toBeDefined();
      expect(terms?.credit).toBe(source.attribution);
      expect(terms?.notice).toBe(source.notice);
    }
  });

  it('registers nothing the ETL does not actually stamp', () => {
    // A stale entry is harmless to render but it is a claim about data we no longer hold, sitting in
    // a table whose whole job is to be trustworthy about provenance.
    const stamped = new Set(SOURCES.map((s) => s.agency));
    for (const agency of Object.keys(CONTOUR_SOURCE_TERMS)) expect(stamped.has(agency)).toBe(true);
  });
});
