/**
 * One chosen photo → a draft photo on a Report (A10-8): read on device, stripped and re-encoded, and
 * placed on the lake by core's rule (`placeOnLake`). Every phone door — the reel, the grid, the
 * system picker, a share — comes through here, so the rule is one rule. Untested native glue; the
 * rule is tested in core.
 *
 * The files stay in the processing cache, as the picker's always did: *Save draft* is what makes a
 * sheet durable, and it copies them out (`withPersistedPhotos`). Copying here too left files behind
 * wherever no draft followed — an edit saved or left, a sheet a share replaced (A10-8 self-review).
 */

import type { DraftPhoto, PassedTrackPoint } from '@skating/core';
import { placeOnLake } from '@skating/core';
import { randomUUID } from 'expo-crypto';
import type { MultiPolygon, Polygon } from 'geojson';
import { type PhotoAssetLike, processPhoto } from '../components/photoPipeline';
import { getTrack } from './draftStore';

export interface LakeContext {
  /** The Report's lake outline, when the device holds it — placement reads it (D42). */
  outline?: Polygon | MultiPolygon | null;
  /** The Report's recorded track, for a photo with a time and no location of its own. */
  track: readonly PassedTrackPoint[];
}

export async function toDraftPhoto(asset: PhotoAssetLike, lake: LakeContext): Promise<DraftPhoto> {
  const processed = await processPhoto(asset);
  const placed = placeOnLake(
    {
      ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
      ...(processed.coord !== undefined ? { coord: processed.coord } : {}),
    },
    lake.outline,
    lake.track,
  );
  return {
    id: randomUUID(),
    fullUri: processed.fullUri,
    thumbUri: processed.thumbUri,
    ...(placed.coord !== undefined ? { coord: placed.coord } : {}),
    ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
    placeOnMap: placed.placeOnMap,
  };
}

/** A Report's recorded track as placement reads it — none without a local recording. */
export function trackPointsFor(trackDraftId: string | undefined): PassedTrackPoint[] {
  if (trackDraftId === undefined) return [];
  return (getTrack(trackDraftId)?.points ?? []).map((p) => ({
    lat: p.lat,
    lng: p.lng,
    timestamp: p.t,
  }));
}
