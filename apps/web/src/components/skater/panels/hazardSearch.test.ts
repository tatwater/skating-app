import { describe, expect, it } from 'vitest';

import { hazardSearchSchema } from './hazardSearch';

describe('hazardSearchSchema', () => {
  it('keeps the old ?action=confirm link working', () => {
    expect(hazardSearchSchema.parse({ action: 'confirm' })).toEqual({ action: 'confirm' });
  });

  it('degrades anything else to the plain card instead of an error', () => {
    expect(hazardSearchSchema.parse({})).toEqual({});
    expect(hazardSearchSchema.parse({ action: 'heal' })).toEqual({ action: undefined });
    expect(hazardSearchSchema.parse({ action: 3 })).toEqual({ action: undefined });
  });
});
