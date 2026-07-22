/**
 * Offline basemap tiles — Layer-3 spike, route (1) (Phase 9.5).
 *
 * Phase 9 logged that MapLibre's `OfflineManager.createOfflineRegion`/`createPack` downloader crawls a
 * **style URL** for individual `{z}/{x}/{y}` tile resources — which a single `pmtiles://` archive can't
 * offer (it's one file read via HTTP range requests, nothing to enumerate). Rather than abandon pmtiles
 * for the offline path, route (1) sidesteps the downloader entirely: **fetch the regional `.pmtiles`
 * archive once to device storage and point the same style at a local `file://` URI.** MapLibre Native
 * already reads pmtiles for *rendering* (the online map does), so if it reads a local-file archive too,
 * the offline basemap is just a URL swap — no offline-region API, no crawlable tile server.
 *
 * The bundled MapLibre Native SDKs (Android `13.2.0`, iOS `6.26.0`) both ship built-in PMTiles support;
 * whether that `FileSource` accepts a `file://` inner URL is the **one thing only a device build can
 * confirm** — so this module is gated behind `EXPO_PUBLIC_OFFLINE_BASEMAP` and defaults **off**: with the
 * flag unset nothing downloads and the map uses the remote URL exactly as before. The pure source-
 * selection below is unit-tested; the download is a thin, failure-swallowing wrapper (with a lazy import
 * so this module stays testable without the native filesystem) so a failed fetch can never blank the map.
 */

/** The on-device filename for the downloaded regional basemap archive, under the document dir. */
export const OFFLINE_PMTILES_FILENAME = 'basemap.pmtiles';

/**
 * The pmtiles source `buildMapStyle` should use: the on-device `file://` archive once it's downloaded (so
 * the basemap renders with no signal), else the remote URL. Pure — the caller decides `localReady` from a
 * filesystem check. `buildMapStyle` prefixes the returned value with `pmtiles://`, so a local URI becomes
 * `pmtiles://file://…` and a remote one `pmtiles://https://…`.
 */
export function resolveBasemapSource(input: {
  remoteUrl: string;
  localUri: string | null;
  localReady: boolean;
}): string {
  return input.localReady && input.localUri ? input.localUri : input.remoteUrl;
}

/**
 * Ensure the offline basemap archive is on device, downloading it once from `remoteUrl`. Returns the
 * local `file://` URI when it's present (or freshly downloaded), or `null` on any failure — the caller
 * then keeps the remote URL, because a failed offline download must never blank the live map. Idempotent:
 * an already-downloaded archive short-circuits without re-fetching. `expo-file-system` is imported lazily
 * so the rest of this module (the pure selector above) loads under Vitest without the native filesystem.
 */
export async function ensureOfflineBasemap(remoteUrl: string): Promise<string | null> {
  if (!remoteUrl) return null;
  try {
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, OFFLINE_PMTILES_FILENAME);
    if (file.exists && (file.size ?? 0) > 0) return file.uri ?? null;
    const downloaded = await File.downloadFileAsync(remoteUrl, file);
    if (downloaded.exists && (downloaded.size ?? 0) > 0) return downloaded.uri ?? null;
    // A partial/failed download must not masquerade as a usable archive on the next launch.
    downloaded.delete();
    return null;
  } catch {
    return null;
  }
}
