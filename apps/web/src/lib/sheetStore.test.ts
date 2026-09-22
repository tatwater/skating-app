import { openPostSheet, type PostSheet, postSheetForEdit } from '@skating/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStoredSheet,
  readStoredSheet,
  resetSheetStoreForTests,
  setSheet,
  updateSheet,
} from './sheetStore';

const NOW = Date.UTC(2026, 0, 10, 20);
let seq = 0;
const mint = () => `id-${++seq}`;

function fresh(): PostSheet {
  return openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
}

afterEach(() => {
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('the open sheet', () => {
  it('holds the sheet, advances it through a pure update, and closes', () => {
    const post = fresh();
    setSheet(post);
    updateSheet((p) => ({ ...p, title: 'Morey', dirty: true }));
    expect(readStoredSheet(NOW)?.title).toBe('Morey');
    setSheet(null);
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('an update that changes nothing does not rewrite storage', () => {
    setSheet(fresh());
    const before = window.localStorage.getItem('skating.reportSheet.v1');
    updateSheet((p) => p);
    expect(window.localStorage.getItem('skating.reportSheet.v1')).toBe(before);
  });
});

describe('the refresh (§10.3)', () => {
  it('restores the words and the chips, and drops the photos it cannot restore', () => {
    const post = fresh();
    const first = post.reports[0] as NonNullable<(typeof post.reports)[0]>;
    setSheet({
      ...post,
      title: 'Half written',
      reports: [
        {
          ...first,
          photos: [{ id: 'p1', fullUri: 'p1:full', thumbUri: 'p1:thumb', placeOnMap: false }],
        },
      ],
    });
    const restored = readStoredSheet(NOW);
    expect(restored?.title).toBe('Half written');
    expect(restored?.reports[0]?.sheet.waterBodyId).toBe('wb1');
    // The `File` behind a picked photo died with the tab; restoring its record would draw a
    // thumbnail that cannot be uploaded.
    expect(restored?.reports[0]?.photos).toEqual([]);
  });

  /**
   * The published Report is the durable copy of an edit. A stale draft of it, restored days later
   * over a save someone has since made, would undo that save without a word.
   */
  it('never stores an edit', () => {
    setSheet(
      postSheetForEdit(
        { reportId: 'rep-1', waterBodyId: 'wb1', skateEndTime: NOW, photoIds: [] },
        null,
        NOW,
        mint,
      ),
    );
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('forgets a sheet older than the window it could post in', () => {
    setSheet(fresh());
    expect(readStoredSheet(NOW + 6 * 24 * 3600_000)).not.toBeNull();
    expect(readStoredSheet(NOW + 8 * 24 * 3600_000)).toBeNull();
  });

  it('ignores a stored value that is not a sheet', () => {
    window.localStorage.setItem('skating.reportSheet.v1', '{"nope":1}');
    expect(readStoredSheet(NOW)).toBeNull();
    window.localStorage.setItem('skating.reportSheet.v1', 'not json');
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('clears on demand', () => {
    setSheet(fresh());
    clearStoredSheet();
    expect(readStoredSheet(NOW)).toBeNull();
  });
});
