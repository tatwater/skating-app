import { describe, expect, it } from 'vitest';
import {
  catalogQueryUrl,
  describeRequestOutcome,
  parseCatalogResponse,
  requestKindLabel,
  requestKindsFor,
  requestKindTitle,
} from './corpusRequests';

const square = (lat: number, lng: number, half: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng - half, lat - half],
      [lng + half, lat - half],
      [lng + half, lat + half],
      [lng - half, lat + half],
      [lng - half, lat - half],
    ],
  ],
});

const POINT = { lat: 44.5, lng: -72.5 };
const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('requestKindsFor — what a standing lets you ask', () => {
  it('nothing in the corpus ⇒ admit; active ⇒ takedown only', () => {
    expect(requestKindsFor(undefined)).toEqual(['admit']);
    expect(requestKindsFor({ standing: 'active' })).toEqual(['takedown']);
  });

  it('dormant ⇒ activate (or contest, under a ruling); removed ⇒ restore; unlisted ⇒ nothing', () => {
    expect(requestKindsFor({ standing: 'dormant', reason: 'inactive' })).toEqual([
      'activate',
      'takedown',
    ]);
    expect(requestKindsFor({ standing: 'dormant', reason: 'no_public_access' })).toEqual([
      'contest_access',
      'takedown',
    ]);
    expect(requestKindsFor({ standing: 'removed' })).toEqual(['restore']);
    expect(requestKindsFor({ standing: 'unlisted' })).toEqual([]);
  });

  it('every kind has a skater label and a moderator title', () => {
    for (const kind of ['activate', 'admit', 'restore', 'contest_access', 'takedown'] as const) {
      expect(requestKindLabel(kind).length).toBeGreaterThan(0);
      expect(requestKindTitle(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('describeRequestOutcome', () => {
  it('says nothing while open, and the decision note after', () => {
    expect(describeRequestOutcome({ kind: 'activate', status: 'open' })).toBeNull();
    expect(
      describeRequestOutcome({
        kind: 'activate',
        status: 'approved',
        decisionNote: 'Welcome back.',
      }),
    ).toBe('A moderator put this lake back on the active map. Welcome back.');
    expect(describeRequestOutcome({ kind: 'admit', status: 'approved' })).toBe(
      'A moderator added this water to the map.',
    );
    expect(describeRequestOutcome({ kind: 'takedown', status: 'approved' })).toBe(
      'A moderator took this lake off the map.',
    );
    expect(describeRequestOutcome({ kind: 'restore', status: 'declined' })).toBe(
      'A moderator reviewed your request and left things as they are.',
    );
  });
});

describe('the catalog point query', () => {
  it('asks the 3DHP waterbody layer for GeoJSON at the point, lng first', () => {
    const url = new URL(catalogQueryUrl(POINT));
    expect(url.pathname).toContain('/3DHP_all/MapServer/60/query');
    expect(url.searchParams.get('geometry')).toBe('-72.5,44.5');
    expect(url.searchParams.get('geometryType')).toBe('esriGeometryPoint');
    expect(url.searchParams.get('f')).toBe('geojson');
    expect(url.searchParams.get('outFields')).toContain('id3dhp');
  });
});

describe('parseCatalogResponse', () => {
  const lake = (id: string, half: number, extra: Record<string, unknown> = {}) => ({
    type: 'Feature',
    geometry: square(POINT.lat, POINT.lng, half),
    properties: { id3dhp: id, gnisidlabel: 'Mirror Lake', featuretype: 3, areasqkm: 1, ...extra },
  });

  it('returns the smallest polygon containing the point, classified', () => {
    const res = parseCatalogResponse(
      { type: 'FeatureCollection', features: [lake('big', 0.1), lake('small', 0.01)] },
      POINT,
      NOW,
    );
    if (res.kind !== 'found') throw new Error(res.kind);
    expect(res.candidate.externalId).toBe('small');
    expect(res.candidate.cls).toBe('lakePond');
    expect(res.candidate.name).toBe('Mirror Lake');
    expect(res.candidate.source).toBe('3dhp');
    expect(res.candidate.surfaceAreaSqM).toBeGreaterThan(0);
    expect(res.candidate.bbox.minLat).toBeLessThan(POINT.lat);
    expect(res.candidate.fetchedAt).toBe(NOW);
  });

  it('ignores a feature that does not contain the point, and says none when nothing does', () => {
    const res = parseCatalogResponse(
      { type: 'FeatureCollection', features: [lake('far', 0.01)] },
      { lat: 40, lng: -70 },
      NOW,
    );
    expect(res).toEqual({ kind: 'none' });
    expect(parseCatalogResponse({ type: 'FeatureCollection', features: [] }, POINT, NOW)).toEqual({
      kind: 'none',
    });
  });

  it('keeps a refused class as a candidate with no cls, so the moderator sees why', () => {
    const res = parseCatalogResponse(
      { type: 'FeatureCollection', features: [lake('river', 0.01, { featuretype: 1 })] },
      POINT,
      NOW,
    );
    if (res.kind !== 'found') throw new Error(res.kind);
    expect(res.candidate.cls).toBeUndefined();
    expect(res.candidate.featureType).toBe(1);
  });

  it('surfaces a service error and a malformed body as errors, never as none', () => {
    expect(parseCatalogResponse({ error: { message: 'Invalid token' } }, POINT, NOW)).toEqual({
      kind: 'error',
      message: 'Invalid token',
    });
    expect(parseCatalogResponse('<html>', POINT, NOW)).toMatchObject({ kind: 'error' });
    expect(
      parseCatalogResponse(
        { features: [{ geometry: square(POINT.lat, POINT.lng, 0.01), properties: {} }] },
        POINT,
        NOW,
      ),
    ).toMatchObject({ kind: 'error', message: 'feature carries no id3dhp' });
  });

  it('a numeric id and gnisid are stringified; a blank name stays blank', () => {
    const res = parseCatalogResponse(
      {
        features: [lake('x', 0.01, { id3dhp: 12345, gnisid: 987, gnisidlabel: '  ' })],
      },
      POINT,
      NOW,
    );
    if (res.kind !== 'found') throw new Error(res.kind);
    expect(res.candidate.externalId).toBe('12345');
    expect(res.candidate.gnisId).toBe('987');
    expect(res.candidate.name).toBe('');
  });
});
