import { describe, expect, it } from 'vitest';

import { isKnownStateCode, KNOWN_STATE_CODES } from './regions';

describe('isKnownStateCode', () => {
  it('accepts every code in the pilot region', () => {
    for (const code of KNOWN_STATE_CODES) expect(isKnownStateCode(code)).toBe(true);
  });

  it('rejects typos, expansions, and wrong case', () => {
    for (const bad of ['VE', 'VERMONT', 'vt', 'XX', '', 'NY ']) {
      expect(isKnownStateCode(bad)).toBe(false);
    }
  });

  it('covers exactly the five Northeast pilot states', () => {
    expect([...KNOWN_STATE_CODES].sort()).toEqual(['MA', 'ME', 'NH', 'NY', 'VT']);
  });
});
