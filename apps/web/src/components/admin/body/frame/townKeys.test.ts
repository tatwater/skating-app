import { describe, expect, it } from 'vitest';
import { keyedTowns } from './townKeys';

describe('keyedTowns', () => {
  it('two towns reading the same get two keys; every other key is its name', () => {
    expect(keyedTowns(['Plattsburgh', 'Peru', 'Plattsburgh'])).toEqual([
      { name: 'Plattsburgh', key: 'Plattsburgh#0' },
      { name: 'Peru', key: 'Peru#0' },
      { name: 'Plattsburgh', key: 'Plattsburgh#1' },
    ]);
  });
});
