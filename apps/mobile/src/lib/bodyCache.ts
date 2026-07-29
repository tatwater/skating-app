/**
 * On-device cache of recently-viewed water-body reference data (F2 Layer 2) — the `expo-sqlite`
 * glue behind the pure resolver in `offlineBody.ts`. Every time a lake's detail loads
 * (`waterBodies.get`), we upsert its polygon + centroid + name here (LRU-capped); offline, a device
 * GPS fix resolves the lake against this cache so a report can be captured with no signal. Polygons
 * are tiny (avg ~600 bytes), so ~50 bodies is KBs. Untested native glue (like `photoPipeline`), with
 * the decision logic factored into `offlineBody.ts`; **designed to gain a tile-pack column later**
 * (Phase 9 offline basemap) without a reshape.
 */

import type { LatLng } from '@skating/core';
import * as SQLite from 'expo-sqlite';
import type { MultiPolygon, Polygon } from 'geojson';
import { type CachedBody, nearestCachedBody } from './offlineBody';

/** Keep the 50 most-recently-viewed bodies — polygons are tiny, and it covers a day's browsing. */
const MAX_CACHED_BODIES = 50;

let db: SQLite.SQLiteDatabase | null = null;
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-body-cache.db');
    db.execSync(
      `CREATE TABLE IF NOT EXISTS cached_bodies (
        waterBodyId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        states TEXT NOT NULL,
        polygon TEXT NOT NULL,
        centroidLat REAL NOT NULL,
        centroidLng REAL NOT NULL,
        surfaceAreaSqM REAL NOT NULL,
        cachedAt INTEGER NOT NULL
      )`,
    );
  }
  return db;
}

/** The body shape `waterBodies.get` returns (the fields the offline cache needs). */
export interface CacheableBody {
  waterBodyId: string;
  name: string;
  states?: string[];
  polygon: Polygon | MultiPolygon;
  centroid: LatLng;
  surfaceAreaSqM?: number;
}

/**
 * Cache (upsert) a viewed body, then LRU-evict beyond `MAX_CACHED_BODIES`. **Best-effort** — a cache
 * write must never break viewing a lake, so any sqlite error is swallowed.
 */
export function cacheBody(body: CacheableBody, now: number = Date.now()): void {
  try {
    const d = getDb();
    d.runSync(
      `INSERT INTO cached_bodies
         (waterBodyId, name, states, polygon, centroidLat, centroidLng, surfaceAreaSqM, cachedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(waterBodyId) DO UPDATE SET
         name = excluded.name, states = excluded.states, polygon = excluded.polygon,
         centroidLat = excluded.centroidLat, centroidLng = excluded.centroidLng,
         surfaceAreaSqM = excluded.surfaceAreaSqM, cachedAt = excluded.cachedAt`,
      [
        body.waterBodyId,
        body.name,
        JSON.stringify(body.states ?? []),
        JSON.stringify(body.polygon),
        body.centroid.lat,
        body.centroid.lng,
        body.surfaceAreaSqM ?? 0,
        now,
      ],
    );
    d.runSync(
      `DELETE FROM cached_bodies WHERE waterBodyId NOT IN
         (SELECT waterBodyId FROM cached_bodies ORDER BY cachedAt DESC LIMIT ?)`,
      [MAX_CACHED_BODIES],
    );
  } catch {
    // Best-effort cache — a write failure never blocks the read path.
  }
}

interface CachedBodyRow {
  waterBodyId: string;
  name: string;
  states: string;
  polygon: string;
  centroidLat: number;
  centroidLng: number;
  surfaceAreaSqM: number;
  cachedAt: number;
}

function loadAll(): CachedBody[] {
  return getDb()
    .getAllSync<CachedBodyRow>('SELECT * FROM cached_bodies')
    .map((r) => ({
      waterBodyId: r.waterBodyId,
      name: r.name,
      states: JSON.parse(r.states) as string[],
      polygon: JSON.parse(r.polygon) as Polygon | MultiPolygon,
      centroid: { lat: r.centroidLat, lng: r.centroidLng },
      surfaceAreaSqM: r.surfaceAreaSqM,
      cachedAt: r.cachedAt,
    }));
}

/**
 * The cached polygon for one body, or `null` if it isn't in the cache.
 *
 * Snap-to-shoreline (N5b) reads through here rather than through `waterBodies.get`, because the
 * skater it's for is standing on the ice: the affordance needs the lake's outline, and on the ice
 * there is frequently no signal to fetch one with. The cache already holds exactly this — a body's
 * polygon is written on every detail view — so the shore band works offline for any lake the skater
 * has looked at, which is every lake they are standing on (the layout opens its detail on arrival).
 */
export function cachedBodyPolygon(waterBodyId: string): Polygon | MultiPolygon | null {
  try {
    const row = getDb().getFirstSync<Pick<CachedBodyRow, 'polygon'>>(
      'SELECT polygon FROM cached_bodies WHERE waterBodyId = ?',
      [waterBodyId],
    );
    return row ? (JSON.parse(row.polygon) as Polygon | MultiPolygon) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a GPS coord to a recently-viewed body — the offline auto-select entry point (delegates to
 * the pure `nearestCachedBody`). Returns null if the cache is empty / nothing is within the buffer.
 */
export function resolveCachedBody(
  coord: LatLng,
  bufferMeters?: number,
): { waterBodyId: string; name: string } | null {
  try {
    return nearestCachedBody(loadAll(), coord, bufferMeters);
  } catch {
    return null;
  }
}
