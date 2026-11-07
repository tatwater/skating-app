import { type PostSheet, postSheetForEdit } from '@skating/core';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSheetPhotoDb } from './sheetPhotoDb';
import {
  setSheetPhotoDbForTests,
  sheetPhotoBlob,
  sheetPhotoPreview,
  whenSheetPhotosSettled,
} from './sheetPhotos';
import {
  bindSheetOwner,
  clearStoredSheet,
  dismissSheetPhotosLost,
  forgetSheet,
  readStoredSheet,
  resetSheetStoreForTests,
  restoreStoredSheet,
  setSheet,
  updateSheet,
  useSheetPhotosLost,
  useSheetPhotosNotKept,
  useSheetRestoring,
} from './sheetStore';
import {
  DAY_MS,
  installFakeStore,
  mint,
  openSheet,
  pickPhoto,
  reloadPage,
  stubObjectUrls,
} from './sheetStore.fixtures';

vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'));

const KEY = 'skating.reportSheet.v2';

let fake: ReturnType<typeof installFakeStore>;
let urls: Set<string>;

beforeEach(() => {
  urls = stubObjectUrls();
  fake = installFakeStore();
  bindSheetOwner('user_a');
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSheetStoreForTests();
  window.localStorage.clear();
});

/** A sheet with a Report photo and a pool photo stored, and the page reloaded on it. */
async function storedSheetWithPhotos(title = 'Half written') {
  const post = openSheet();
  setSheet({ ...post, title, dirty: true });
  const reportId = (post.reports[0] as PostSheet['reports'][number]).id;
  const onReport = await pickPhoto({ reportId });
  const inPool = await pickPhoto(
    { pool: true },
    { attachTo: { kind: 'put_in', id: 'launch-1' }, placeOnMap: true },
  );
  await whenSheetPhotosSettled();
  return { post, reportId, onReport, inPool };
}

