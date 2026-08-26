import { describe, expect, it } from 'vitest';
import {
  allReferenceLinks,
  communityFor,
  communityUrl,
  copernicusUrl,
  linkCoordinate,
  referenceLinkError,
  SATELLITE_MIN_AREA_SQM,
  satelliteImageryAvailable,
  WINDY_ZOOM,
  windyUrl,
} from './referenceLinks';

/** A fixed clock, so the Copernicus window's shape can be asserted without re-dating the test. */
const NOW = Date.parse('2026-01-15T12:00:00.000Z');

/** Lake Champlain's two points, measured in N6c-1: they are 30.7 km apart. */
const CHAMPLAIN_INTERIOR = { lat: 44.5325, lng: -73.3251 };
const CHAMPLAIN_SHORELINE = { lat: 44.2757, lng: -73.3894 };

describe('linkCoordinate', () => {
  it('prefers interiorPoint, because centroid is a shoreline point', () => {
    expect(
      linkCoordinate({
        interiorPoint: CHAMPLAIN_INTERIOR,
        representativePoint: CHAMPLAIN_SHORELINE,
        centroid: CHAMPLAIN_SHORELINE,
      }),
    ).toEqual(CHAMPLAIN_INTERIOR);
  });

  it('falls back to representativePoint, then centroid, for pre-N6c-1 rows', () => {
    expect(
      linkCoordinate({ representativePoint: CHAMPLAIN_SHORELINE, centroid: undefined }),
    ).toEqual(CHAMPLAIN_SHORELINE);
    expect(linkCoordinate({ centroid: CHAMPLAIN_SHORELINE })).toEqual(CHAMPLAIN_SHORELINE);
  });

  it('has no coordinate to offer when the row carries none', () => {
    expect(linkCoordinate({})).toBeUndefined();
  });

  /**
   * The regression this module exists to prevent. A link built from `centroid` opens 30.7 km from
   * mid-Champlain, and it does so silently — a shoreline coordinate is a *valid* coordinate, which
   * is exactly why the fetch profile shipped with the same bug and passed every unit test.
   */
  it('does not build a Windy link 30 km off the lake when both points are present', () => {
    const body = {
      interiorPoint: CHAMPLAIN_INTERIOR,
      centroid: CHAMPLAIN_SHORELINE,
    };
    expect(windyUrl(linkCoordinate(body) as { lat: number; lng: number })).toContain('44.5325');
  });
});

describe('windyUrl', () => {
  it('emits Windy’s documented lat,lng,zoom form', () => {
    expect(windyUrl(CHAMPLAIN_INTERIOR)).toBe(
      `https://www.windy.com/?44.5325,-73.3251,${WINDY_ZOOM}`,
    );
  });

  it('takes an explicit zoom when a caller has a reason to override the regional default', () => {
    expect(windyUrl(CHAMPLAIN_INTERIOR, 12)).toContain(',12');
  });
});

describe('communityFor / communityUrl', () => {
  it('searches a Google Group archive by body name', () => {
    expect(communityUrl({ name: 'Lake Willoughby', states: ['VT'] })).toBe(
      'https://groups.google.com/g/vtnordicskating/search?q=Lake%20Willoughby',
    );
  });

  it('links a Facebook group’s front page, never its unstable in-group search', () => {
    const url = communityUrl({ name: 'Sebago Lake', states: ['ME'] });
    expect(url).toBe('https://www.facebook.com/groups/maineandnhskatingandicereport');
    expect(url).not.toContain('Sebago');
  });

  it('gives an unnamed body the group front page rather than nothing', () => {
    expect(communityUrl({ states: ['NH'] })).toBe('https://groups.google.com/g/nhnordicskating');
  });

  it('sends Massachusetts to the New England regional group', () => {
    expect(communityFor({ states: ['MA'] })?.label).toBe('New England Nordic Skaters');
  });

  it('picks the first state with a community, so a border body does not flip between renders', () => {
    // `states` is sorted by importCanonical, so this is stable rather than merely arbitrary.
    expect(communityFor({ states: ['NY', 'VT'] })?.label).toBe('ADKNordicSkating');
    expect(communityFor({ states: ['NY', 'VT'] })?.label).toBe('ADKNordicSkating');
  });

  it('offers nothing for a state we have no community for', () => {
    expect(communityFor({ states: ['CT'] })).toBeUndefined();
    expect(communityUrl({ states: ['CT'] })).toBeUndefined();
    expect(communityUrl({})).toBeUndefined();
  });
});

describe('referenceLinkError', () => {
  it('accepts an ordinary association URL', () => {
    expect(
      referenceLinkError({ label: 'Westmore Association', url: 'https://example.org/westmore' }),
    ).toBeNull();
    expect(referenceLinkError({ label: 'Plain http', url: 'http://example.org' })).toBeNull();
  });

  /** The reason this function exists: an `href` is an execution context. */
  it.each([
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.org/abc',
  ])('refuses the %s scheme rather than deny-listing one at a time', (url) => {
    expect(referenceLinkError({ label: 'Association', url })).toBe(
      'A link must be http:// or https://.',
    );
  });

  it('refuses a string that is not a URL at all', () => {
    expect(referenceLinkError({ label: 'Association', url: 'example.org' })).toBe(
      'That is not a valid URL. Include https://.',
    );
  });

  it('requires a label, and bounds it', () => {
    expect(referenceLinkError({ label: '   ', url: 'https://example.org' })).toBe(
      'A link needs a label.',
    );
    expect(referenceLinkError({ label: 'x'.repeat(81), url: 'https://example.org' })).toContain(
      'at most',
    );
  });
});

