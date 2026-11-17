import { townLabel } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { townWithState } from './bodyModel';
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

describe('a town with its state', () => {
  it('is the one label rule, from core — no second copy on the web (B01-3p)', () => {
    expect(townWithState).toBe(townLabel);
    expect(townWithState({ name: 'Franklin', state: 'NH' })).toBe('Franklin, NH');
    expect(townWithState({ name: 'Franklin', state: null })).toBe('Franklin');
  });
});
