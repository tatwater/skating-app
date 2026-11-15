import { findPhoto } from '@skating/core';
import { releaseSheetPhoto } from '@/lib/sheetPhotos';
import { getSheet } from '@/lib/sheetStore';

/**
 * Let a removed photo's file go — once the open sheet no longer holds the photo. Called after the
 * removal's `updateSheet`: a sheet that refused the change (a Post on its way, or one already sent)
 * still holds the photo, and a photo on the sheet without its file would post nothing and come back
 * from a reload as lost.
 */
export function releaseIfDropped(photoId: string): void {
  const sheet = getSheet();
  if (sheet !== null && findPhoto(sheet, photoId) !== null) return;
  releaseSheetPhoto(photoId);
}
