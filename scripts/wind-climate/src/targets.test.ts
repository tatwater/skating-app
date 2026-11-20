import { WIND_ARCHIVE_MIN_FETCH_M } from '@skating/core';
import { describe, expect, it, vi } from 'vitest';
import { collectWindTargets } from './targets';
import { gridKey } from './wtk';

describe('collectWindTargets', () => {
  it('groups qualifying bodies across pages without losing per-body counts', () => {
    const first = { waterBodyId: 'first', lat: 44, lng: -73 };
    const sameCell = { ...first, waterBodyId: 'second' };
    const otherCell = { waterBodyId: 'third', lat: 45, lng: -72 };
    const readPage = vi
      .fn()
      .mockReturnValueOnce({
        targets: [first],
        scanned: 3,
        belowFloor: 2,
        cursor: 'next',
        isDone: false,
      })
      .mockReturnValueOnce({
        targets: [sameCell, otherCell],
        scanned: 2,
        cursor: 'done',
        isDone: true,
      });

    const result = collectWindTargets(true, readPage);
    const scope = { refresh: true, minFetchM: WIND_ARCHIVE_MIN_FETCH_M, importFloorOnly: true };
    expect(readPage.mock.calls).toEqual([
      ['waterBodies:listNeedingWindRose', scope],
      ['waterBodies:listNeedingWindRose', { ...scope, cursor: 'next' }],
    ]);
    expect(result).toEqual({
      cells: new Map([
        [gridKey(first), [first, sameCell]],
        [gridKey(otherCell), [otherCell]],
      ]),
      scanned: 5,
      belowFloor: 2,
      bodies: 3,
    });
  });

  it('leaves the import-floor filter absent unless requested', () => {
    const readPage = vi.fn().mockReturnValue({
      targets: [],
      scanned: 0,
      cursor: 'done',
      isDone: true,
    });

    expect(collectWindTargets(false, readPage)).toEqual({
      cells: new Map(),
      scanned: 0,
      belowFloor: 0,
      bodies: 0,
    });
    expect(readPage.mock.calls).toEqual([
      ['waterBodies:listNeedingWindRose', { refresh: true, minFetchM: WIND_ARCHIVE_MIN_FETCH_M }],
    ]);
  });
});