describe('photos reach IndexedDB', () => {
  it('stores each picked photo under its draft and its owner', async () => {
    const { post, onReport, inPool } = await storedSheetWithPhotos();
    expect([...fake.rows.keys()].sort()).toEqual([onReport.id, inPool.id].sort());
    expect(fake.rows.get(onReport.id)).toMatchObject({ owner: 'user_a', draftId: post.draftId });
  });

  it('deletes a photo the author removes from the sheet', async () => {
    const { reportId, onReport, inPool } = await storedSheetWithPhotos();
    updateSheet((p) => ({
      ...p,
      reports: p.reports.map((r) => (r.id === reportId ? { ...r, photos: [] } : r)),
    }));
    await whenSheetPhotosSettled();
    expect(fake.rows.has(onReport.id)).toBe(false);
    expect(fake.rows.has(inPool.id)).toBe(true);
  });

  it('does not touch the store on a keystroke — only when the set of photos changes', async () => {
    await storedSheetWithPhotos();
    const opens = fake.opens();
    const keysSeen = vi.spyOn(fake.rows, 'keys');
    updateSheet((p) => ({ ...p, title: 'Typing' }));
    updateSheet((p) => ({ ...p, title: 'Typing on' }));
    await whenSheetPhotosSettled();
    expect(keysSeen).not.toHaveBeenCalled();
    expect(fake.opens()).toBe(opens);
  });

  it('stores nothing for an edit, which is never restored', async () => {
    setSheet(
      postSheetForEdit(
        { reportId: 'r', waterBodyId: 'wb1', skateEndTime: Date.now(), photoIds: [] },
        null,
        Date.now(),
        mint,
      ),
    );
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('stores nothing with no one signed in', async () => {
    bindSheetOwner(null);
    setSheet(openSheet());
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('the synchronous read still gives the words alone, as today’s route expects', async () => {
    await storedSheetWithPhotos();
    const stored = readStoredSheet(Date.now());
    expect(stored?.sheet.title).toBe('Half written');
    expect(stored?.sheet.reports[0]?.photos).toEqual([]);
    expect(stored?.sheet.photos).toBeUndefined();
  });
});

describe('the restore', () => {
  it('brings each photo back to where it sat, with its record and its blobs', async () => {
    const { post, reportId, onReport, inPool } = await storedSheetWithPhotos();
    reloadPage('user_a');
    expect(sheetPhotoPreview(onReport.id)).toBeNull();

    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(0);
    expect(restored?.sheet.draftId).toBe(post.draftId);
    expect(restored?.sheet.title).toBe('Half written');
    expect(restored?.sheet.reports.find((r) => r.id === reportId)?.photos).toEqual([onReport]);
    expect(restored?.sheet.photos).toEqual([inPool]);
    expect(onReport.coord).toEqual({ lat: 44.5, lng: -73.2 });

    expect(sheetPhotoPreview(onReport.id)).toMatch(/^blob:/);
    expect(sheetPhotoBlob(onReport.fullUri)?.size).toBeGreaterThan(0);
    expect(sheetPhotoBlob(inPool.thumbUri)?.name).toMatch(/^thumb-/);
  });

  it('keeps every stored blob once the restored sheet is open again', async () => {
    const { onReport, inPool } = await storedSheetWithPhotos();
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null);
    await whenSheetPhotosSettled();
    expect([...fake.rows.keys()].sort()).toEqual([onReport.id, inPool.id].sort());
    expect(sheetPhotoPreview(onReport.id)).not.toBeNull();
  });

  it('survives a second reload after a restore', async () => {
    const { onReport } = await storedSheetWithPhotos();
    reloadPage('user_a');
    const first = await restoreStoredSheet(Date.now());
    setSheet(first?.sheet ?? null);
    await whenSheetPhotosSettled();
    reloadPage('user_a');
    const second = await restoreStoredSheet(Date.now());
    expect(second?.photosLost).toBe(0);
    expect(second?.sheet.reports[0]?.photos).toEqual([onReport]);
  });

  it('renders a restoring state for as long as the read takes', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    let answer = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const real = createSheetPhotoDb(() => fake.factory);
    setSheetPhotoDbForTests({
      ...real,
      read: async (scope) => {
        await gate;
        return real.read(scope);
      },
    });
    const { result } = renderHook(() => useSheetRestoring());
    expect(result.current).toBe(false);
    const pending = restoreStoredSheet(Date.now());
    await waitFor(() => expect(result.current).toBe(true));
    answer();
    expect((await pending)?.photosLost).toBe(0);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('skips IndexedDB altogether for a sheet with no photos', async () => {
    setSheet({ ...openSheet(), title: 'Words only' });
    await whenSheetPhotosSettled();
    reloadPage('user_a');
    fake.faults.open = 'error';
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Words only');
    expect(restored?.photosLost).toBe(0);
  });

  it('restores a record stored before photos had a place in it', async () => {
    const post = openSheet();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ owner: 'user_a', sheet: { ...post, title: 'Old' }, attempt: null }),
    );
    expect((await restoreStoredSheet(Date.now()))?.sheet.title).toBe('Old');
  });

  it('shares one read between concurrent calls, so a remount is not answered “nothing”', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    const now = Date.now();
    const [one, two] = await Promise.all([restoreStoredSheet(now), restoreStoredSheet(now)]);
    expect(one).not.toBeNull();
    expect(two).toBe(one);
  });

  it('a door that turns the restore down leaves no preview behind, and no row', async () => {
    const { onReport, inPool } = await storedSheetWithPhotos();
    reloadPage('user_a');
    await restoreStoredSheet(Date.now());
    expect(urls.size).toBe(2);
    setSheet(openSheet());
    await whenSheetPhotosSettled();
    expect(sheetPhotoPreview(onReport.id)).toBeNull();
    expect(sheetPhotoPreview(inPool.id)).toBeNull();
    expect(urls.size).toBe(0);
    expect(fake.rows.size).toBe(0);
  });

  it('has nothing for no one, and nothing with nothing stored', async () => {
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
    bindSheetOwner(null);
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
  });
});

