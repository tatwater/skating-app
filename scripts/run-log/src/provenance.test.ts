import { describe, expect, it } from 'vitest';
import { extractStage, parseBuildDate } from './provenance';

describe('parseBuildDate', () => {
  it('reads Geofabrik YYMMDD', () => {
    expect(parseBuildDate('260731')).toBe(Date.UTC(2026, 6, 31));
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of [undefined, '', '2026-07-31', '26073', '2607311', 'abcdef']) {
      expect(parseBuildDate(bad)).toBeUndefined();
    }
  });

  it('refuses an impossible date rather than rolling it over', () => {
    // Date.UTC(2026, 3, 31) is 1 May. A confident wrong date on the admin page is exactly the
    // failure this table exists to stop, so the round-trip check rejects it.
    expect(parseBuildDate('260431')).toBeUndefined();
    expect(parseBuildDate('261301')).toBeUndefined();
    expect(parseBuildDate('260700')).toBeUndefined();
  });
});

describe('extractStage', () => {
  const manifest = {
    state: 'VT',
    slug: 'vermont',
    fetchedAt: '2026-08-01T02:06:47.844Z',
    requestedUrl: 'https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf',
    resolvedUrl: 'https://download.geofabrik.de/north-america/us/vermont-260731.osm.pbf',
    filename: 'vermont-260731.osm.pbf',
    bytes: 45_679_023,
    sha256: '66f53cac',
    buildDate: '260731',
    publishedMd5: 'd9480acd',
    md5Verified: true,
  };

  it('carries the resolved URL, both checksums and the build date', () => {
    const stage = extractStage(manifest, '.raw/vt/vermont-260731.osm.pbf');
    expect(stage).toMatchObject({
      name: 'extract',
      output: '.raw/vt/vermont-260731.osm.pbf',
      sourceUrl: manifest.resolvedUrl,
      bytes: 45_679_023,
      sha256: '66f53cac',
      md5: 'd9480acd',
      checksumVerified: true,
      sourceAt: Date.UTC(2026, 6, 31),
    });
  });

  it('prefers the resolved URL over the requested one — the -latest URL redirects', () => {
    const stage = extractStage({ ...manifest, resolvedUrl: undefined });
    expect(stage.sourceUrl).toBe(manifest.requestedUrl);
  });

  it('survives a manifest with nothing in it', () => {
    const stage = extractStage({});
    expect(stage.name).toBe('extract');
    expect(stage.sourceAt).toBeUndefined();
    expect(stage.checksumVerified).toBeUndefined();
  });
});
