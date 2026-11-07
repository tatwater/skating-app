import { describe, expect, it } from 'vitest';
import { mint, openSheet } from '@/lib/sheetStore.fixtures';
import {
  closedSearch,
  doorKey,
  entryRecorded,
  leaveAsks,
  parseAbandonMarker,
  postRedirectSearch,
  reportSheetLinkState,
  settleAbandonMarker,
  sheetDoorOf,
  sheetOpenEntry,
  webDoorParams,
} from './sheetHostModel';

describe('sheetDoorOf', () => {
  it('reads the root params as a door', () => {
    expect(sheetDoorOf({})).toEqual({ kind: 'none' });
    expect(sheetDoorOf({ postBody: 'b1' })).toEqual({ kind: 'none' });
    expect(sheetDoorOf({ post: 'new' })).toEqual({ kind: 'new' });
    expect(sheetDoorOf({ post: 'new', postBody: 'b1' })).toEqual({
      kind: 'new',
      waterBodyId: 'b1',
    });
    expect(sheetDoorOf({ post: 'r9', postBody: 'b1' })).toEqual({ kind: 'edit', reportId: 'r9' });
  });

  it('keys each door, and maps it onto the old console params', () => {
    expect(doorKey({ kind: 'none' })).toBe('');
    expect(doorKey({ kind: 'new' })).toBe('new:');
    expect(doorKey({ kind: 'new', waterBodyId: 'b' })).toBe('new:b');
    expect(doorKey({ kind: 'edit', reportId: 'r' })).toBe('edit:r');
    expect(webDoorParams({ kind: 'none' })).toEqual({});
    expect(webDoorParams({ kind: 'new' })).toEqual({});
    expect(webDoorParams({ kind: 'new', waterBodyId: 'b' })).toEqual({ body: 'b' });
    expect(webDoorParams({ kind: 'edit', reportId: 'r' })).toEqual({ edit: 'r' });
  });
});

describe('postRedirectSearch', () => {
  it('sends the old console links to the sheet over Explore', () => {
    expect(postRedirectSearch({})).toEqual({ post: 'new' });
    expect(postRedirectSearch({ body: 'b1' })).toEqual({ post: 'new', postBody: 'b1' });
    expect(postRedirectSearch({ edit: 'r1', body: 'b1' })).toEqual({ post: 'r1' });
  });
});

describe('closedSearch', () => {
  it('drops only the sheet params', () => {
    expect(closedSearch({ post: 'new', postBody: 'b', tab: 'weather' })).toEqual({
      tab: 'weather',
    });
    expect(closedSearch({})).toEqual({});
  });
});

describe('navigation state', () => {
  it('marks an entry a door already recorded', () => {
    expect(entryRecorded(reportSheetLinkState())).toBe(true);
    expect(entryRecorded(undefined)).toBe(false);
    expect(entryRecorded(null)).toBe(false);
    expect(entryRecorded({ reportSheetEntryRecorded: 'yes' })).toBe(false);
  });
});

describe('sheetOpenEntry', () => {
  it('never double-counts a door that recorded itself', () => {
    expect(
      sheetOpenEntry({ door: { kind: 'edit', reportId: 'r' }, landed: true, recorded: true }),
    ).toBeNull();
    expect(sheetOpenEntry({ door: { kind: 'none' }, landed: true, recorded: false })).toBeNull();
  });

  it('counts an edit wherever it came from', () => {
    for (const landed of [true, false]) {
      expect(
        sheetOpenEntry({ door: { kind: 'edit', reportId: 'r' }, landed, recorded: false }),
      ).toBe('edit');
    }
  });

  it('leaves an in-app new sheet to its door, and attributes a landed one', () => {
    expect(sheetOpenEntry({ door: { kind: 'new' }, landed: false, recorded: false })).toBeNull();
    expect(
      sheetOpenEntry({ door: { kind: 'new', waterBodyId: 'b' }, landed: false, recorded: false }),
    ).toBeNull();
    expect(
      sheetOpenEntry({ door: { kind: 'new', waterBodyId: 'b' }, landed: true, recorded: false }),
    ).toBe('water_body');
    expect(sheetOpenEntry({ door: { kind: 'new' }, landed: true, recorded: false })).toBe(
      'deep_link',
    );
  });
});

describe('leaveAsks', () => {
  const sheet = openSheet();
  const dirty = { ...sheet, dirty: true };
  const edit = { ...dirty, mode: { kind: 'edit' as const, reportId: 'r' } };
  const sent = { id: sheet.draftId, status: 'creating' } as never;

  it('asks nothing with no sheet', () => {
    expect(leaveAsks({ how: 'discard', sheet: null, attempt: null, persistedAt: 1 })).toBe(false);
  });

  it('asks before a discard throws away anything', () => {
    expect(leaveAsks({ how: 'discard', sheet, attempt: null, persistedAt: 1 })).toBe(false);
    expect(leaveAsks({ how: 'discard', sheet: dirty, attempt: null, persistedAt: 1 })).toBe(true);
  });

  it('lets a close keep a stored draft, and asks when nothing would keep it', () => {
    expect(leaveAsks({ how: 'close', sheet, attempt: null, persistedAt: null })).toBe(false);
    expect(leaveAsks({ how: 'close', sheet: dirty, attempt: null, persistedAt: 5 })).toBe(false);
    expect(leaveAsks({ how: 'close', sheet: dirty, attempt: null, persistedAt: null })).toBe(true);
    expect(leaveAsks({ how: 'close', sheet: edit, attempt: null, persistedAt: 5 })).toBe(true);
  });

  it('asks before discarding a Post that went out', () => {
    expect(leaveAsks({ how: 'discard', sheet, attempt: sent, persistedAt: 1 })).toBe(true);
  });
});

describe('the abandonment marker', () => {
  it('parses only a marker', () => {
    expect(parseAbandonMarker(null)).toBeNull();
    expect(parseAbandonMarker('not json')).toBeNull();
    expect(parseAbandonMarker('null')).toBeNull();
    expect(parseAbandonMarker('{"draftId":1,"sectionsAnswered":2}')).toBeNull();
    expect(parseAbandonMarker('{"draftId":"d","sectionsAnswered":3}')).toEqual({
      draftId: 'd',
      sectionsAnswered: 3,
    });
  });

  it('counts an abandonment only when the draft did not come back', () => {
    const marker = { draftId: mint(), sectionsAnswered: 4 };
    expect(settleAbandonMarker(null, null)).toBeNull();
    expect(settleAbandonMarker(marker, marker.draftId)).toBeNull();
    expect(settleAbandonMarker(marker, null)).toEqual({ sectionsAnswered: 4 });
    expect(settleAbandonMarker(marker, 'another')).toEqual({ sectionsAnswered: 4 });
  });
});
