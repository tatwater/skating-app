import { describe, expect, it } from 'vitest';
import {
  chipKeys,
  iceTypeKeys,
  SNOW_DUSTING_CM,
  snowIsEmpty,
  surfaceTagKeys,
  toLocatedChip,
} from './reportFields';

describe('chip accessors', () => {
  it('read keys from either shape, keeping order and duplicates', () => {
    expect(
      iceTypeKeys(['black_ice', { type: 'shell_ice', where: { sector: 'N' } }, 'black_ice']),
    ).toEqual(['black_ice', 'shell_ice', 'black_ice']);
    expect(surfaceTagKeys([{ type: 'glass' }])).toEqual(['glass']);
    expect(chipKeys(undefined)).toEqual([]);
    expect(chipKeys([])).toEqual([]);
  });

  it('lifts a bare key to the located shape and passes an object through', () => {
    expect(toLocatedChip('glass')).toEqual({ type: 'glass' });
    const located = { type: 'glass', note: 'n' };
    expect(toLocatedChip(located)).toBe(located);
  });
});

describe('snow', () => {
  it('knows an empty object from one that says something', () => {
    expect(snowIsEmpty({})).toBe(true);
    expect(snowIsEmpty({ coverage: 'none' })).toBe(false);
    expect(snowIsEmpty({ impediment: 'slowed_me' })).toBe(false);
    expect(snowIsEmpty({ drifts: 'everywhere' })).toBe(false);
    expect(snowIsEmpty({ depthCm: 0 })).toBe(false);
    expect(snowIsEmpty({ plowedPath: false })).toBe(false);
  });

  it('a dusting is under a centimeter', () => {
    expect(SNOW_DUSTING_CM).toBeLessThan(1);
    expect(SNOW_DUSTING_CM).toBeGreaterThan(0);
  });
});
