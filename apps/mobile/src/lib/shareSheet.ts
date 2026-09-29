/**
 * A new report from photos shared to Gli (A10-8 §8.7): one Report with the photos on it. A photo
 * taken on a lake the device knows names the lake — as the tab's own GPS fix does — and places the
 * photos on its water; the latest capture is a ghost end time, a suggestion the author taps or
 * doesn't (D188). The sheet is dirty from the start: it holds photos, so leaving it parks it in
 * Drafts. Untested native glue; where the photos land is core's `sharedPhotos`, and is.
 */

import {
  type DraftPhoto,
  openPostSheet,
  type PostSheet,
  photosEndSuggestion,
  suggestEndFromPhotos,
  updateReport,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { cachedBodyPolygon, resolveCachedBody } from './bodyCache';
import { exifCoord } from './photo';
import type { SharedPhoto } from './sharedPhotoFiles';
import { toDraftPhoto } from './sheetPhotos';

export async function shareSheet(
  photos: readonly SharedPhoto[],
  showPutIn: boolean,
  now: number,
): Promise<PostSheet> {
  const located = photos.map((p) => exifCoord(p.exif)).find((c) => c !== undefined);
  const match = located ? resolveCachedBody(located) : null;
  const outline = match ? cachedBodyPolygon(match.waterBodyId) : null;
  const drafts: DraftPhoto[] = [];
  for (const photo of photos) {
    try {
      drafts.push(await toDraftPhoto(photo, { outline, track: [] }));
    } catch {
      // One unreadable file does not cost the others.
    }
  }
  const post = openPostSheet(
    'share',
    {
      // Named only when the device knows the lake. A photo's location never becomes the Report's
      // own coordinate: one taken at home would otherwise travel with the report (D42).
      ...(match ? { waterBodyId: match.waterBodyId, bodyName: match.name } : {}),
      showPutIn,
    },
    now,
    randomUUID,
  );
  const first = post.reports[0];
  if (!first) return post;
  const end = photosEndSuggestion(photos, now);
  const next = updateReport(post, first.id, (r) => ({
    ...r,
    photos: drafts,
    sheet: end !== undefined ? suggestEndFromPhotos(r.sheet, end) : r.sheet,
  }));
  return { ...next, dirty: true };
}