describe('allReferenceLinks', () => {
  it('returns an empty array — not null — when there is nothing to say', () => {
    expect(allReferenceLinks({})).toEqual([]);
    expect(allReferenceLinks(null)).toEqual([]);
    expect(allReferenceLinks(undefined)).toEqual([]);
  });

  it('builds the derived links, then the operator-entered ones', () => {
    const links = allReferenceLinks(
      {
        name: 'Lake Willoughby',
        states: ['VT'],
        interiorPoint: { lat: 44.7419, lng: -72.0537 },
        referenceLinks: [{ label: 'Westmore Association', url: 'https://example.org/westmore' }],
      },
      NOW,
    );
    // Copernicus rides along on a fixture with no stored area — `satelliteImageryAvailable` fails
    // open, on the grounds that withholding a free link over a missing field is the wrong direction.
    expect(links.map((l) => l.id)).toEqual(['windy', 'copernicus', 'community', 'stored:0']);
    expect(links[3]?.label).toBe('Westmore Association');
  });

  it('keeps a stored link that duplicates a derived one, because a human meant it', () => {
    const links = allReferenceLinks({
      states: ['VT'],
      interiorPoint: CHAMPLAIN_INTERIOR,
      referenceLinks: [{ label: 'Windy', url: 'https://www.windy.com/?44.0,-73.0,7' }],
    });
    expect(links.filter((l) => l.url.includes('windy.com'))).toHaveLength(2);
  });

  it('omits the Windy link entirely when a body has no coordinate', () => {
    const links = allReferenceLinks({ name: 'Somewhere', states: ['VT'] });
    expect(links.map((l) => l.id)).toEqual(['community']);
  });

  /**
   * The guard that held the Copernicus link out until the reveal shipped (D138) is retired here —
   * N6e is the phase that owns both, so the link is now expected rather than forbidden.
   */
  it('emits the Copernicus link beside Windy, for a body big enough to resolve', () => {
    const links = allReferenceLinks(
      {
        name: 'Lake Champlain',
        states: ['VT'],
        interiorPoint: CHAMPLAIN_INTERIOR,
        surfaceAreaSqM: 1.1e9,
      },
      NOW,
    );
    expect(links.map((l) => l.id)).toContain('copernicus');
    // Directly after Windy: the two are the same kind of thing, and they read as a pair.
    expect(links.findIndex((l) => l.id === 'copernicus')).toBe(
      links.findIndex((l) => l.id === 'windy') + 1,
    );
  });

  it('withholds it from a pond a 10 m pixel cannot resolve', () => {
    const links = allReferenceLinks(
      {
        name: 'Tiny Pond',
        states: ['VT'],
        interiorPoint: CHAMPLAIN_INTERIOR,
        surfaceAreaSqM: 8_000,
      },
      NOW,
    );
    expect(links.map((l) => l.id)).not.toContain('copernicus');
  });
});

describe('satelliteImageryAvailable', () => {
  it("takes an operator's word over the threshold, in both directions", () => {
    expect(satelliteImageryAvailable({ surfaceAreaSqM: 100, satelliteImagery: 'on' })).toBe(true);
    expect(satelliteImageryAvailable({ surfaceAreaSqM: 1e9, satelliteImagery: 'off' })).toBe(false);
  });

  it('resolves `auto` against the area', () => {
    expect(satelliteImageryAvailable({ surfaceAreaSqM: SATELLITE_MIN_AREA_SQM })).toBe(true);
    expect(satelliteImageryAvailable({ surfaceAreaSqM: SATELLITE_MIN_AREA_SQM - 1 })).toBe(false);
  });

  it('offers the link when the area is unknown — the wrong direction to fail is withholding', () => {
    expect(satelliteImageryAvailable({ name: 'Unmeasured' })).toBe(true);
  });

  it("is far above the corpus's own admission floor, so it genuinely filters", () => {
    // 1 acre = 4,046.86 m2 is what the corpus admits; this tier needs a great deal more.
    expect(SATELLITE_MIN_AREA_SQM).toBeGreaterThan(20 * 4046.8564224);
  });
});

describe('copernicusUrl', () => {
  const coord = { lat: 44.5, lng: -73.2 };

  it('opens a window rather than a date — cloud, not revisit, is the limiter', () => {
    const url = new URL(copernicusUrl(coord, NOW));
    const from = url.searchParams.get('fromTime') ?? '';
    const to = url.searchParams.get('toTime') ?? '';
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(16);
  });

  it('frames the lake, unlike Windy which frames the region', () => {
    expect(Number(new URL(copernicusUrl(coord, NOW)).searchParams.get('zoom'))).toBeGreaterThan(
      WINDY_ZOOM,
    );
  });

  it('asks for Sentinel-2 L2A true color', () => {
    const url = new URL(copernicusUrl(coord, NOW));
    expect(url.searchParams.get('datasetId')).toBe('S2_L2A_CDAS');
    expect(url.searchParams.get('layerId')).toBe('1_TRUE_COLOR');
    expect(url.origin).toBe('https://browser.dataspace.copernicus.eu');
  });

  it('centres on the coordinate it was given', () => {
    const url = new URL(copernicusUrl(coord, NOW));
    expect(url.searchParams.get('lat')).toBe('44.5000');
    expect(url.searchParams.get('lng')).toBe('-73.2000');
  });
});
