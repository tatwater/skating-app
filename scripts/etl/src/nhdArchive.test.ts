import { describe, expect, it } from 'vitest';
import {
  buildNhdManifest,
  GNIS_ID_CENSUS,
  GNIS_SENTINELS,
  NHD_FROZEN_AT,
  NHD_ID_CENSUS,
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
  // Beau Lake — the phase's headline fixture, as the REST service actually returns it.
  const BEAU = '{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}';
  const bare = '85383a01-dc89-47aa-bc5d-be373fb0b5c3';
  const val = (raw: string | null | undefined) => {
    const r = normalizeNhdId(raw);
    return r.ok ? r.value : undefined;
  };
  const why = (raw: string | null | undefined) => {
    const r = normalizeNhdId(raw);
    return r.ok ? 'accepted' : r.reason;
  };

  it('strips the braces and lower-cases, so one lake has one key', () => {
    expect(val(BEAU)).toBe(bare);
  });

  it('agrees across every spelling the access paths hand back', () => {
    for (const spelling of [BEAU, BEAU.toLowerCase(), bare, bare.toUpperCase(), ` ${BEAU} `]) {
      expect(val(spelling)).toBe(bare);
    }
  });

  // The format a single-example rule missed. 84.4% of the five-state post-floor corpus is numeric.
  it('accepts the LEGACY NUMERIC ids, which are four fifths of the corpus', () => {
    expect(val('141034078')).toBe('141034078'); // Dead Pond
    expect(val('118181968')).toBe('118181968'); // Sessions Pond
    // The claim this pins is the one that matters: **a GUID-only rule would drop most of the
    // archive**, silently, which is what the first version of `normalizeNhdId` did.
    //
    // The ratio itself moved with the floor — 84.4/15.6 at five acres, 79.5/20.5 at one — because
    // the band between them is disproportionately GUID-keyed. That is a fact about NHD's own
    // re-keying history rather than about this rule, and it is why the assertion is a margin and
    // not a percentage.
    expect(NHD_ID_CENSUS.numeric).toBeGreaterThan(NHD_ID_CENSUS.guid * 3);
    expect(NHD_ID_CENSUS.numeric + NHD_ID_CENSUS.guid).toBe(NHD_ID_CENSUS.postFloorRows);
  });

  it('does not strip leading zeros off a numeric id', () => {
    // Unlike gnis_id there is no evidence NHD pads these, and trimming a zero that turned out to be
    // significant would silently merge two lakes.
    expect(val('0141034078')).toBe('0141034078');
  });

  it('takes a GUID with or without braces, since access paths disagree', () => {
    expect(val('601F3C2E-2C78-4691-8AEC-8735A10D22B5')).toBe(
      '601f3c2e-2c78-4691-8aec-8735a10d22b5',
    );
  });

  it('says WHY it refused, so a ledger can count it', () => {
    // The whole point of the rewrite: `undefined` cannot be tallied by reason, and a rejection
    // nobody tallies is the silent drop this phase kept meeting.
    expect(why(null)).toBe('absent');
    expect(why('')).toBe('absent');
    expect(why('   ')).toBe('absent');
    expect(why('way/150404999')).toBe('malformed');
    expect(why('{not-a-guid}')).toBe('malformed');
    expect(why('141034078')).toBe('accepted');
  });

  it('census matches the archives it was derived from', () => {
    expect(NHD_ID_CENSUS.numeric + NHD_ID_CENSUS.guid).toBe(NHD_ID_CENSUS.postFloorRows);
    // Nothing fell outside the two accepted shapes — the rule covers 100% of the archive.
    expect(NHD_ID_CENSUS.empty + NHD_ID_CENSUS.other).toBe(0);
  });
});

describe('normalizeGnisId', () => {
  const val = (raw: string | number | null | undefined) => {
    const r = normalizeGnisId(raw);
    return r.ok ? r.value : undefined;
  };
  const why = (raw: string | number | null | undefined) => {
    const r = normalizeGnisId(raw);
    return r.ok ? 'accepted' : r.reason;
  };

  it('reconciles NHD zero-padded strings with 3DHP bare integers', () => {
    // Joined raw over Maine this matched 0 of 3,031 ids. Normalised, it matches 3,007.
    expect(val('00869848')).toBe('869848'); // NHD, Sessions Pond
    expect(val(869_848)).toBe('869848'); // 3DHP, same lake
    expect(val('0561883')).toBe(val(561_883)); // Beau Lake
  });

  it('accepts OSM gnis:feature_id, the third spelling', () => {
    expect(val('561883')).toBe('561883');
  });

  it("refuses NHD's -1 as a SENTINEL, never as an id", () => {
    // 1,032 post-floor rows carry it — cross-border Québec lakes with no US GNIS entry. Treating it
    // as an id would collapse 855 unrelated lakes onto one body. Before this it was rejected only
    // as a side effect of the minus sign failing a digits test: right answer, reached by accident.
    expect(why('-1')).toBe('sentinel');
    expect(GNIS_SENTINELS.has('-1')).toBe(true);
    expect(why('0')).toBe('sentinel');
    expect(why('000')).toBe('sentinel'); // all-zeros at any width
  });

  it('keeps sentinel, absent and malformed as three separate facts', () => {
    // They mean different things: absent is normal (71.7% of rows), sentinel is healthy data, and
    // only malformed suggests the parser is wrong. One bucket would hide that.
    expect(why(null)).toBe('absent');
    expect(why('')).toBe('absent');
    expect(why('abc')).toBe('malformed');
    expect(why('12a')).toBe('malformed');
    expect(why('869848')).toBe('accepted');
  });

  it('census accounts for every post-floor row', () => {
    const c = GNIS_ID_CENSUS;
    expect(c.absent + c.zeroPadded + c.bareDigits + c.sentinel).toBe(c.postFloorRows);
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