/**
 * The hard requirement: a storage failure costs the photos, never the words, and the sheet can say
 * so. Each of these is the record restored as it would have been before IndexedDB existed.
 */
describe('every failure degrades to the words', () => {
  const failures: [string, () => void][] = [
    ['an open that fails', () => (fake.faults.open = 'error')],
    ['an open that throws (a denied store)', () => (fake.faults.open = 'throw')],
    ['an open another tab blocks', () => (fake.faults.open = 'blocked')],
    ['an open that never answers', () => (fake.faults.open = 'hang')],
    ['a read that aborts', () => (fake.faults.transaction = 'abort')],
    ['a read that never answers', () => (fake.faults.transaction = 'hang')],
    ['every blob gone', () => fake.rows.clear()],
  ];

  for (const [name, breakIt] of failures) {
    it(`${name}: the words restore, the photos do not, and it says how many`, async () => {
      await storedSheetWithPhotos('Every word');
      breakIt();
      reloadPage('user_a');
      const restored = await restoreStoredSheet(Date.now());
      expect(restored?.sheet.title).toBe('Every word');
      expect(restored?.sheet.reports[0]?.photos).toEqual([]);
      expect(restored?.sheet.photos).toBeUndefined();
      expect(restored?.photosLost).toBe(2);
      expect(urls.size).toBe(0);

      setSheet(restored?.sheet ?? null);
      const { result } = renderHook(() => useSheetPhotosLost());
      expect(result.current).toBe(2);
    });
  }

  it('no IndexedDB in this browser at all: the same', async () => {
    await storedSheetWithPhotos('Every word');
    reloadPage('user_a');
    setSheetPhotoDbForTests(createSheetPhotoDb());
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Every word');
    expect(restored?.photosLost).toBe(2);
  });

  it('one blob gone costs that photo, and the rest come back', async () => {
    const { onReport, inPool } = await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    fake.rows.delete(onReport.id);
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(1);
    expect(restored?.sheet.reports[0]?.photos).toEqual([]);
    expect(restored?.sheet.photos).toEqual([inPool]);
  });

  it('collects what a partial restore left, once the sheet stops naming it', async () => {
    const { onReport, inPool } = await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    const row = fake.rows.get(onReport.id);
    fake.rows.set(onReport.id, { ...(row as NonNullable<typeof row>), thumb: new File([], 'x') });
    const restored = await restoreStoredSheet(Date.now());
    setSheet(restored?.sheet ?? null);
    await whenSheetPhotosSettled();
    expect([...fake.rows.keys()]).toEqual([inPool.id]);
  });

  it('a malformed photo list costs the photos, not the words', async () => {
    for (const photos of [
      { reports: 3 },
      { reports: { a: 'nope' }, pool: [null, { nope: 1 }] },
      'nope',
    ]) {
      const post = { ...openSheet(), title: 'Torn' };
      window.localStorage.setItem(
        KEY,
        JSON.stringify({ owner: 'user_a', sheet: post, attempt: null, photos }),
      );
      const restored = await restoreStoredSheet(Date.now());
      expect(restored?.sheet.title).toBe('Torn');
      expect(restored?.photosLost).toBe(0);
    }
  });

  it('counts a photo placed on a Report the sheet no longer has', async () => {
    const post = { ...openSheet(), title: 'Torn' };
    const photo = { id: 'p', fullUri: 'p:full', thumbUri: 'p:thumb', placeOnMap: false };
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        owner: 'user_a',
        sheet: post,
        attempt: null,
        photos: { reports: { elsewhere: [photo] } },
      }),
    );
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Torn');
    expect(restored?.photosLost).toBe(1);
  });

  it('the sheet stops saying so when dismissed, or on another draft', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    fake.rows.clear();
    const restored = await restoreStoredSheet(Date.now());
    setSheet(restored?.sheet ?? null);
    const { result, rerender } = renderHook(() => useSheetPhotosLost());
    expect(result.current).toBe(2);
    setSheet(openSheet());
    rerender();
    expect(result.current).toBe(0);
    setSheet(restored?.sheet ?? null);
    rerender();
    expect(result.current).toBe(2);
    dismissSheetPhotosLost();
    rerender();
    expect(result.current).toBe(0);
    dismissSheetPhotosLost();
    rerender();
    expect(result.current).toBe(0);
  });
});

