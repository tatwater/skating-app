import { describe, expect, it } from 'vitest';
import {
  buildNhdManifest,
  NHD_FROZEN_AT,
  NHD_SOURCES,
  nhdArchiveKey,
  nhdMetadataUrl,
  nhdRunTableRow,
  nhdZipUrl,
  normalizeGnisId,
  normalizeNhdId,
  toIsoDate,
} from './nhdArchive';

const VT = NHD_SOURCES.find((s) => s.state === 'VT');
if (!VT) throw new Error('VT missing from NHD_SOURCES');

describe('the source registry', () => {
  it('covers exactly the five states the corpus covers', () => {
    expect(NHD_SOURCES.map((s) => s.state).sort()).toEqual(['MA', 'ME', 'NH', 'NY', 'VT']);
  });

  it('is ordered smallest-first, so a first run fails cheap', () => {
    const bytes = NHD_SOURCES.map((s) => s.expectedBytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
  });

  it('builds the staged-products URLs USGS actually serves', () => {
    expect(nhdZipUrl(VT)).toBe(
      'https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/State/GDB/NHD_H_Vermont_State_GDB.zip',
    );
    expect(nhdMetadataUrl(VT)).toBe(
      'https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/State/GDB/NHD_H_Vermont_State_GDB.xml',
    );
  });

  it('keys the archive the way the OSM lane does', () => {
    expect(nhdArchiveKey(VT)).toBe('vt');
  });
});

describe('normalizeNhdId', () => {
  // Beau Lake — the phase's headline fixture, as NHD actually returns it.
  const BEAU = '{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}';
  const bare = '85383a01-dc89-47aa-bc5d-be373fb0b5c3';

  it('strips the braces and lower-cases, so one lake has one key', () => {
    expect(normalizeNhdId(BEAU)).toBe(bare);
  });

  it('agrees across every spelling the access paths hand back', () => {
    for (const spelling of [BEAU, BEAU.toLowerCase(), bare, bare.toUpperCase(), ` ${BEAU} `]) {
      expect(normalizeNhdId(spelling)).toBe(bare);
    }
  });

  // The formats that a single-example rule missed. 76.4% of Maine's post-floor GNIS-keyed
  // waterbodies carry a plain numeric id, not a GUID — the strict version dropped all of them.
  it('accepts the LEGACY NUMERIC ids, which are the majority', () => {
    expect(normalizeNhdId('141034078')).toBe('141034078'); // Dead Pond
    expect(normalizeNhdId('118181968')).toBe('118181968'); // Sessions Pond
  });

  it('does not strip leading zeros off a numeric id', () => {
    // Unlike gnis_id there is no evidence NHD pads these, and trimming a zero that turned out to be
    // significant would silently merge two lakes.
    expect(normalizeNhdId('0141034078')).toBe('0141034078');
  });

  it('takes a GUID with or without braces, since access paths disagree', () => {
    // ogr2ogr returns it bare from the same column the REST service brace-wraps.
    expect(normalizeNhdId('601F3C2E-2C78-4691-8AEC-8735A10D22B5')).toBe(
      '601f3c2e-2c78-4691-8aec-8735a10d22b5',
    );
  });

  it('refuses what is neither shape, rather than passing it through', () => {
    // The point of the refusal: a join key that accepts anything matches nothing, silently.
    for (const junk of [
      '',
      '   ',
      'way/150404999',
      '{not-a-guid}',
      '85383a01-nope',
      null,
      undefined,
    ]) {
      expect(normalizeNhdId(junk)).toBeUndefined();
    }
  });
});

describe('normalizeGnisId', () => {
  it('reconciles NHD zero-padded strings with 3DHP bare integers', () => {
    // Joined raw over Maine this matched 0 of 3,031 ids. Normalised, it matches 3,007.
    expect(normalizeGnisId('00869848')).toBe('869848'); // NHD, Sessions Pond
    expect(normalizeGnisId(869_848)).toBe('869848'); // 3DHP, same lake
    expect(normalizeGnisId('0561883')).toBe(normalizeGnisId(561_883)); // Beau Lake
  });

  it('accepts OSM gnis:feature_id, the third spelling', () => {
    expect(normalizeGnisId('561883')).toBe('561883');
  });

  it('refuses anything non-numeric, and refuses all-zeros', () => {
    for (const junk of ['', '  ', 'abc', '12a', '0', '000', null, undefined]) {
      expect(normalizeGnisId(junk)).toBeUndefined();
    }
  });
});

describe('toIsoDate', () => {
  it('reduces an HTTP date to a UTC day', () => {
    expect(toIsoDate('Wed, 27 Dec 2023 00:48:48 GMT')).toBe('2023-12-27');
  });

  it('degrades to undefined rather than to a confident mismatch', () => {
    expect(toIsoDate('sometime last winter')).toBeUndefined();
  });
});

describe('buildNhdManifest', () => {
  const base = {
    source: VT,
    fetchedAt: '2026-08-03T18:00:00.000Z',
    filename: 'NHD_H_Vermont_State_GDB.zip',
    sha256: 'a'.repeat(64),
  };

  it('verifies the byte count, which is the only integrity check USGS leaves us', () => {
    const ok = buildNhdManifest({ ...base, bytes: VT.expectedBytes });
    expect(ok.bytesVerified).toBe(true);
    expect(ok.expectedBytes).toBe(VT.expectedBytes);
  });

  it('catches a short read — the failure that otherwise looks like a coverage gap', () => {
    const short = buildNhdManifest({ ...base, bytes: VT.expectedBytes - 1 });
    expect(short.bytesVerified).toBe(false);
    expect(nhdRunTableRow(short)).toContain('SHORT');
  });

  it('confirms the dataset is still frozen where we left it', () => {
    const m = buildNhdManifest({
      ...base,
      bytes: VT.expectedBytes,
      lastModified: 'Wed, 27 Dec 2023 00:48:48 GMT',
    });
    expect(m.frozenAsExpected).toBe(true);
    expect(NHD_FROZEN_AT).toBe('2023-12-27');
  });

  it('flags a retired dataset that moved under us', () => {
    const m = buildNhdManifest({
      ...base,
      bytes: VT.expectedBytes,
      lastModified: 'Mon, 01 Jun 2026 00:00:00 GMT',
    });
    expect(m.frozenAsExpected).toBe(false);
    expect(nhdRunTableRow(m)).toContain('MOVED');
  });

  it('leaves frozenAsExpected absent when no Last-Modified came back', () => {
    // "We didn't check" and "it checked out" are different claims. Same rule as `md5Verified`.
    const m = buildNhdManifest({ ...base, bytes: VT.expectedBytes });
    expect(m.frozenAsExpected).toBeUndefined();
    expect(nhdRunTableRow(m)).toContain('unverified');
  });

  it('records the licence on every row, since nothing else in the repo states it', () => {
    const m = buildNhdManifest({ ...base, bytes: VT.expectedBytes });
    expect(m.licence).toMatch(/Public domain/);
    expect(m.attribution).toMatch(/U\.S\. Geological Survey/);
  });

  it('carries the FGDC metadata when it came down, and omits it when it did not', () => {
    const withMeta = buildNhdManifest({
      ...base,
      bytes: VT.expectedBytes,
      metadataFilename: 'NHD_H_Vermont_State_GDB.xml',
      metadataSha256: 'b'.repeat(64),
    });
    expect(withMeta.metadataFilename).toBe('NHD_H_Vermont_State_GDB.xml');
    expect(buildNhdManifest({ ...base, bytes: VT.expectedBytes }).metadataFilename).toBeUndefined();
  });
});
