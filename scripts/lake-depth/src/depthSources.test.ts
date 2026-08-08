import { describe, expect, it } from 'vitest';
import {
  checksumState,
  DEPTH_SOURCES,
  type DepthManifest,
  isRunnable,
  shortLicence,
  totalBytes,
} from './depthSources';

/**
 * The registry and the manifest rules (N6a). Two things here are load-bearing rather than tidy:
 * `unverified` and `mismatch` must never collapse into one another, and an archive with no recorded
 * licence must refuse to be run from — because LAGOS-US' rights statement has been an open question
 * since this phase was scoped, and a clean import would close it by forgetting it.
 */

function manifest(over: Partial<DepthManifest> = {}): DepthManifest {
  return {
    key: 'hydrolakes',
    label: 'HydroLAKES',
    publisher: 'HydroSHEDS',
    fetchedAt: '2026-08-02T19:00:00.000Z',
    source: { url: 'https://example.test/x.zip', kind: 'direct' },
    files: [{ name: 'x.zip', bytes: 100, sha256: 'abc' }],
    licence: 'CC-BY 4.0',
    ...over,
  };
}

describe('DEPTH_SOURCES', () => {
  it('names all three datasets the D68 ladder needs', () => {
    expect(DEPTH_SOURCES.map((s) => s.key)).toEqual(['hydrolakes', 'globathy', 'lagos-us-depth']);
  });

  it('marks LAGOS-US as manual, because a script genuinely cannot fetch it', () => {
    // Behind an EDI portal login + Cloudflare Turnstile; PASTA refuses the package publicly.
    // Checked 2026-08-02. If this ever flips, the fetch kind is where it flips.
    const lagos = DEPTH_SOURCES.find((s) => s.key === 'lagos-us-depth');
    expect(lagos?.fetch.kind).toBe('manual');
  });

  it('records every licence, including the one that was an open question until 2026-08-02', () => {
    expect(DEPTH_SOURCES.find((s) => s.key === 'hydrolakes')?.expectedLicence).toMatch(/CC-BY/);
    expect(DEPTH_SOURCES.find((s) => s.key === 'globathy')?.expectedLicence).toMatch(/CC0/);
    // Read off the EDI package page. It is CC BY, so it carries an attribution obligation — the
    // reason this mattered was never the field, it was what the answer would require of the app.
    expect(DEPTH_SOURCES.find((s) => s.key === 'lagos-us-depth')?.expectedLicence).toMatch(/CC BY/);
  });

  it('still makes --adopt pass a licence explicitly, even now that we know it', () => {
    // Knowing today's answer must not stop tomorrow's download from checking: the statement itself
    // says versions change and it is the Data User's job to notice.
    expect(isRunnable(manifest({ licence: undefined })).ok).toBe(false);
  });

  it('covers both mean and max between the three', () => {
    const provides = new Set(DEPTH_SOURCES.flatMap((s) => s.provides));
    expect(provides).toEqual(new Set(['mean', 'max']));
  });
});

describe('checksumState', () => {
  it('distinguishes a passed check from there being nothing to check', () => {
    expect(checksumState(manifest({ publishedMd5: 'abc', md5Verified: true }))).toBe('verified');
    expect(checksumState(manifest({ publishedMd5: undefined }))).toBe('unverified');
  });

  it('calls a failed comparison a mismatch, not merely unverified', () => {
    // These collapse into one `md5Verified: false` and mean opposite things. Conflating them is how
    // a corrupted 763 MB download gets imported.
    expect(checksumState(manifest({ publishedMd5: 'abc', md5Verified: false }))).toBe('mismatch');
  });
});

describe('totalBytes', () => {
  it('sums every archived file', () => {
    expect(
      totalBytes(
        manifest({
          files: [
            { name: 'a', bytes: 10, sha256: 'x' },
            { name: 'b', bytes: 5, sha256: 'y' },
          ],
        }),
      ),
    ).toBe(15);
  });
});

describe('isRunnable', () => {
  it('accepts a complete, checksummed, licensed archive', () => {
    expect(isRunnable(manifest({ publishedMd5: 'abc', md5Verified: true }))).toEqual({ ok: true });
  });

  it('refuses an archive with no licence recorded', () => {
    const verdict = isRunnable(manifest({ licence: undefined }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/licence/i);
  });

  it('treats whitespace as no licence — an empty confirmation is not a confirmation', () => {
    expect(isRunnable(manifest({ licence: '   ' })).ok).toBe(false);
  });

  it('refuses a checksum mismatch outright', () => {
    const verdict = isRunnable(manifest({ publishedMd5: 'abc', md5Verified: false }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/mismatch/);
  });

  it('allows an unverified archive when the publisher offered no checksum', () => {
    // HydroLAKES publishes none. Refusing here would block a source for the publisher's choice.
    expect(isRunnable(manifest({ publishedMd5: undefined })).ok).toBe(true);
  });

  it('refuses an archive with no files', () => {
    expect(isRunnable(manifest({ files: [] })).ok).toBe(false);
  });
});

describe('shortLicence', () => {
  it('pulls the identifier out of a paragraph-long rights statement', () => {
    // LAGOS-US' statement is ~1,100 characters. Verbatim in a status line, it buries every other
    // source under it — while the manifest keeps the full text, which is what must be complete.
    const statement =
      'This information is released under the Creative Commons license - Attribution - CC BY ' +
      '(https://creativecommons.org/licenses/by/4.0/). The consumer of these data ("Data User" ' +
      'herein) is required to cite it appropriately in any publication that results from its use.';
    expect(shortLicence(statement)).toBe('CC BY');
  });

  it('recognises the identifiers our sources actually use', () => {
    expect(shortLicence('CC0 (https://creativecommons.org/publicdomain/zero/1.0/)')).toMatch(/CC0/);
    expect(shortLicence('CC-BY 4.0')).toMatch(/CC-BY/);
  });

  it('truncates rather than inventing a label it cannot verify', () => {
    const odd = 'Released under the Frobnicator Public Data Terms, revision nine, as amended 2019';
    expect(shortLicence(odd)).toHaveLength(58);
    expect(shortLicence(odd).endsWith('…')).toBe(true);
  });

  it('says UNRECORDED for an absent or blank licence', () => {
    expect(shortLicence(undefined)).toBe('UNRECORDED');
    expect(shortLicence('   ')).toBe('UNRECORDED');
  });
});
