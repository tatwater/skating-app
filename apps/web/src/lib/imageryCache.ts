/**
 * Fetching aerial cells, through a cache that survives the CDN's own TTL (N6e / D146).
 *
 * ## Two caches, doing different jobs
 *
 * The USGS ImageServer sits behind CloudFront with `max-age=43200`. Measured on 2026-08-21, a repeat
 * of an identical URL is **0.08 s against 29.3 s** for a fresh render — so the grid in
 * `@skating/core`'s `imageryTiles` exists to make our URLs repeat at all, and that alone buys most of
 * the win for anyone looking at ground somebody else looked at today.
 *
 * This layer is the second half: a **Cache API store keyed by cell address**, which
 *
 * 1. outlives the twelve-hour CDN window, so the lake you check every morning stays instant;
 * 2. costs no network round trip at all on a hit, where a CDN hit still costs one;
 * 3. works while the connection is bad, which is the state a phone at a trailhead is usually in.
 *
 * **Deliberately not a service worker.** A worker would intercept these transparently, and it would
 * also mean a registration, a scope, an update lifecycle and a class of "the old worker is still
 * serving" bug — all to cache one kind of URL that exactly one module requests. Calling the Cache API
 * directly keeps the caching where the fetching is.
 *
 * ## Why `fetch` and not `new Image()`
 *
 * v2 used an `Image` with `crossOrigin = 'anonymous'`. That cannot be cached by us, and it cannot
 * tell a photograph from the service's failure mode — under concurrent load the ImageServer returns
 * **200 with a one-kilobyte body**, which an `Image` reports through `onerror` indistinguishably from
 * a network failure and which a canvas would happily draw as garbage. Fetching the bytes lets us
 * check them before they reach the canvas, and hand `createImageBitmap` something we know decodes.
 */

import {
  AERIAL_TILE_PX,
  aerialExportUrl,
  type ImageryTile,
  mercatorXToLng,
  mercatorYToLat,
} from '@skating/core';

/**
 * Bumped when the cell geometry or the request parameters change.
 *
 * The key is the cell address, so a change to what an address *means* — a different grid size, a
 * different format — has to invalidate the store or it will serve yesterday's meaning under today's
 * key. That is a silent wrong-pixels bug, which is why the version is in the cache name rather than
 * in a comment asking someone to remember.
 */
const CACHE_NAME = 'aerial-tiles-v1';

/** The URL for a cell — a pure function of its address, which is the whole point of the grid. */
export function tileUrl(tile: ImageryTile): string {
  return aerialExportUrl(
    {
      minLat: mercatorYToLat(tile.box.minY),
      maxLat: mercatorYToLat(tile.box.maxY),
      minLng: mercatorXToLng(tile.box.minX),
      maxLng: mercatorXToLng(tile.box.maxX),
    },
    AERIAL_TILE_PX,
    AERIAL_TILE_PX,
  );
}

/**
 * The smallest response we will believe is a photograph.
 *
 * The truncated-under-load responses measured at 0–1 KB; a real 2,048-square JPEG of anything came
 * back at 280 KB and up. 8 KB is comfortably between them and well under any legitimate render,
 * including a cell that is entirely open water.
 */
const MIN_PLAUSIBLE_TILE_BYTES = 8 * 1024;

/** The store, opened once. `null` on any browser or context where the Cache API is unavailable. */
let cachePromise: Promise<Cache | null> | null = null;
function openCache(): Promise<Cache | null> {
  if (!cachePromise) {
    cachePromise =
      typeof caches === 'undefined'
        ? Promise.resolve(null)
        : // Not a secure context, storage denied, quota exhausted — all of them mean "no cache", and
          // none of them should mean "no photograph".
          caches.open(CACHE_NAME).catch(() => null);
  }
  return cachePromise;
}

/** Decoded cells, so a redraw within a session costs neither network nor JPEG decode. */
const bitmaps = new Map<string, ImageBitmap>();

/**
 * How many decoded cells to hold in memory.
 *
 * An `ImageBitmap` at 2,048 square is ~16 MB of GPU-backed memory, so this is a real budget rather
 * than a nicety — twelve is roughly three viewports' worth of history, which covers pan-away-and-back
 * without pinning a session's entire browsing in VRAM.
 */
const MAX_RESIDENT_BITMAPS = 12;