describe('storage that refuses a photo while the sheet is open', () => {
  it('flags it, keeps the photo in the tab, and clears when a later change stores it', async () => {
    setSheet(openSheet());
    const { result } = renderHook(() => useSheetPhotosNotKept());
    expect(result.current).toBe(false);

    fake.faults.put = 'quota';
    const first = await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    await waitFor(() => expect(result.current).toBe(true));
    expect(sheetPhotoPreview(first.id)).not.toBeNull();
    expect(fake.rows.size).toBe(0);

    delete fake.faults.put;
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    await waitFor(() => expect(result.current).toBe(false));
    expect(fake.rows.size).toBe(2);
  });

  it('a reload after a refused photo restores the words and counts the loss', async () => {
    setSheet({ ...openSheet(), title: 'Kept' });
    fake.faults.put = 'clone';
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    delete fake.faults.put;
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Kept');
    expect(restored?.photosLost).toBe(1);
  });

  it('a full localStorage flags the photo and keeps the record it could not replace', async () => {
    const post = { ...openSheet(), title: 'Last that fit' };
    setSheet(post);
    const { result } = renderHook(() => useSheetPhotosNotKept());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const picked = await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    await waitFor(() => expect(result.current).toBe(true));
    expect(sheetPhotoPreview(picked.id)).not.toBeNull();
    expect(fake.rows.size).toBe(0);
    expect(readStoredSheet(Date.now())?.sheet.title).toBe('Last that fit');
  });

  it('a full localStorage with no photos on the sheet says nothing', async () => {
    setSheet(openSheet());
    const { result } = renderHook(() => useSheetPhotosNotKept());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    updateSheet((p) => ({ ...p, title: 'Typing' }));
    await whenSheetPhotosSettled();
    expect(result.current).toBe(false);
  });

  it('a localStorage that cannot be read restores nothing, and throws nothing', async () => {
    setSheet(openSheet());
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
    expect(readStoredSheet(Date.now())).toBeNull();
  });
});

