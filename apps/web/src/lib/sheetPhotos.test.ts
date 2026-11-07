import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SheetPhotoRow } from './sheetPhotoDb';
import {
  addSheetPhoto,
  adoptSheetPhotos,
  readSheetPhotos,
  releaseAllSheetPhotos,
  releaseRestoredPhotosExcept,
  releaseSheetPhoto,
  sheetPhotoBlob,
  sheetPhotoPreview,
  syncSheetPhotos,
  whenSheetPhotosSettled,
} from './sheetPhotos';
import { installFakeStore, pickedFile, stubObjectUrls } from './sheetStore.fixtures';

vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'));

const SCOPE = { owner: 'user_a', draftId: 'draft-1' };

function row(photoId: string, patch: Partial<SheetPhotoRow> = {}): SheetPhotoRow {
  return {
    ...SCOPE,
    photoId,
    full: pickedFile('full.jpg'),
    thumb: pickedFile('thumb.jpg'),
    storedAt: 1,
    ...patch,
  };
}

let urls: Set<string>;
let fake: ReturnType<typeof installFakeStore>;

beforeEach(async () => {
  await whenSheetPhotosSettled();
  urls = stubObjectUrls();
  fake = installFakeStore();
});

describe('the blobs a tab holds', () => {
  it('turns a picked file into a record, and keeps its blobs beside the sheet', async () => {
    const draft = await addSheetPhoto(pickedFile());
    expect(draft).toMatchObject({
      fullUri: `${draft.id}:full`,
      thumbUri: `${draft.id}:thumb`,
      coord: { lat: 44.5, lng: -73.2 },
      takenAtMs: 1_000,
      placeOnMap: false,
    });
    expect(sheetPhotoPreview(draft.id)).toMatch(/^blob:/);
    expect(sheetPhotoBlob(draft.fullUri)?.name).toBe('photo.jpg');
    expect(sheetPhotoBlob(draft.thumbUri)?.name).toBe('thumb-photo.jpg');
  });

  it('answers nothing for a photo it does not hold', () => {
    expect(sheetPhotoPreview('nope')).toBeNull();
    expect(sheetPhotoBlob('nope:full')).toBeNull();
    expect(sheetPhotoBlob('')).toBeNull();
  });

  it('revokes the preview of a released photo, and releasing twice is fine', async () => {
    const draft = await addSheetPhoto(pickedFile());
    releaseSheetPhoto(draft.id);
    releaseSheetPhoto(draft.id);
    expect(sheetPhotoPreview(draft.id)).toBeNull();
    expect(urls.size).toBe(0);
  });

  it('releases everything at once', async () => {
    await addSheetPhoto(pickedFile());
    await addSheetPhoto(pickedFile());
    releaseAllSheetPhotos();
    expect(urls.size).toBe(0);
  });
});

describe('the reconcile', () => {
  it('stores what the claim names and keeps what it already stored', async () => {
    const a = await addSheetPhoto(pickedFile());
    const onSettled = vi.fn();
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, onSettled);
    await whenSheetPhotosSettled();
    const stored = fake.rows.get(a.id);
    expect(stored).toMatchObject(SCOPE);
    expect(onSettled).toHaveBeenLastCalledWith(true);

    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, onSettled);
    await whenSheetPhotosSettled();
    expect(fake.rows.get(a.id)).toBe(stored);
  });

  it('collects every row the claim does not name, whoever filed it', async () => {
    fake.rows.set('old', row('old'));
    fake.rows.set('theirs', row('theirs', { owner: 'user_b' }));
    syncSheetPhotos({ ...SCOPE, photoIds: [] }, vi.fn());
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('refiles a row claimed under another scope, if it holds the blobs to do it', async () => {
    const a = await addSheetPhoto(pickedFile());
    fake.rows.set(a.id, row(a.id, { owner: 'user_b' }));
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, vi.fn());
    await whenSheetPhotosSettled();
    expect(fake.rows.get(a.id)?.owner).toBe('user_a');
  });

  it('a null claim collects everything', async () => {
    fake.rows.set('old', row('old'));
    const onSettled = vi.fn();
    syncSheetPhotos(null, onSettled);
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
    expect(onSettled).toHaveBeenLastCalledWith(true);
  });

  it('calls while one waits collapse into it, and the last claim wins', async () => {
    const a = await addSheetPhoto(pickedFile());
    const onSettled = vi.fn();
    syncSheetPhotos(null, onSettled);
    syncSheetPhotos({ ...SCOPE, photoIds: [] }, onSettled);
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect([...fake.rows.keys()]).toEqual([a.id]);
  });

  it('says so when a claimed photo has no blob anywhere', async () => {
    const onSettled = vi.fn();
    syncSheetPhotos({ ...SCOPE, photoIds: ['gone'] }, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenLastCalledWith(false);
  });

  it('one photo over quota does not cost the others', async () => {
    const a = await addSheetPhoto(pickedFile());
    const b = await addSheetPhoto(pickedFile());
    const onSettled = vi.fn();
    fake.faults.put = 'quota';
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenLastCalledWith(false);
    delete fake.faults.put;
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id, b.id] }, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenLastCalledWith(true);
    expect(fake.rows.size).toBe(2);
  });

  it('a store that cannot answer fails the claim only if it named a photo', async () => {
    fake.faults.open = 'error';
    const onSettled = vi.fn();
    syncSheetPhotos({ ...SCOPE, photoIds: ['p'] }, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenLastCalledWith(false);
    syncSheetPhotos(null, onSettled);
    await whenSheetPhotosSettled();
    expect(onSettled).toHaveBeenLastCalledWith(true);
  });
});

