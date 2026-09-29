import { describe, expect, it } from 'vitest';
import {
  getLibraryGridRequest,
  getPicks,
  type LibraryGridRequest,
  openLibraryGridRequest,
  setPicks,
} from './libraryPicks';

describe('libraryPicks — which library photo became which draft, per Report', () => {
  it('starts empty, and keeps each Report its own', () => {
    expect(getPicks('r1')).toEqual({});
    setPicks('r1', { assetA: 'draftA' });
    setPicks('r2', { assetB: 'draftB' });
    expect(getPicks('r1')).toEqual({ assetA: 'draftA' });
    expect(getPicks('r2')).toEqual({ assetB: 'draftB' });
  });

  it('replaces a Report whole, so the grid can drop a pick it removed', () => {
    setPicks('r3', { a: '1', b: '2' });
    setPicks('r3', { b: '2' });
    expect(getPicks('r3')).toEqual({ b: '2' });
  });

  it('answers the same empty map each time, so a subscriber does not re-render on nothing', () => {
    expect(getPicks('never')).toBe(getPicks('never'));
  });
});

describe('the grid request', () => {
  it('holds the last request the Photos section made', () => {
    const request: LibraryGridRequest = {
      reportId: 'r1',
      timeZone: 'America/New_York',
      skate: null,
      skateWindow: null,
      dayWindow: { startMs: 0, endMs: 86_400_000 },
      others: [],
      track: [],
    };
    openLibraryGridRequest(request);
    expect(getLibraryGridRequest()).toBe(request);
  });
});