function remember(key: string, bitmap: ImageBitmap): void {
  // Two views can be in flight over the same cell, and the loser's bitmap would otherwise be dropped
  // from the map with nothing releasing it — 16 MB of GPU-backed memory per occurrence, invisible to
  // every counter that matters. Replacing an entry is a release, not just an overwrite.
  const previous = bitmaps.get(key);
  if (previous && previous !== bitmap) previous.close();
  bitmaps.set(key, bitmap);
  // Insertion-ordered, so the first key is the least recently added. `close()` releases the backing
  // memory immediately rather than waiting for the collector to notice a few hundred megabytes.
  while (bitmaps.size > MAX_RESIDENT_BITMAPS) {
    const oldest = bitmaps.keys().next().value;
    if (oldest === undefined) break;
    bitmaps.get(oldest)?.close();
    bitmaps.delete(oldest);
  }
}

/** Refresh a hit's recency without re-decoding. */
function touch(key: string): ImageBitmap | undefined {
  const bitmap = bitmaps.get(key);
  if (bitmap) {
    bitmaps.delete(key);
    bitmaps.set(key, bitmap);
  }
  return bitmap;
}

/**
 * How many cells the disk store may hold.
 *
 * **A cache with no ceiling is not a cache, it is a disk leak.** Nothing here expires — that is the
 * point, since outliving the CDN's twelve hours is the whole reason this layer exists — so the bound
 * has to be a count. A 2,048-square NAIP JPEG runs 300 KB to 2 MB, so 400 cells is roughly a few
 * hundred megabytes: generous for a season of looking at the same handful of lakes, and well short of
 * the origin quota, past which the browser evicts the *whole* bucket and takes everything else we
 * store with it.
 */
const MAX_CACHED_TILES = 400;

/**
 * Drop the oldest entries once the store is over budget.
 *
 * `cache.keys()` answers in insertion order, which is not recency — a cell you look at every morning
 * is still evicted on its original birthday. That is the honest trade for not writing a second index
 * to track access times: the CDN and the in-memory map both still answer, and the cost of being wrong
 * is one refetch.
 */
async function trim(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHED_TILES) return;
    for (const request of keys.slice(0, keys.length - MAX_CACHED_TILES)) {
      await cache.delete(request);
    }
  } catch {
    // Storage errors are not imagery errors. An untrimmed store is a worse cache, not a broken one.
  }
}

async function decode(blob: Blob): Promise<ImageBitmap | null> {
  if (blob.size < MIN_PLAUSIBLE_TILE_BYTES) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    // A body that is the right size and still not an image — the service returning an error page as
    // `image/jpeg`, which it does. Treated as a miss, never drawn.
    return null;
  }
}

/**
 * Is this cell already decoded in memory?
 *
 * Asked **before** a view announces itself as loading. A pan that lands on cells already resident
 * costs no network and no decode, so the wash would be signalling work that is not happening — and a
 * loading indicator that fires when nothing is loading teaches people to ignore the one that means
 * something.
 */
export function isTileResident(key: string): boolean {
  return bitmaps.has(key);
}

/**
 * One cell, from memory, then from disk, then from the service.
 *
 * Resolves `null` rather than throwing for every failure, because the caller's correct response to a
 * missing cell is *"leave that ground blank"* in all of them — and a rejected promise in the middle
 * of a `Promise.all` over four cells would lose the three that worked.
 */
export async function loadTile(
  tile: ImageryTile,
  key: string,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  const resident = touch(key);
  if (resident) return resident;

  const url = tileUrl(tile);
  const cache = await openCache();
  if (signal?.aborted) return null;

  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const bitmap = await decode(await hit.blob());
        if (bitmap) {
          remember(key, bitmap);
          return bitmap;
        }
        // A stored body that no longer decodes is worse than no entry: it would fail forever under
        // a key that stops us ever re-requesting. Drop it and fall through to the network.
        await cache.delete(url);
      }
    } catch {
      // Storage errors are not imagery errors — fall through to the network.
    }
  }

  try {
    const response = await fetch(url, { signal, mode: 'cors' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await decode(blob);
    if (!bitmap) return null;
    remember(key, bitmap);
    // Stored after the decode succeeded, so a truncated body is never written under a key we would
    // then trust. Failure to store is not failure to draw.
    if (cache) {
      cache
        .put(url, new Response(blob, { headers: response.headers }))
        .then(() => trim(cache))
        .catch(() => {});
    }
    return bitmap;
  } catch {
    return null;
  }
}

/** Drop everything — the operator escape hatch, and what a grid change would need. */
export async function clearImageryCache(): Promise<void> {
  for (const bitmap of bitmaps.values()) bitmap.close();
  bitmaps.clear();
  cachePromise = null;
  if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => {});
}
