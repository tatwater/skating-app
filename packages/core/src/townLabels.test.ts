import { describe, expect, it } from 'vitest';
import { townKindOf, townLabel, townName } from './townLabels';

describe('town labels (B01-3l)', () => {
  it('the kind is TIGER’s full name past the name — read, never guessed', () => {
    expect(townKindOf('Plattsburgh', 'Plattsburgh city')).toBe('city');
    expect(townKindOf('Plattsburgh', 'Plattsburgh town')).toBe('town');
    expect(townKindOf('Newport', 'Newport  city ')).toBe('city');
    expect(townKindOf('Plattsburgh', undefined)).toBeUndefined();
    expect(townKindOf('Plattsburgh', 'Plattsburgh')).toBeUndefined();
    // A full name that doesn't extend the name says nothing about the kind.
    expect(townKindOf('Plattsburgh', 'City of Plattsburgh')).toBeUndefined();
  });

  it('a kind shows only when carried; every other town reads as before', () => {
    expect(townName({ name: 'Plattsburgh', kind: 'city' })).toBe('Plattsburgh (city)');
    expect(townLabel({ name: 'Plattsburgh', state: 'NY', kind: 'town' })).toBe(
      'Plattsburgh (town), NY',
    );
    expect(townLabel({ name: 'Burlington', state: 'VT' })).toBe('Burlington, VT');
    expect(townLabel({ name: 'Burlington', state: null })).toBe('Burlington');
  });
});
