import { describe, expect, it } from 'vitest';
import { claimMatches, ledgerHash, UNPUBLISHED_HASH } from './hashLedger';

it('reads a published version’s hash, and nothing for one not yet added', () => {
  const ledger = { '2026-11-24': 'a'.repeat(64) };
  expect(ledgerHash(ledger, '2026-11-24')).toBe('a'.repeat(64));
  expect(ledgerHash(ledger, '2027-06-01')).toBe(UNPUBLISHED_HASH);
  expect(ledgerHash(ledger, 'toString')).toBe(UNPUBLISHED_HASH);
  expect(UNPUBLISHED_HASH).not.toMatch(/^[0-9a-f]{64}$/);
});

describe('claimMatches', () => {
  const published = { version: '2026-11-24', hash: 'a'.repeat(64) };

  it('matches only the exact version and hash', () => {
    expect(claimMatches(published, published)).toBe(true);
    expect(claimMatches(published, { ...published, version: '2026-11-23' })).toBe(false);
    expect(claimMatches(published, { ...published, hash: 'b'.repeat(64) })).toBe(false);
  });

  it('refuses a build whose version is missing from its ledger, though both sides agree', () => {
    // Mid-edit: the version bumped, its line not added. The client and the server each compute
    // the sentinel, so equality alone would record an acceptance of words nobody published.
    const ledger = { '2026-11-24': 'a'.repeat(64) };
    const unpublished = { version: '2027-06-01', hash: ledgerHash(ledger, '2027-06-01') };
    expect(unpublished.hash).toBe(UNPUBLISHED_HASH);
    expect(claimMatches(unpublished, unpublished)).toBe(false);
    expect(claimMatches(unpublished, { version: '2027-06-01', hash: UNPUBLISHED_HASH })).toBe(
      false,
    );
  });
});
