import { describe, expect, it } from 'vitest';
import { identityArgs } from './runAs';

describe('identityArgs — a script write made as a person, and through what (D256)', () => {
  it('a bare call carries no identity', () => {
    expect(identityArgs(undefined)).toEqual([]);
  });

  it('a call as a person carries their subject and the script it is made through', () => {
    const args = identityArgs({ as: 'user_123', via: 'seed-destinations' });
    expect(args[0]).toBe('--identity');
    expect(JSON.parse(args[1] ?? '')).toEqual({ subject: 'user_123', via: 'seed-destinations' });
  });

  it('refuses a name the audit row would not record, before any write', () => {
    for (const via of ['', 'Seed Destinations', 'seed_destinations', 'x'.repeat(41)]) {
      expect(() => identityArgs({ as: 'user_123', via })).toThrow(/lowercase words/);
    }
  });

  it('refuses a call as nobody', () => {
    expect(() => identityArgs({ as: '  ', via: 'seed-destinations' })).toThrow(/Clerk user id/);
  });
});
