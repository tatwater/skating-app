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

  /**
   * ⚠ **"Not there" is cacheable; "could not ask" is not.**
   *
   * A `null` used to be remembered forever whatever produced it, so one dropped request for
   * `index/latest.json` — a tunnel, a sleeping laptop, a 503 — disabled the scrubber on *every* lake
   * for the rest of the session and rendered *"The freeze-up archive could not be reached"* with no
   * path back but a reload. A 404 genuinely is permanent within a session (the archive's objects are
   * immutable), and plenty of frames predate the per-body pass, so that one stays cached.
   */
  let definitive = false;

  const request = (async (): Promise<T | null> => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        // A client error is the server answering. A 5xx or a network throw is not.
        definitive = response.status >= 400 && response.status < 500;
        throw new Error(`HTTP ${response.status}`);
      }
      definitive = true;
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
    if (result !== null || definitive) cache.set(url, result);
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
 * Warm the browser's cache for a season's frames, so scrubbing does not start a cold load per notch.
 *
 * > **Founder, 2026-08-25:** *"lazy-load all images from the currently-selected imagery source for
 * > the whole season […] so that loading doesn't start fresh at each notch."*
 *
 * ⚠ **Only the header of each archive is fetched, not the whole thing.** A `.pmtiles` frame is
 * ~700 KB and a season is thousands of them; pulling all of that would be hundreds of megabytes to
 * make a scrubber feel smooth. But the *first* range read of any pmtiles is its header and directory,
 * and that read is what a cold tile request has to wait for — so a `Range: bytes=0-16383` per frame
 * buys most of the latency back for a few kilobytes each.
 *
 * Sequential and abortable on purpose. A lake can sit under dozens of passes, and a burst of parallel
 * requests would compete with the tiles of the frame the skater is actually looking at — which is the
 * one load that must not get slower for this.
 *
 * Failures are ignored entirely: this is a cache warm, so a frame that does not preload simply loads
 * when it is asked for, exactly as it did before.
 */
export async function prefetchFrames(
  baseUrl: string,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    if (signal?.aborted) return;
    try {
      const response = await fetch(archiveUrl(baseUrl, key), {
        headers: { Range: 'bytes=0-16383' },
        ...(signal ? { signal } : {}),
      });
      // ⚠ **Drained, not just awaited.** A `Response` whose body is never read holds its stream —
      // and its connection — open until it is collected, and a browser will not necessarily commit
      // a half-read response to the HTTP cache, which is the entire point of this loop. It is 16 KB
      // per frame, already sequential, so reading it costs nothing the fetch had not already paid.
      await response.arrayBuffer();
    } catch {
      // A warm that did not warm. The frame still loads on demand.
    }
  }
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
