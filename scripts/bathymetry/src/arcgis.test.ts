import { describe, expect, it } from 'vitest';
import {
  countUrl,
  descriptorUrl,
  normalizeLayerUrl,
  pageCount,
  pageFilename,
  pageUrl,
  parseCount,
  parsePage,
  preferredFormat,
} from './arcgis';

const LAYER = 'https://example.gov/arcgis/rest/services/Bathy/FeatureServer/0';

describe('normalizeLayerUrl', () => {
  it('strips trailing slashes and any query string', () => {
    expect(normalizeLayerUrl(`${LAYER}/`)).toBe(LAYER);
    expect(normalizeLayerUrl(`${LAYER}?f=json`)).toBe(LAYER);
    expect(normalizeLayerUrl(`${LAYER}///`)).toBe(LAYER);
  });
});

describe('descriptorUrl / countUrl', () => {
  it('builds the descriptor URL from an already-suffixed input without doubling it', () => {
    expect(descriptorUrl(`${LAYER}?f=json`)).toBe(`${LAYER}?f=json`);
  });

  it('asks for a count, not rows', () => {
    const url = countUrl(LAYER);
    expect(url).toContain('/query?');
    expect(url).toContain('returnCountOnly=true');
    expect(url).not.toContain('outFields');
  });
});

describe('pageUrl', () => {
  const url = pageUrl(LAYER, {
    offset: 2000,
    pageSize: 1000,
    orderByFields: 'fid',
    format: 'geojson',
  });

  it('carries offset, page size and a stable ordering', () => {
    expect(url).toContain('resultOffset=2000');
    expect(url).toContain('resultRecordCount=1000');
    expect(url).toContain('orderByFields=fid');
  });

  it('always requests WGS84, even for geojson', () => {
    // MassGIS and Maine publish in State Plane; an implicitly-reprojected GeoJSON is a silent
    // several-hundred-kilometre offset, so `outSR` is not left to the service's discretion.
    expect(url).toContain('outSR=4326');
  });

  it('requests every attribute — the transform decides what it needs, not the fetch', () => {
    expect(url).toContain('outFields=*');
  });
});

describe('preferredFormat', () => {
  it('prefers geojson when advertised', () => {
    expect(preferredFormat('JSON,geoJSON,PBF')).toBe('geojson');
  });

  it('falls back to Esri json for older services rather than failing', () => {
    expect(preferredFormat('JSON,AMF')).toBe('json');
    expect(preferredFormat(undefined)).toBe('json');
  });
});

describe('pageCount', () => {
  it('rounds up a partial final page', () => {
    expect(pageCount(9285, 2000)).toBe(5);
    expect(pageCount(4000, 2000)).toBe(2);
  });

  it('returns no pages for an empty layer', () => {
    // An empty layer should archive as empty. "Always fetch one page" would store a page of nothing
    // that a later run cannot tell apart from real data.
    expect(pageCount(0, 2000)).toBe(0);
  });

  it('refuses a non-positive page size instead of looping forever', () => {
    expect(() => pageCount(10, 0)).toThrow(/positive/);
  });
});

describe('pageFilename', () => {
  it('zero-pads so a directory listing sorts into fetch order', () => {
    expect(pageFilename(0)).toBe('page-00000.json.gz');
    expect(pageFilename(42)).toBe('page-00042.json.gz');
    expect([pageFilename(9), pageFilename(10)].sort()).toEqual([
      'page-00009.json.gz',
      'page-00010.json.gz',
    ]);
  });
});

describe('parsePage', () => {
  it('counts features from a GeoJSON page', () => {
    const body = JSON.stringify({ type: 'FeatureCollection', features: [{}, {}, {}] });
    expect(parsePage(body)).toEqual({ count: 3, exceededTransferLimit: false });
  });

  it('reads exceededTransferLimit at the top level (Esri JSON) and under properties (GeoJSON)', () => {
    expect(
      parsePage(JSON.stringify({ features: [{}], exceededTransferLimit: true }))
        .exceededTransferLimit,
    ).toBe(true);
    expect(
      parsePage(JSON.stringify({ features: [{}], properties: { exceededTransferLimit: true } }))
        .exceededTransferLimit,
    ).toBe(true);
  });

  it('detects an ArcGIS error object served with HTTP 200', () => {
    // The failure this exists for: a bad `orderByFields` returns 200 with an error body, and without
    // this branch the fetcher writes a directory of valid-looking gzipped errors and reports success.
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'Unable to complete operation.',
        details: ['Invalid field: fid'],
      },
    });
    const parsed = parsePage(body);
    expect(parsed.error).toContain('Unable to complete operation.');
    expect(parsed.error).toContain('Invalid field: fid');
    expect(parsed.count).toBe(0);
  });

  it('reports a missing features array as an error rather than an empty page', () => {
    expect(parsePage(JSON.stringify({ count: 5 })).error).toMatch(/no `features` array/);
  });

  it('reports non-JSON (an HTML error page, a redirect body) as an error', () => {
    expect(parsePage('<html>502 Bad Gateway</html>').error).toMatch(/not JSON/);
  });
});

describe('parseCount', () => {
  it('reads the count', () => {
    expect(parseCount(JSON.stringify({ count: 9285 }))).toBe(9285);
  });

  it('throws on an error body instead of reporting zero rows', () => {
    expect(() => parseCount(JSON.stringify({ error: { message: 'Token required' } }))).toThrow(
      /Token required/,
    );
  });

  it('throws when the count is missing rather than defaulting to zero', () => {
    expect(() => parseCount(JSON.stringify({}))).toThrow(/no numeric/);
  });
});
