import { describe, expect, it } from 'vitest';
import { hasMapDrawer, isMapRoute, parseMapSelection } from './mapSelection';

describe('parseMapSelection', () => {
  it('parses a water-body path', () => {
    expect(parseMapSelection('/water/abc123')).toEqual({ kind: 'water', waterBodyId: 'abc123' });
  });

  it('parses a report path', () => {
    expect(parseMapSelection('/report/rep_9')).toEqual({ kind: 'report', reportId: 'rep_9' });
  });

  it('tolerates a trailing slash', () => {
    expect(parseMapSelection('/water/abc123/')).toEqual({ kind: 'water', waterBodyId: 'abc123' });
  });

  it('decodes an encoded id segment', () => {
    expect(parseMapSelection('/water/a%2Fb')).toEqual({ kind: 'water', waterBodyId: 'a/b' });
  });

  it('returns none for the map root and unrelated routes', () => {
    expect(parseMapSelection('/')).toEqual({ kind: 'none' });
    expect(parseMapSelection('/feed')).toEqual({ kind: 'none' });
    expect(parseMapSelection('/water')).toEqual({ kind: 'none' });
    expect(parseMapSelection('/water/a/b')).toEqual({ kind: 'none' });
  });
});

describe('isMapRoute', () => {
  it('covers the map and every drawer over it', () => {
    expect(isMapRoute('/')).toBe(true);
    expect(isMapRoute('/water/abc123')).toBe(true);
    expect(isMapRoute('/report/rep_9')).toBe(true);
    expect(isMapRoute('/hazard/hz_1')).toBe(true);
    expect(isMapRoute('/water/abc123/')).toBe(true);
  });

  it('includes the bounty drawer, which is not a map *selection*', () => {
    // The chrome rule and the highlight rule differ here on purpose — see the doc comment.
    expect(isMapRoute('/bounty/b_1')).toBe(true);
    expect(parseMapSelection('/bounty/b_1')).toEqual({ kind: 'none' });
  });

  it('excludes the sibling routes that carry no map', () => {
    expect(isMapRoute('/feed')).toBe(false);
    expect(isMapRoute('/settings')).toBe(false);
    expect(isMapRoute('/admin')).toBe(false);
    expect(isMapRoute('/u/anna')).toBe(false);
    expect(isMapRoute('/water')).toBe(false);
    expect(isMapRoute('/water/a/b')).toBe(false);
  });
});

describe('hasMapDrawer', () => {
  it('is false on the bare map and true under any drawer', () => {
    expect(hasMapDrawer('/')).toBe(false);
    expect(hasMapDrawer('/water/abc123')).toBe(true);
    expect(hasMapDrawer('/bounty/b_1')).toBe(true);
    expect(hasMapDrawer('/hazard/hz_1/')).toBe(true);
  });

  it('is false off the map entirely', () => {
    expect(hasMapDrawer('/feed')).toBe(false);
  });
});
