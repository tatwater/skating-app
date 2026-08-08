import { describe, expect, it } from 'vitest';
import {
  derivedFileStage,
  extractStage,
  gnisStage,
  nhdStage,
  parseBuildDate,
  parseHttpDate,
  stageName,
  threeDhpClipStage,
  threeDhpSourceStage,
} from './provenance';

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

describe('stageName', () => {
  it('joins a family and its key with the separator the admin page groups on', () => {
    expect(stageName('source', 'osm/vt')).toBe('source · osm/vt');
    expect(stageName('merge')).toBe('merge');
  });
});

describe('parseHttpDate', () => {
  it('reads a Last-Modified header', () => {
    expect(parseHttpDate('Wed, 27 Dec 2023 00:48:42 GMT')).toBe(Date.UTC(2023, 11, 27, 0, 48, 42));
  });

  it('turns an absent or unparseable header into no date, never NaN', () => {
    for (const bad of [undefined, '', 'not a date']) expect(parseHttpDate(bad)).toBeUndefined();
  });
});

describe('nhdStage', () => {
  const manifest = {
    state: 'VT',
    slug: 'Vermont',
    url: 'https://prd-tnm.s3.amazonaws.com/…/NHD_H_Vermont_State_GDB.zip',
    filename: 'NHD_H_Vermont_State_GDB.zip',
    bytes: 139_834_230,
    expectedBytes: 139_834_230,
    bytesVerified: true,
    sha256: 'd35026b1',
    lastModified: 'Wed, 27 Dec 2023 00:48:48 GMT',
    frozenAsExpected: true,
  };

  it('carries the byte verdict as the checksum claim, because USGS publishes no checksum', () => {
    const stage = nhdStage(manifest, 'source · nhd/VT');
    expect(stage).toMatchObject({
      name: 'source · nhd/VT',
      sourceUrl: manifest.url,
      sha256: 'd35026b1',
      checksumVerified: true,
      sourceAt: Date.UTC(2023, 11, 27, 0, 48, 48),
    });
    // No `md5` — inventing one would imply a verification USGS never offered.
    expect(stage.md5).toBeUndefined();
  });

  it('says so loudly when the frozen dataset has moved under us', () => {
    const stage = nhdStage({ ...manifest, frozenAsExpected: false }, 'source · nhd/VT');
    expect(stage.detail).toMatch(/RE-PUBLISHED/);
  });

  it('does not claim a freeze verdict it was never given', () => {
    const stage = nhdStage({ ...manifest, frozenAsExpected: undefined }, 'n');
    expect(stage.detail).toMatch(/freeze date not recorded/);
  });
});

describe('3DHP stages', () => {
  it('records the national download even though the bytes are not kept', () => {
    const stage = threeDhpSourceStage(
      {
        fiscalYear: 'FY26',
        url: 'https://…/3dhp.zip',
        bytes: 11_897_413_835,
        sha256: 'ab',
        bytesVerified: true,
      },
      'source · 3dhp/download',
    );
    expect(stage).toMatchObject({ bytes: 11_897_413_835, checksumVerified: true });
    expect(stage.detail).toMatch(/not mirrored/);
  });

  it('carries the exact clip command, so the derived file is reproducible', () => {
    const stage = threeDhpClipStage(
      { layer: 'waterbody', command: 'ogr2ogr -f GPKG …', sourceSha256: 'ab', features: 65_072 },
      'source · 3dhp/clip',
    );
    expect(stage.command).toMatch(/^ogr2ogr/);
    expect(stage.input).toBe('sha256:ab');
    expect(stage.counts).toEqual([{ name: 'features', value: 65_072 }]);
  });
});

describe('gnisStage', () => {
  it('carries the row counts — a gazetteer that shrinks has no other symptom', () => {
    const stage = gnisStage(
      {
        code: 'ME',
        url: 'https://…/DomesticNames_ME_Text.zip',
        bytes: 763_125,
        sha256: 'ea',
        rows: 20_188,
        waterRows: 5_103,
      },
      'source · gnis/ME',
    );
    expect(stage.counts).toEqual([
      { name: 'rows', value: 20_188 },
      { name: 'waterRows', value: 5_103 },
    ]);
    expect(stage.detail).toMatch(/version record/);
  });
});

describe('derivedFileStage', () => {
  it('leaves the checksum verdict absent rather than false — nothing upstream to check', () => {
    const stage = derivedFileStage({
      name: 'mask · five-state',
      path: '.scratch/boundaries.ndjson',
      bytes: 12,
      sha256: 'cd',
      producer: 'pnpm --filter @skating/admin-areas build-region',
    });
    expect(stage.checksumVerified).toBeUndefined();
    expect(stage.command).toMatch(/build-region/);
  });
});
