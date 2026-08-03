import { describe, expect, it } from 'vitest';
import { NHD_SOURCES } from './nhdArchive';
import {
  buildThreeDhpClipManifest,
  buildThreeDhpSourceManifest,
  CURRENT_3DHP_RELEASE,
  clipCommand,
  isElevationDerived,
  NORTHEAST_CLIP,
  summarizeEdhCoverage,
  THREE_DHP_RELEASES,
  THREE_DHP_SOURCE_LAYER,
  THREE_DHP_WATERBODY_LAYER,
} from './threeDhpArchive';

describe('the release registry', () => {
  it('is ordered newest-first, so CURRENT is the head', () => {
    expect(CURRENT_3DHP_RELEASE).toBe(THREE_DHP_RELEASES[0]);
    const years = THREE_DHP_RELEASES.map((r) => Number(r.fiscalYear.replace('FY', '')));
    expect(years).toEqual([...years].sort((a, b) => b - a));
  });

  it('keeps prior releases rather than replacing them — annual refresh needs a predecessor', () => {
    // The point of the yearly cadence is being able to say what changed. That needs last year's
    // entry to still exist, not to have been edited over.
    expect(THREE_DHP_RELEASES.length).toBeGreaterThan(1);
    expect(THREE_DHP_RELEASES.map((r) => r.fiscalYear)).toContain('FY25');
  });

  it('points at the staged-products tree USGS actually serves', () => {
    for (const release of THREE_DHP_RELEASES) {
      expect(release.url).toMatch(
        /^https:\/\/prd-tnm\.s3\.amazonaws\.com\/StagedProducts\/Hydrography\/3DHP\/Annual\/GDB\//,
      );
      expect(release.url.endsWith(release.filename)).toBe(true);
    }
  });
});

describe('NORTHEAST_CLIP', () => {
  const [minLng, minLat, maxLng, maxLat] = NORTHEAST_CLIP;

  it('is a well-formed envelope', () => {
    expect(minLng).toBeLessThan(maxLng);
    expect(minLat).toBeLessThan(maxLat);
  });

  it('reaches north of Beau Lake, the lake this phase exists for', () => {
    // Beau Lake straddles the Maine/Québec border at ~47.4°N. Clipping below it at acquisition
    // would be unrecoverable without re-downloading 11.9 GB.
    expect(maxLat).toBeGreaterThan(47.4);
  });

  it('is wider than the OSM lane clips, on purpose', () => {
    // `archive.ts` clips New York at 41.3°N to keep the downstate metro out of the *corpus*. This is
    // an *acquisition* boundary: the floor and the classifier narrow later, where redoing is cheap.
    expect(minLat).toBeLessThan(41.3);
  });

  it('covers every state the corpus covers', () => {
    expect(NHD_SOURCES.map((s) => s.state).sort()).toEqual(['MA', 'ME', 'NH', 'NY', 'VT']);
    expect(maxLng).toBeGreaterThan(-67.0); // Maine's eastern coast
    expect(minLng).toBeLessThan(-79.7); // New York's western edge
  });
});

describe('clipCommand', () => {
  const { args: cmd, bin, line } = clipCommand('/tmp/3dhp.zip', '/tmp/out.gpkg');

  it('reads the zip in place rather than unpacking 12 GB', () => {
    expect(bin).toBe('ogr2ogr');
    expect(cmd).toContain('/vsizip//tmp/3dhp.zip');
    expect(line.startsWith('ogr2ogr ')).toBe(true);
  });

  it('reads the geodatabase-internal layer name, and renames it on the way out', () => {
    // The staged product prefixes every feature class; the REST service does not. This constant
    // said 'waterbody' until the first real download proved otherwise.
    expect(THREE_DHP_SOURCE_LAYER).toBe('hydro_3dhp_all_waterbody');
    expect(cmd).toContain(THREE_DHP_SOURCE_LAYER);
    expect(cmd[cmd.indexOf('-nln') + 1]).toBe(THREE_DHP_WATERBODY_LAYER);
  });

  it('declares the -spat SRS, because the source is Albers metres', () => {
    // Without -spat_srs, ogr2ogr reads the envelope in the SOURCE srs: a degrees box becomes metres
    // from the Albers origin, selects ocean, and the clip "succeeds" with zero features.
    expect(cmd[cmd.indexOf('-spat_srs') + 1]).toBe('EPSG:4326');
  });

  it('reprojects and flattens explicitly, never by assumption', () => {
    // Both NHD and 3DHP ship compound 3D CRSs. Assuming WGS84 2D is a silent 1-2 m error plus a Z
    // coordinate nothing downstream expects.
    expect(cmd).toContain('-t_srs');
    expect(cmd).toContain('EPSG:4326');
    expect(cmd).toContain('-dim');
    expect(cmd).toContain('XY');
  });

  it('passes the clip envelope through verbatim', () => {
    const at = cmd.indexOf('-spat');
    expect(at).toBeGreaterThan(-1);
    expect(cmd.slice(at + 1, at + 5).map(Number)).toEqual([
      NORTHEAST_CLIP[0],
      NORTHEAST_CLIP[1],
      NORTHEAST_CLIP[2],
      NORTHEAST_CLIP[3],
    ]);
  });
});

