/**
 * Page through a STAC search (A06e PR 2; shared since A06i §5).
 *
 * Lifted out of `select-granules` because the live imagery poll in Convex (`imageryLive.ts`) asks the
 * same catalog the same question every six hours, and two copies of the paging rules are two chances
 * to disagree about what "the end of the results" means. `fetch` is injected so the CLI, Convex and a
 * test can each hand in their own.
 */

import type { GranuleCandidate } from './granuleSelection';

/** Earth Search — Element 84's public STAC over the AWS open-data Sentinel buckets. */
export const DEFAULT_STAC_URL = 'https://earth-search.aws.element84.com/v1';

/**
 * Which mission's catalog to search.
 *
 * ⚠ **Two collections, and almost nothing downstream is shared.** Sentinel-2 items carry
 * `eo:cloud_cover` and an MGRS tile in the id; Sentinel-1 items carry neither and add
 * `sat:orbit_state` instead. So the mission decides the collection, the id grammar, the selection
 * function *and* whether the empty-tile prefilter can run at all.
 */
export const STAC_COLLECTIONS = { s2: 'sentinel-2-l2a', s1: 'sentinel-1-grd' } as const;
export type StacMission = keyof typeof STAC_COLLECTIONS;

/**
 * A cap on how far a `next` chain may be followed. A season is a handful of pages at 250 items
 * each; 200 exists only so a server handing back a `next` link identical to its request becomes an
 * error rather than a loop nobody is watching.
 */
export const MAX_STAC_PAGES = 200;

interface StacItem {
  id: string;
  geometry?: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  properties: {
    datetime: string;
    'eo:cloud_cover'?: number;
    /** Sentinel-1 only. Recorded, never filtered on — see `sarSelection`. */
    'sat:orbit_state'?: 'ascending' | 'descending';
  };
}

export interface StacSearch {
  collection: string;
  bbox: readonly [number, number, number, number];
  /** RFC 3339 interval, e.g. `2026-10-03T00:00:00Z/2026-10-06T23:59:59Z`. */
  datetime: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

/**
 * Every item a search matches, as selection candidates.
 *
 * STAC caps a page at a few hundred items and hands back a `next` link; silently taking only the
 * first would look exactly like a quiet season.
 *
 * ⚠ **A `next` link comes in two shapes and only one of them carries a `body`.** Earth Search's POST
 * search returns the continuation token inside `body`; the GET form puts it in the `href` instead.
 * Treating an absent `body` as "no more pages" reads the second shape as the end of the search. So
 * the request shape follows the link rather than being assumed.
 */
export async function searchStac(
  fetchFn: FetchLike,
  search: StacSearch,
  stacUrl: string = DEFAULT_STAC_URL,
): Promise<{ items: GranuleCandidate[]; pages: number }> {
  const items: GranuleCandidate[] = [];
  let request: { url: string; body: Record<string, unknown> | null } | null = {
    url: `${stacUrl}/search`,
    body: {
      collections: [search.collection],
      bbox: [...search.bbox],
      datetime: search.datetime,
      limit: 250,
    },
  };
  let pages = 0;

  while (request) {
    const response = request.body
      ? await fetchFn(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        })
      : await fetchFn(request.url);
    if (!response.ok) {
      throw new Error(`STAC search failed: ${response.status} ${response.statusText}`);
    }
    const page = (await response.json()) as {
      features: StacItem[];
      links?: { rel: string; href: string; body?: Record<string, unknown> }[];
    };
    pages++;
    for (const feature of page.features) {
      items.push({
        id: feature.id,
        datetime: feature.properties.datetime,
        ...(feature.properties['eo:cloud_cover'] === undefined
          ? {}
          : { cloudCoverPct: feature.properties['eo:cloud_cover'] }),
        ...(feature.geometry
          ? { footprint: feature.geometry as GranuleCandidate['footprint'] }
          : {}),
        // Recorded rather than filtered on. Ascending and descending see a lake at different
        // incidence angles, so a *timeline* must not blend them — but that is a read-time
        // correction, and dropping half the passes here would be irreversible.
        ...(feature.properties['sat:orbit_state']
          ? { orbitDirection: feature.properties['sat:orbit_state'] }
          : {}),
      });
    }
    const next = page.links?.find((l) => l.rel === 'next');
    if (!next) break;
    if (pages >= MAX_STAC_PAGES) {
      throw new Error(
        `STAC still offering a next link after ${pages} pages — refusing to keep following it`,
      );
    }
    request = { url: next.href, body: next.body ?? null };
  }

  return { items, pages };
}

/** `YYYY-MM-DD` to `YYYY-MM-DD`, whole days, as STAC's datetime interval. */
export function stacDayRange(from: string, to: string): string {
  return `${from}T00:00:00Z/${to}T23:59:59Z`;
}
