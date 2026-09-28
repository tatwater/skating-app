/**
 * The phone's photo library (A10-8 §8.4, D207) — the `expo-media-library` glue, on SDK 57's
 * class-based API. (A10-7's reel called `getAssetsAsync` / `getAssetInfoAsync` from the package
 * root, which SDK 57 turned into stubs that throw; its `catch` read the throw as an empty roll, so
 * the reel never ran on a device.)
 *
 * iOS only: Android reads no library (Google Play's media policy — the manifest blocks the
 * permissions), and its door is the system picker. Nothing here prompts except `askLibraryAccess`,
 * which only a tap calls. Untested native glue; which state the sheet is in is core's
 * `libraryAccess`, and is.
 */

import {
  type ActivityWindow,
  type LibraryAccess,
  type LibraryPermission,
  libraryAccess,
  readsPhotoLibrary,
} from '@skating/core';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import type { PhotoAssetLike } from '../components/photoPipeline';

/** Does this platform read the library at all? */
export const READS_LIBRARY = readsPhotoLibrary(Platform.OS);

/** Photos only: the reel never asks for video or audio. */
const GRANULAR: MediaLibrary.GranularPermission[] = ['photo'];

function toPermission(p: MediaLibrary.PermissionResponse): LibraryPermission {
  return {
    status: p.status as LibraryPermission['status'],
    canAskAgain: p.canAskAgain,
    ...(p.accessPrivileges !== undefined ? { accessPrivileges: p.accessPrivileges } : {}),
  };
}

/** The permission's state, read without a prompt. */
export async function readLibraryAccess(): Promise<LibraryAccess> {
  if (!READS_LIBRARY) return 'none';
  try {
    return libraryAccess(
      Platform.OS,
      toPermission(await MediaLibrary.getPermissionsAsync(false, GRANULAR)),
    );
  } catch {
    return 'ask';
  }
}

/** The one prompt — called only from the person's tap. */
export async function askLibraryAccess(): Promise<LibraryAccess> {
  if (!READS_LIBRARY) return 'none';
  return libraryAccess(
    Platform.OS,
    toPermission(await MediaLibrary.requestPermissionsAsync(false, GRANULAR)),
  );
}

/** Limited access: the system's own sheet for sharing more photos with Gli. */
export async function chooseMorePhotos(): Promise<void> {
  await MediaLibrary.presentPermissionsPicker(['photo']);
}

/** One of the library's photos as the reel and the grid show it, before anything is read from it. */
export interface LibraryItem {
  assetId: string;
  uri: string;
  takenAtMs: number;
}

/**
 * The library's photos in a window, oldest first — one page. Metadata first (cheap, from the media
 * store), then a displayable uri per item on the page; the grid pages, so this never reads the
 * whole library.
 */
export async function libraryPhotos(
  window: ActivityWindow,
  page: { offset: number; limit: number },
): Promise<LibraryItem[]> {
  const rows = await new MediaLibrary.Query()
    .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
    .gte(MediaLibrary.AssetField.CREATION_TIME, window.startMs)
    .lte(MediaLibrary.AssetField.CREATION_TIME, window.endMs)
    .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: true })
    .offset(page.offset)
    .limit(page.limit)
    .exeForMetadata();
  const dated = rows.filter(
    (r): r is typeof r & { creationTime: number } => r.creationTime !== null,
  );
  return Promise.all(
    dated.map(async (r) => ({
      assetId: r.id,
      takenAtMs: r.creationTime,
      uri: await new MediaLibrary.Asset(r.id).getUri(),
    })),
  );
}

/**
 * What the pipeline needs of one chosen photo: its file, its size, and the library's own time and
 * location — read here, per chosen photo, never for the whole grid.
 */
export async function readLibraryPhoto(assetId: string): Promise<PhotoAssetLike> {
  const asset = new MediaLibrary.Asset(assetId);
  const [info, location] = await Promise.all([
    asset.getInfo(),
    // A photo with no location — or one the platform will not say — is simply unlocated.
    asset.getLocation().catch(() => null),
  ]);
  return {
    uri: info.uri,
    width: info.width,
    height: info.height,
    ...(info.creationTime !== null ? { creationTime: info.creationTime } : {}),
    ...(location ? { location: { lat: location.latitude, lng: location.longitude } } : {}),
  };
}
