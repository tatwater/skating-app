/**
 * Fetching the freeze-up archive, and caching it for as long as the tab lives (N6e §C2, D148/D149).
 *
 * ## Three reads, and they age very differently
 *
 * - **`index/latest.json`** — which season to show. D149's turnover, so it changes at most once a
 *   winter and in practice on the day the first frame of a new season lands.
 * - **`index/<season>.json`** — that season's table of contents. ~4,900 entries, and **immutable once
 *   the season is complete**.
 * - **`frames/<season>/<granule>.json`** — one pass's per-lake statistics. Immutable, small, and
 *   needed for only the handful of frames covering the lake on screen.
 *
 * All three are static objects in R2 behind a CDN, so the correct cache policy here is *"forever,
 * within a session"*. A skater who opens five lakes in a row pays for one index and reuses every
 * manifest the lakes have in common — and neighbouring lakes share most of their granules, which is
 * the whole reason the manifest is per-granule rather than per-body.
 *
 * ## Failure is quiet on purpose, and counted so it cannot hide
 *
 * A missing or malformed archive object resolves to `null` rather than throwing. The scrubber is an
 * enhancement over a reveal that works without it (Tier 1 needs none of this), so the honest failure
 * is *no timeline* rather than a broken drawer. But a silent `null` is also how a misconfigured base
 * URL looks exactly like an empty archive, so every failure logs once per key and {@link archiveError}
 * reports whether anything has gone wrong at all.
 *
 * ## Why this sits in core rather than in each app
 *
 * It touches no platform API beyond `fetch`, which both a browser and React Native provide, and takes
 * its base URL as an argument rather than reading an environment. So the alternative was two copies of
 * a cache policy and a failure convention — and the moment they drifted, one client would be silently
 * re-fetching an immutable object on every render while the other reported a 404 as an empty archive.
 */

import {
  ARCHIVE_POINTER_KEY,
  type ArchivePointer,
  archiveUrl,
  type FrameStats,
  manifestKeyFor,
  type SeasonIndex,
  seasonIndexKeyFor,
} from './imageryArchive';

/** Resolved payloads, keyed by full URL. `null` means "we tried and it is not there". */
const cache = new Map<string, unknown>();
/** In-flight requests, so ten lakes opening at once make one request per key rather than ten. */
const inFlight = new Map<string, Promise<unknown>>();
/** Keys we have already complained about, so a broken base URL logs once rather than per frame. */
const complained = new Set<string>();

let sawError = false;

/** Has any archive read failed this session? Distinguishes "misconfigured" from "empty". */
export function archiveError(): boolean {
  return sawError;
}

/** Drop everything — for tests, and for an operator changing the configured archive at runtime. */
export function resetArchiveCache(): void {
  cache.clear();
  inFlight.clear();
  complained.clear();
  sawError = false;
}

async function loadJson<T>(url: string): Promise<T | null> {
  if (cache.has(url)) return cache.get(url) as T | null;

  const existing = inFlight.get(url);
  if (existing) return (await existing) as T | null;

  const request = (async (): Promise<T | null> => {
    try {
      const response = await fetch(url);
      // A 404 on a manifest is ordinary — plenty of frames predate the per-body pass — so this is not
      // an exceptional path, just an absent one.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      sawError = true;
      if (!complained.has(url)) {
        complained.add(url);
        console.warn(`[freeze-up archive] could not read ${url}`, error);
      }
      return null;
    }
  })();

  inFlight.set(url, request);
  try {
    const result = await request;
    cache.set(url, result);
    return result;
  } finally {
    inFlight.delete(url);
  }
}

/**
 * The season the app should be showing, per D149.
 *
 * ⚠ **Read from the archive rather than derived from the clock.** `archiveSeasonAt(Date.now())` looks
 * like the same answer and is not: ingest starts *looking* in October, so a new season key exists for
 * weeks before it has a single frame, and deriving the season locally would blank a scrubber that has
 * been serving last winter perfectly well since April.
 */
export async function loadArchiveSeason(baseUrl: string): Promise<string | null> {
  const pointer = await loadJson<ArchivePointer>(archiveUrl(baseUrl, ARCHIVE_POINTER_KEY));
  return pointer?.season ?? null;
}

/** A season's table of contents — every frame, every band, in capture order. */
export async function loadSeasonIndex(
  baseUrl: string,
  season: string,
): Promise<SeasonIndex | null> {
  return loadJson<SeasonIndex>(archiveUrl(baseUrl, seasonIndexKeyFor(season)));
}

/** One pass's per-lake statistics. Keyed on the granule, so every band of a pass shares it. */
export async function loadFrameStats(
  baseUrl: string,
  season: string,
  granuleId: string,
): Promise<FrameStats | null> {
  return loadJson<FrameStats>(archiveUrl(baseUrl, manifestKeyFor(season, granuleId)));
}

/**
 * Every already-resolved manifest, as the lookup {@link buildBodyTimeline} takes.
 *
 * **Synchronous by design.** The timeline has to render while manifests are still arriving —
 * otherwise a drawer shows nothing until the last fetch lands — so this returns what is in hand and
 * the reducer marks the rest `'inferred'`. Each arrival re-renders and upgrades those stops.
 */
export function statsLookup(baseUrl: string, season: string) {
  return (granuleId: string): FrameStats | undefined => {
    const url = archiveUrl(baseUrl, manifestKeyFor(season, granuleId));
    return (cache.get(url) as FrameStats | null | undefined) ?? undefined;
  };
}
