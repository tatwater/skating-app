import { describe, expect, it } from 'vitest';
import { PRECISION_FLOORS, tierFor } from './floors';

describe('tierFor (§1.4)', () => {
  it('is a ghost with no floor, and extracted at or above one', () => {
    expect(tierFor('thickness', 1, { setOn: 'x', basis: 'provisional', fields: {} })).toBe('ghost');
    const floors = { setOn: 'x', basis: 'verified' as const, fields: { iceTypes: 0.8 } };
    expect(tierFor('iceTypes', 0.8, floors)).toBe('extracted');
    expect(tierFor('iceTypes', 0.79, floors)).toBe('ghost');
    expect(tierFor('thickness', 0.99, floors)).toBe('ghost');
  });
  it('the shipped table is provisional until the verification pass lands', () => {
    expect(PRECISION_FLOORS.basis).toBe('provisional');
    expect(tierFor('suitability', 1)).toBe(
      PRECISION_FLOORS.fields.suitability === undefined ? 'ghost' : 'extracted',
    );
  });
});