describe('buildThreeDhpSourceManifest', () => {
  const base = {
    release: CURRENT_3DHP_RELEASE,
    fetchedAt: '2026-08-03T18:00:00.000Z',
    sha256: 'c'.repeat(64),
  };

  it('verifies the byte count', () => {
    expect(
      buildThreeDhpSourceManifest({ ...base, bytes: CURRENT_3DHP_RELEASE.expectedBytes })
        .bytesVerified,
    ).toBe(true);
    expect(buildThreeDhpSourceManifest({ ...base, bytes: 1 }).bytesVerified).toBe(false);
  });

  it('says in the manifest that the payload is not kept', () => {
    // A manifest found without its bytes should explain itself rather than read as a broken archive.
    const m = buildThreeDhpSourceManifest({
      ...base,
      bytes: CURRENT_3DHP_RELEASE.expectedBytes,
    });
    expect(m.retention).toMatch(/NOT mirrored/);
    expect(m.retention).toMatch(/sha256/);
  });
});

describe('buildThreeDhpClipManifest', () => {
  it('ties the clip back to the exact source bytes and the exact command', () => {
    // This pair is what stands in for byte-faithfulness on the one source that cannot have it.
    const command = clipCommand('/tmp/3dhp.zip', '/tmp/out.gpkg').line;
    const m = buildThreeDhpClipManifest({
      release: CURRENT_3DHP_RELEASE,
      derivedAt: '2026-08-03T19:00:00.000Z',
      sourceSha256: 'c'.repeat(64),
      filename: 'out.gpkg',
      bytes: 300_000_000,
      sha256: 'd'.repeat(64),
      features: 325_404,
      command,
    });
    expect(m.sourceSha256).toBe('c'.repeat(64));
    expect(m.sourceUrl).toBe(CURRENT_3DHP_RELEASE.url);
    expect(m.command).toContain('-spat');
    expect(m.clipBBox).toEqual(NORTHEAST_CLIP);
    expect(m.features).toBe(325_404);
  });
});

describe('isElevationDerived', () => {
  it('reads the first-party provenance label rather than inferring from geometry', () => {
    // `workunitid` is USGS's own claim. The alternative we nearly built — diffing 3DHP areas against
    // NHD's and calling a divergence a new survey — needed both archives and could not tell a
    // re-trace from a typo fix.
    expect(isElevationDerived('NHD')).toBe(false);
    expect(isElevationDerived('300285')).toBe(true); // western Massachusetts, live as of 2026-08-03
    expect(isElevationDerived('19050401')).toBe(true);
  });

  it('does NOT count unknown provenance as elevation-derived', () => {
    // A coverage number that exists to be trusted when it finally moves must not be inflated by
    // blanks.
    for (const blank of ['', '   ', null, undefined]) {
      expect(isElevationDerived(blank)).toBe(false);
    }
  });
});

describe('summarizeEdhCoverage', () => {
  it('reproduces the FY26 five-state measurement: zero, of a lot', () => {
    const coverage = summarizeEdhCoverage(Array.from({ length: 1000 }, () => 'NHD'));
    expect(coverage.total).toBe(1000);
    expect(coverage.elevationDerived).toBe(0);
    expect(coverage.nhdFallback).toBe(1000);
    expect(coverage.share).toBe(0);
    expect(coverage.workUnits).toEqual({});
  });

  it('attributes a step up to its work unit, so a jump has a place name behind it', () => {
    const coverage = summarizeEdhCoverage(['NHD', 'NHD', '300285', '300285', '300286']);
    expect(coverage.elevationDerived).toBe(3);
    expect(coverage.nhdFallback).toBe(2);
    expect(coverage.workUnits).toEqual({ '300285': 2, '300286': 1 });
    expect(coverage.share).toBeCloseTo(0.6);
  });

  it('keeps unknown provenance out of BOTH sides rather than picking one', () => {
    const coverage = summarizeEdhCoverage(['NHD', '', null, '300285']);
    expect(coverage.total).toBe(4);
    expect(coverage.elevationDerived).toBe(1);
    expect(coverage.nhdFallback).toBe(1);
    expect(coverage.unknownProvenance).toBe(2);
    // The three still account for the whole.
    expect(coverage.elevationDerived + coverage.nhdFallback + coverage.unknownProvenance).toBe(
      coverage.total,
    );
  });

  it('is a rate, not a percent, and survives an empty catalogue', () => {
    const empty = summarizeEdhCoverage([]);
    expect(empty.share).toBe(0); // never NaN on an axis
    expect(empty.total).toBe(0);
  });
});
