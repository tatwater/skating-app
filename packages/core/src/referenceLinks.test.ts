import { describe, expect, it } from 'vitest';
import {
  allReferenceLinks,
  communityFor,
  communityUrl,
  linkCoordinate,
  referenceLinkError,
  WINDY_ZOOM,
  windyUrl,
} from './referenceLinks';

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
    const links = allReferenceLinks({
      name: 'Lake Willoughby',
      states: ['VT'],
      interiorPoint: { lat: 44.7419, lng: -72.0537 },
      referenceLinks: [{ label: 'Westmore Association', url: 'https://example.org/westmore' }],
    });
    expect(links.map((l) => l.id)).toEqual(['windy', 'community', 'stored:0']);
    expect(links[2]?.label).toBe('Westmore Association');
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

  /** N6e owns the Copernicus deep link now; nothing here should quietly reintroduce it. */
  it('emits no satellite imagery link — that moved to N6e', () => {
    const links = allReferenceLinks({
      name: 'Lake Champlain',
      states: ['VT'],
      interiorPoint: CHAMPLAIN_INTERIOR,
    });
    expect(links.some((l) => l.url.includes('copernicus'))).toBe(false);
  });
});
