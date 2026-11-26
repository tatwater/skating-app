import { describe, expect, test } from 'vitest';
import { isNaipState, NAIP_STATES } from './naipSelection';

describe('the seven states', () => {
  test('are the supported five plus CT and RI', () => {
    expect([...NAIP_STATES].sort()).toEqual(['CT', 'MA', 'ME', 'NH', 'NY', 'RI', 'VT']);
  });

  test.each([
    ['CT', true],
    ['RI', true],
    ['NY', true],
    ['ny', false], // the catalog's lowercase labels are uppercased before they get here
    ['NJ', false],
    ['', false],
  ])('isNaipState(%j) is %s', (code, expected) => {
    expect(isNaipState(code)).toBe(expected);
  });
});