describe('a blob goes with its draft', () => {
  it('when the sheet closes', async () => {
    await storedSheetWithPhotos();
    setSheet(null);
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('when the stored copy is cleared', async () => {
    await storedSheetWithPhotos();
    clearStoredSheet();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('on the explicit sign-out', async () => {
    const { onReport } = await storedSheetWithPhotos();
    forgetSheet();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    expect(sheetPhotoPreview(onReport.id)).toBeNull();
  });

  it('when another draft overwrites the record', async () => {
    await storedSheetWithPhotos();
    setSheet(openSheet());
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('when the draft has expired by the time it is restored', async () => {
    const post = openSheet(Date.now() - 6 * DAY_MS);
    setSheet(post);
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    reloadPage('user_a');
    await expect(restoreStoredSheet(Date.now() + 2 * DAY_MS)).resolves.toBeNull();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('when a page load finds the record expired, leaving its words inert', async () => {
    const post = { ...openSheet(Date.now() - 8 * DAY_MS), title: 'Stale' };
    setSheet(post);
    await pickPhoto({ pool: true });
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(1);
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    expect(readStoredSheet(Date.now())).toBeNull();
  });

  it('when a page load finds no record to name it — even signed out', async () => {
    await storedSheetWithPhotos();
    window.localStorage.removeItem(KEY);
    reloadPage(null);
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('sweeps only once a load, not on every change of account', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    const opens = fake.opens();
    bindSheetOwner('user_a');
    bindSheetOwner(null);
    bindSheetOwner('user_a');
    await whenSheetPhotosSettled();
    expect(fake.opens()).toBe(opens);
  });

  it('when the record is unreadable, or holds nothing a build can revive', async () => {
    for (const raw of ['not json', '{"owner":"user_a","sheet":{"draftId":"x","reports":[null]}}']) {
      await storedSheetWithPhotos();
      window.localStorage.setItem(KEY, raw);
      await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
      await whenSheetPhotosSettled();
      expect(fake.rows.size).toBe(0);
      reloadPage('user_a');
      await whenSheetPhotosSettled();
    }
  });

  it('retries a delete that failed, on the next load', async () => {
    await storedSheetWithPhotos();
    fake.faults.transaction = 'abort';
    setSheet(null);
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(2);
    delete fake.faults.transaction;
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });
});

describe('a blob belongs to the account that wrote it', () => {
  it('stays for its owner across another account’s visit, and only for its owner', async () => {
    const { onReport } = await storedSheetWithPhotos('Mine');
    bindSheetOwner('user_b');
    expect(sheetPhotoPreview(onReport.id)).toBeNull();
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(2);
    expect(sheetPhotoPreview(onReport.id)).toBeNull();

    bindSheetOwner('user_a');
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.sheet.title).toBe('Mine');
    expect(restored?.photosLost).toBe(0);
  });

  it('goes when the next account starts its own sheet over the record', async () => {
    await storedSheetWithPhotos();
    bindSheetOwner('user_b');
    setSheet(openSheet());
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    bindSheetOwner('user_a');
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
  });

  it('is never read for a record that names another owner’s rows', async () => {
    const { onReport } = await storedSheetWithPhotos();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    const row = fake.rows.get(onReport.id);
    fake.rows.set(onReport.id, { ...(row as NonNullable<typeof row>), owner: 'user_b' });
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(1);
    expect(sheetPhotoPreview(onReport.id)).toBeNull();
  });
});

/** A read in flight when the ground moves: its answer is for nobody, and it must not act on it. */
describe('a restore overtaken by events', () => {
  it('a change of account mid-read answers nothing and holds nothing', async () => {
    const { onReport } = await storedSheetWithPhotos();
    reloadPage('user_a');
    const { result } = renderHook(() => useSheetRestoring());
    const pending = restoreStoredSheet(Date.now());
    bindSheetOwner('user_b');
    await waitFor(() => expect(result.current).toBe(false));
    await expect(pending).resolves.toBeNull();
    expect(sheetPhotoPreview(onReport.id)).toBeNull();
    expect(urls.size).toBe(0);
  });

  it('a sheet set mid-read answers nothing, and the new sheet stands', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    const pending = restoreStoredSheet(Date.now());
    const other = { ...openSheet(), title: 'The new one' };
    setSheet(other);
    await expect(pending).resolves.toBeNull();
    await whenSheetPhotosSettled();
    expect(readStoredSheet(Date.now())?.sheet.draftId).toBe(other.draftId);
    expect(fake.rows.size).toBe(0);
  });

  it('a sign-out mid-read answers nothing', async () => {
    await storedSheetWithPhotos();
    reloadPage('user_a');
    const pending = restoreStoredSheet(Date.now());
    forgetSheet();
    await expect(pending).resolves.toBeNull();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
  });

  it('a read started after one was overtaken is its own read', async () => {
    await storedSheetWithPhotos('Mine');
    reloadPage('user_a');
    const overtaken = restoreStoredSheet(Date.now());
    bindSheetOwner('user_b');
    bindSheetOwner('user_a');
    const fresh = restoreStoredSheet(Date.now());
    expect(fresh).not.toBe(overtaken);
    await expect(overtaken).resolves.toBeNull();
    expect((await fresh)?.sheet.title).toBe('Mine');
  });
});
