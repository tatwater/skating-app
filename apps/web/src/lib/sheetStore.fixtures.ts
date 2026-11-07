/**
 * What the sheet persistence tests share: a fake IndexedDB behind the real store, object URLs jsdom
 * lacks, and the moves an author makes. Each test file mocks `../components/photoPipeline` itself
 * (`vi.mock` is per file), with `sheetPhotoPipeline.fake`.
 */

import { type DraftPhoto, openPostSheet, type PostSheet } from '@skating/core';
import { vi } from 'vitest';
import { createSheetPhotoDb, type SheetPhotoRow } from './sheetPhotoDb';
import { createFakeIndexedDb, type FakeIndexedDb } from './sheetPhotoDb.fake';
import {
  addSheetPhoto,
  releaseAllSheetPhotos,
  setSheetPhotoDbForTests,
  whenSheetPhotosSettled,
} from './sheetPhotos';
import { bindSheetOwner, resetSheetStoreForTests, updateSheet } from './sheetStore';

export const DAY_MS = 24 * 3600_000;

export const pickedFile = (name = 'photo.jpg') =>
  new File(['some bytes'], name, { type: 'image/jpeg' });

let seq = 0;
export const mint = () => `id-${++seq}`;

export function openSheet(openedAtMs: number = Date.now()): PostSheet {
  return openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, openedAtMs, mint);
}

/** jsdom has no object URLs; the fake counts them, so a test can say none leaked. */
export function stubObjectUrls() {
  const live = new Set<string>();
  let next = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:fake-${++next}`;
    live.add(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    live.delete(url);
  });
  return live;
}

/** A short deadline: a test of a hang should not take ten seconds. */
const DEADLINE_MS = 15;
let installed: FakeIndexedDb<SheetPhotoRow> | null = null;

function connectToInstalled(): void {
  const fake = installed as FakeIndexedDb<SheetPhotoRow>;
  setSheetPhotoDbForTests(createSheetPhotoDb(() => fake.factory, DEADLINE_MS));
}

/** Put the store on a fresh fake. */
export function installFakeStore(): FakeIndexedDb<SheetPhotoRow> {
  installed = createFakeIndexedDb<SheetPhotoRow>();
  connectToInstalled();
  return installed;
}

/**
 * A page reload: every module variable gone and the connection with them, `localStorage` and the
 * fake's rows left as they are. The new page's first bind sweeps, as `AuthGate`'s would.
 */
export function reloadPage(owner: string | null): void {
  releaseAllSheetPhotos();
  resetSheetStoreForTests();
  connectToInstalled();
  bindSheetOwner(owner);
}

/** The panel's move: process a file, then put its record on the sheet. */
export async function pickPhoto(
  where: { pool: true } | { reportId: string },
  overrides: Partial<DraftPhoto> = {},
): Promise<DraftPhoto> {
  const draft = { ...(await addSheetPhoto(pickedFile())), ...overrides };
  updateSheet((p) =>
    'pool' in where
      ? { ...p, photos: [...(p.photos ?? []), draft], dirty: true }
      : {
          ...p,
          dirty: true,
          reports: p.reports.map((r) =>
            r.id === where.reportId ? { ...r, photos: [...r.photos, draft] } : r,
          ),
        },
  );
  return draft;
}

export const settled = whenSheetPhotosSettled;
