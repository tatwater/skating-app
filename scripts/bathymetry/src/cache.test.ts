/**
 * `decodeRawPage` — is a page on disk usable, or does it only look like one?
 *
 * `cache.ts` is file/network glue and stays out of the coverage numbers, but this one function is the
 * decision the resume path turns on, and it is decidable without a filesystem. The bug it exists for:
 * an interrupted `snapshot` left a truncated `page-NNN.json.gz`, `hasRawPage` reported it present,
 * and `gunzipSync` threw — aborting not just that run but every later one, permanently, until someone
 * deleted the file by hand. A one-page problem became an unresumable archive.
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeRawPage } from './cache';

const PAGE = JSON.stringify({ features: [{ properties: { DEPTH_FT: 12 } }] });

describe('decodeRawPage', () => {
  it('round-trips a whole page', () => {
    expect(decodeRawPage(gzipSync(Buffer.from(PAGE, 'utf8')))).toBe(PAGE);
  });

  it('returns undefined for a page cut off mid-write', () => {
    // The actual failure: the process died between the first byte and the last. gzip's trailing CRC
    // is over the *uncompressed* data, so a truncated member cannot pass — which is what makes this
    // detectable at all without a manifest to compare against.
    const whole = gzipSync(Buffer.from(PAGE, 'utf8'));
    expect(decodeRawPage(whole.subarray(0, Math.floor(whole.length / 2)))).toBeUndefined();
    expect(decodeRawPage(whole.subarray(0, whole.length - 1))).toBeUndefined();
  });

  it('returns undefined for an empty file, which is what a zero-byte write leaves', () => {
    expect(decodeRawPage(Buffer.alloc(0))).toBeUndefined();
  });

  it('returns undefined for bytes that were never gzip', () => {
    // A portal that answers a page request with an HTML error page, written straight through.
    expect(decodeRawPage(Buffer.from('<html>500</html>', 'utf8'))).toBeUndefined();
  });

  it('returns undefined when the compressed body is corrupted but the header survives', () => {
    // Bit rot, or a partial `mirror-r2.sh pull`. The header still says gzip; the CRC disagrees.
    const corrupted = Buffer.from(gzipSync(Buffer.from(PAGE, 'utf8')));
    corrupted[corrupted.length - 5] = (corrupted[corrupted.length - 5] as number) ^ 0xff;
    expect(decodeRawPage(corrupted)).toBeUndefined();
  });

  it('never throws, for any input — the resume path depends on that', () => {
    // A throw here is the whole bug: it aborts every future run, not just this one.
    for (const bytes of [Buffer.alloc(0), Buffer.from([0x1f, 0x8b]), Buffer.from('nonsense')]) {
      expect(() => decodeRawPage(bytes)).not.toThrow();
    }
  });
});
