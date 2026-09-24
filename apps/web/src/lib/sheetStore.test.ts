import { openPostSheet, type PostDraft, type PostSheet, postSheetForEdit } from '@skating/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindSheetOwner,
  clearStoredSheet,
  forgetSheet,
  getSheetAttempt,
  readStoredSheet,
  resetSheetStoreForTests,
  setSheet,
  setSheetAttempt,
  updateSheet,
} from './sheetStore';

const NOW = Date.UTC(2026, 0, 10, 20);
const KEY = 'skating.reportSheet.v2';
let seq = 0;
const mint = () => `id-${++seq}`;

function fresh(): PostSheet {
  return openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
}

/** A failed attempt at `post`, in the state `flushPost` left it. */
function attemptAt(post: PostSheet, patch: Partial<PostDraft>): PostDraft {
  return {
    kind: 'post',
    id: post.draftId,
    idempotencyKey: post.idempotencyKey,
    status: 'pending',
    reports: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

beforeEach(() => {
  bindSheetOwner('user_a');
});

afterEach(() => {
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('the open sheet', () => {
  it('holds the sheet, advances it through a pure update, and closes', () => {
    const post = fresh();
    setSheet(post);
    updateSheet((p) => ({ ...p, title: 'Morey', dirty: true }));
    expect(readStoredSheet(NOW)?.sheet.title).toBe('Morey');
    setSheet(null);
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('an update that changes nothing does not rewrite storage', () => {
    setSheet(fresh());
    const before = window.localStorage.getItem(KEY);
    updateSheet((p) => p);
    expect(window.localStorage.getItem(KEY)).toBe(before);
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
      // The Post's pool (A10-7): the same blobs, the same fate.
      photos: [
        {
          id: 'p2',
          fullUri: 'p2:full',
          thumbUri: 'p2:thumb',
          placeOnMap: false,
          attachTo: { kind: 'put_in', id: 'launch-1' },
        },
      ],
    });
    const restored = readStoredSheet(NOW)?.sheet;
    expect(restored?.title).toBe('Half written');
    expect(restored?.reports[0]?.sheet.waterBodyId).toBe('wb1');
    // The `File` behind a picked photo died with the tab; restoring its record would draw a
    // thumbnail that cannot be uploaded — or, in the pool, refuse the Post for a photo nobody can
    // place, or send the flush after a blob that is gone.
    expect(restored?.reports[0]?.photos).toEqual([]);
    expect(restored?.photos).toBeUndefined();
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
    window.localStorage.setItem(KEY, '{"owner":"user_a","sheet":{"nope":1}}');
    expect(readStoredSheet(NOW)).toBeNull();
    window.localStorage.setItem(KEY, 'null');
    expect(readStoredSheet(NOW)).toBeNull();
    window.localStorage.setItem(KEY, 'not json');
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('clears on demand', () => {
    setSheet(fresh());
    clearStoredSheet();
    expect(readStoredSheet(NOW)).toBeNull();
  });

  it('restores the attempt with its sheet, and never an attempt at another sheet', () => {
    const post = fresh();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'pending' }));
    expect(readStoredSheet(NOW)?.attempt?.id).toBe(post.draftId);
    // A record whose attempt names a different draft is a torn write; the sheet stands alone.
    const raw = JSON.parse(window.localStorage.getItem(KEY) as string);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...raw, attempt: { ...raw.attempt, id: 'x' } }),
    );
    expect(readStoredSheet(NOW)?.attempt).toBeNull();
  });
});

/**
 * PR #77 review: one browser-wide record, cleared by nothing at sign-out, let the next account on a
 * shared browser open `/post` and publish the last one's words under its own name.
 */
describe('a sheet belongs to the account that wrote it', () => {
  it('restores only to its owner — never to another account, nor to no one', () => {
    setSheet({ ...fresh(), title: 'Mine' });
    bindSheetOwner('user_b');
    expect(readStoredSheet(NOW)).toBeNull();
    bindSheetOwner(null);
    expect(readStoredSheet(NOW)).toBeNull();
    // A lapsed session keeps it for its author to come back to.
    bindSheetOwner('user_a');
    expect(readStoredSheet(NOW)?.sheet.title).toBe('Mine');
  });

  it('a change of account drops the open sheet and its attempt, without touching storage', () => {
    const post = fresh();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'pending' }));
    bindSheetOwner('user_b');
    // Nothing open: an update has nothing to advance, and nothing is written under the new owner.
    updateSheet((p) => ({ ...p, title: 'Not yours' }));
    expect(getSheetAttempt()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) as string).owner).toBe('user_a');
  });

  it('writes nothing down with no one signed in', () => {
    bindSheetOwner(null);
    setSheet(fresh());
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('the explicit sign-out forgets it everywhere', () => {
    setSheet(fresh());
    forgetSheet();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(getSheetAttempt()).toBeNull();
    updateSheet((p) => ({ ...p, title: 'Nothing open' }));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('removes the ownerless record the first build wrote, which no one may restore', () => {
    resetSheetStoreForTests();
    window.localStorage.setItem('skating.reportSheet.v1', JSON.stringify(fresh()));
    bindSheetOwner('user_a');
    expect(window.localStorage.getItem('skating.reportSheet.v1')).toBeNull();
    expect(readStoredSheet(NOW)).toBeNull();
  });
});

/**
 * PR #77 review: after a create that went out, a retry under the same key is answered with the Post
 * the server already has — so a change made in between was shown and then silently dropped.
 */
describe('a sent Post takes no change', () => {
  it('refuses an update once the create has gone out, answered or not', () => {
    for (const patch of [
      { status: 'creating' as const },
      { status: 'pending' as const, postId: 'post-1' },
    ]) {
      const post = fresh();
      setSheet({ ...post, title: 'As sent' });
      setSheetAttempt(attemptAt(post, patch));
      updateSheet((p) => ({ ...p, title: 'Changed after', dirty: true }));
      expect(readStoredSheet(NOW)?.sheet.title).toBe('As sent');
    }
  });

  it('still takes a change after an attempt that failed before its create', () => {
    const post = fresh();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'pending' }));
    updateSheet((p) => ({ ...p, title: 'Fixed', dirty: true }));
    expect(readStoredSheet(NOW)?.sheet.title).toBe('Fixed');
  });

  it('the lock survives a reload, because the attempt is stored with the sheet', () => {
    const post = fresh();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'creating' }));
    const stored = readStoredSheet(NOW);
    resetSheetStoreForTests();
    bindSheetOwner('user_a');
    setSheet(stored?.sheet ?? null, stored?.attempt ?? null);
    updateSheet((p) => ({ ...p, title: 'After the reload', dirty: true }));
    expect(readStoredSheet(NOW)?.sheet.title).toBe('');
    expect(getSheetAttempt()?.status).toBe('creating');
  });

  it('an attempt needs an open sheet, and closing the sheet clears it', () => {
    setSheetAttempt(attemptAt(fresh(), { status: 'creating' }));
    expect(getSheetAttempt()).toBeNull();
    const post = fresh();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'creating' }));
    setSheet(null);
    expect(getSheetAttempt()).toBeNull();
  });
});
