import { dropPhoto } from '@skating/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sheetPhotoPreview } from '@/lib/sheetPhotos';
import {
  getSheet,
  resetSheetStoreForTests,
  setSheet,
  setSheetAttempt,
  updateSheet,
} from '@/lib/sheetStore';
import {
  installFakeStore,
  openSheet,
  pickPhoto,
  reloadPage,
  settled,
  stubObjectUrls,
} from '@/lib/sheetStore.fixtures';
import { releaseIfDropped } from './photoRelease';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));

beforeEach(() => {
  window.localStorage.clear();
  stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
});

afterEach(async () => {
  await settled();
  resetSheetStoreForTests();
});

describe('releaseIfDropped', () => {
  it('keeps the file of a photo the sheet still holds — a removal the sheet refused', async () => {
    const sheet = openSheet();
    setSheet(sheet);
    const photo = await pickPhoto({ pool: true });
    // A sent Post takes no change: the removal did not happen, so the file must stay.
    setSheetAttempt({
      kind: 'post',
      id: sheet.draftId,
      idempotencyKey: sheet.idempotencyKey,
      status: 'creating',
      reports: [],
      createdAt: 1,
      updatedAt: 1,
    });
    updateSheet((p) => dropPhoto(p, photo.id));
    releaseIfDropped(photo.id);
    expect(getSheet()?.photos?.[0]?.id).toBe(photo.id);
    expect(sheetPhotoPreview(photo.id)).not.toBeNull();
  });

  it('lets the file go once the sheet took the removal', async () => {
    setSheet(openSheet());
    const photo = await pickPhoto({ pool: true });
    updateSheet((p) => dropPhoto(p, photo.id));
    releaseIfDropped(photo.id);
    expect(getSheet()?.photos).toEqual([]);
    expect(sheetPhotoPreview(photo.id)).toBeNull();
  });

  it('lets the file go when no sheet is open', async () => {
    setSheet(openSheet());
    const photo = await pickPhoto({ pool: true });
    setSheet(null);
    releaseIfDropped(photo.id);
    expect(sheetPhotoPreview(photo.id)).toBeNull();
  });
});
