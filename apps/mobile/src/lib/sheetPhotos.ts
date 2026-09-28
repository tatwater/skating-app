/**
 * One chosen photo → a draft photo on a Report (A10-8): read on device, stripped and re-encoded,
 * copied out of the evictable cache, and placed on the lake by core's rule (`placeOnLake`). Every
 * phone door — the reel, the grid, the system picker, a share — comes through here, so the rule
 * is one rule. Untested native glue; the rule is tested in core.
 */

import type { DraftPhoto, PassedTrackPoint } from '@skating/core';
import { placeOnLake } from '@skating/core';
import { randomUUID } from 'expo-crypto';
import type { MultiPolygon, Polygon } from 'geojson';
import { type PhotoAssetLike, processPhoto } from '../components/photoPipeline';
import { persistDraftPhoto } from './draftPhotos';

export interface LakeContext {
  /** The Report's lake outline, when the device holds it — placement reads it (D42). */
  outline?: Polygon | MultiPolygon | null;
  /** The Report's recorded track, for a photo with a time and no location of its own. */
  track: readonly PassedTrackPoint[];
}

export async function toDraftPhoto(asset: PhotoAssetLike, lake: LakeContext): Promise<DraftPhoto> {
  const processed = await processPhoto(asset);
  const id = randomUUID();
  const [fullUri, thumbUri] = await Promise.all([
    persistDraftPhoto(processed.fullUri, `sheet-${id}-full.jpg`),
    persistDraftPhoto(processed.thumbUri, `sheet-${id}-thumb.jpg`),
  ]);
  const placed = placeOnLake(
    {
      ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
      ...(processed.coord !== undefined ? { coord: processed.coord } : {}),
    },
    lake.outline,
    lake.track,
  );
  return {
    id,
    fullUri,
    thumbUri,
    ...(placed.coord !== undefined ? { coord: placed.coord } : {}),
    ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
    placeOnMap: placed.placeOnMap,
  };
}
