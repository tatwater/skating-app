import { expect, it } from 'vitest';
import { ledgerHash, UNPUBLISHED_HASH } from './hashLedger';

it('reads a published version’s hash, and nothing for one not yet added', () => {
  const ledger = { '2026-11-24': 'a'.repeat(64) };
  expect(ledgerHash(ledger, '2026-11-24')).toBe('a'.repeat(64));
  expect(ledgerHash(ledger, '2027-06-01')).toBe(UNPUBLISHED_HASH);
  expect(ledgerHash(ledger, 'toString')).toBe(UNPUBLISHED_HASH);
  expect(UNPUBLISHED_HASH).not.toMatch(/^[0-9a-f]{64}$/);
});