describe('reading back', () => {
  const CLAIM = { ...SCOPE, photoIds: ['a', 'b'] };

  it('returns only what the claim names, under the claim’s own scope', async () => {
    fake.rows.set('a', row('a'));
    fake.rows.set('unclaimed', row('unclaimed'));
    fake.rows.set('b', row('b', { owner: 'user_b' }));
    expect((await readSheetPhotos(CLAIM)).map((r) => r.photoId)).toEqual(['a']);
  });

  it('a store that cannot answer has no photos', async () => {
    fake.rows.set('a', row('a'));
    fake.faults.transaction = 'abort';
    await expect(readSheetPhotos(CLAIM)).resolves.toEqual([]);
  });

  it('drops a row whose blob is gone, empty, or no blob at all', async () => {
    const evicted = pickedFile('evicted.jpg');
    evicted.slice = () => {
      throw new DOMException('gone', 'NotReadableError');
    };
    const empty = new File([], 'empty.jpg');
    for (const [id, patch] of [
      ['a', { full: evicted }],
      ['b', { thumb: empty }],
      ['c', { full: undefined as unknown as File }],
    ] as const) {
      fake.rows.set(id, row(id, patch));
    }
    await expect(readSheetPhotos({ ...SCOPE, photoIds: ['a', 'b', 'c'] })).resolves.toEqual([]);
  });

  it('runs after a reconcile already queued, so it reads what that left', async () => {
    const a = await addSheetPhoto(pickedFile());
    syncSheetPhotos({ ...SCOPE, photoIds: [a.id] }, vi.fn());
    const rows = await readSheetPhotos({ ...SCOPE, photoIds: [a.id] });
    expect(rows.map((r) => r.photoId)).toEqual([a.id]);
  });
});

describe('adopting a restore', () => {
  it('makes a stored row readable as if it had just been picked', () => {
    adoptSheetPhotos([row('a')]);
    expect(sheetPhotoPreview('a')).toMatch(/^blob:/);
    expect(sheetPhotoBlob('a:full')?.name).toBe('full.jpg');
  });

  it('leaves alone a photo this tab still holds', async () => {
    const a = await addSheetPhoto(pickedFile());
    const preview = sheetPhotoPreview(a.id);
    adoptSheetPhotos([row(a.id)]);
    expect(sheetPhotoPreview(a.id)).toBe(preview);
    expect(urls.size).toBe(1);
  });

  it('lets go of what the sheet does not use, and only what a restore brought', async () => {
    const picked = await addSheetPhoto(pickedFile());
    adoptSheetPhotos([row('used'), row('declined')]);
    releaseRestoredPhotosExcept(['used']);
    expect(sheetPhotoPreview('declined')).toBeNull();
    expect(sheetPhotoPreview('used')).not.toBeNull();
    expect(sheetPhotoPreview(picked.id)).not.toBeNull();
    // `used` is an ordinary photo of the sheet now: a later close does not treat it as a restore's.
    releaseRestoredPhotosExcept([]);
    expect(sheetPhotoPreview('used')).not.toBeNull();
  });
});
