import {
  allReferenceLinks,
  communityFor,
  copernicusUrl,
  type LatLng,
  linkCoordinate,
  type ReferenceLinkBody,
  satelliteImageryAvailable,
  windyUrl,
} from '@skating/core';

import type { BBoxLike } from '@/lib/mapSurface';

/**
 * Body › Links' arithmetic: the links built from the lake (core's `allReferenceLinks`, derived at
 * render time and stored nowhere), what each is built from, and the staff's own links, keyed so a
 * reorder can follow a row. Pure.
 */

export type DerivedRow = {
  id: 'windy' | 'copernicus' | 'community';
  label: string;
  /** What the link is built from, or what its click does. */
  sub: string;
  url: string;
  /** Shown to skaters. A link the rules withhold rests faded, its button off. */
  offered: boolean;
};

/**
 * The derived links, in the order the lake sheet lists them, plus the Copernicus link where the
 * area rule withholds it (faded, so staff see why it is missing from the sheet).
 */
export function derivedRows(body: ReferenceLinkBody, now: number): DerivedRow[] {
  const offered = allReferenceLinks({ ...body, referenceLinks: [] }, now);
  const byId = new Map(offered.map((l) => [l.id, l]));
  const rows: DerivedRow[] = [];
  const coord = linkCoordinate(body);
  if (coord) {
    rows.push({
      id: 'windy',
      label: byId.get('windy')?.label ?? 'Wind and weather on Windy',
      sub: 'The interior point, zoomed out to the region',
      url: windyUrl(coord),
      offered: byId.has('windy'),
    });
    rows.push({
      id: 'copernicus',
      label: 'Recent satellite passes on Copernicus Browser',
      sub: 'The interior point, the last 14 days',
      url: copernicusUrl(coord, now),
      offered: satelliteImageryAvailable(body),
    });
  }
  const community = byId.get('community');
  if (community) {
    const group = communityFor(body);
    // A Google Group is searched by name; a Facebook group's link is its front page.
    const searched = group?.groupSlug !== undefined && body.name !== undefined;
    rows.push({
      id: 'community',
      label: community.label,
      sub: searched
        ? `Find mentions in ${(community.note ?? '').split(' — ')[0]}`
        : `Opens ${group?.label ?? community.label}`,
      url: community.url,
      offered: true,
    });
  }
  return rows;
}

/** The body as the Links tab reads it: the lake sheet's facts, and its box to frame a map on. */
export type LinksBody = ReferenceLinkBody & { bbox?: BBoxLike };

/** A link built from the lake for staff only: never in the lake sheet, so never in its count. */
export type StaffOnlyRow = {
  id: 'googleMaps';
  label: string;
  sub: string;
  url: string;
};

/** The browser tab a Google Maps link is framed for, px (its side panel takes the rest). */
const MAPS_VIEW = { width: 1000, height: 600 } as const;
/** Google Maps' zoom range worth asking for: a region at the widest, a pond's shore at the closest. */
const MAPS_ZOOM = { min: 3, max: 18, unframed: 14 } as const;

/** A latitude as a share of the Web Mercator world's height, 0 at the top. */
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/**
 * Google Maps' zoom that shows the whole of `bbox` around `center` in {@link MAPS_VIEW} — the
 * center being the interior point, not the box's middle, the frame reaches the box's far side
 * both ways. Its 256 px tiles: the world is `256 · 2^z` px across. Clamped to {@link MAPS_ZOOM}.
 */
export function mapsZoom(center: LatLng, bbox: BBoxLike): number {
  const halfX = Math.max(center.lng - bbox.minLng, bbox.maxLng - center.lng) / 360;
  const cy = mercY(center.lat);
  const halfY = Math.max(Math.abs(mercY(bbox.maxLat) - cy), Math.abs(mercY(bbox.minLat) - cy));
  const zoomFor = (px: number, half: number) =>
    half > 0 ? Math.log2(px / (256 * 2 * half)) : Number.POSITIVE_INFINITY;
  const z = Math.floor(Math.min(zoomFor(MAPS_VIEW.width, halfX), zoomFor(MAPS_VIEW.height, halfY)));
  return Math.max(MAPS_ZOOM.min, Math.min(MAPS_ZOOM.max, z));
}

/**
 * Google Maps' documented map URL (`/maps/@?api=1&map_action=map`): no key, nothing about the
 * viewer — only the lake's point and a zoom that frames it.
 */
export function googleMapsUrl(center: LatLng, zoom: number): string {
  const params = new URLSearchParams({
    api: '1',
    map_action: 'map',
    center: `${center.lat.toFixed(5)},${center.lng.toFixed(5)}`,
    zoom: String(zoom),
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}

/**
 * **The lake on Google Maps**, opened in a new tab for staff — at the body's **interior point**
 * (never `centroid` / `representativePoint`: that is Turf's point-on-feature, which sits on the
 * shoreline of a curved lake), zoomed to frame the whole lake. Without an interior point it
 * centers on the box's middle; with neither there is no row.
 */
export function googleMapsRow(body: LinksBody): StaffOnlyRow | null {
  const box = body.bbox;
  const center =
    body.interiorPoint ??
    (box === undefined
      ? undefined
      : { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 });
  if (center === undefined) return null;
  const zoom = box === undefined ? MAPS_ZOOM.unframed : mapsZoom(center, box);
  return {
    id: 'googleMaps',
    label: 'The lake on Google Maps',
    sub: 'Framed on the whole lake · Staff only, not in the lake sheet',
    url: googleMapsUrl(center, zoom),
  };
}

/**
 * A staff link: `waterBodies.get`'s `referenceLinks` entry, kept whole. The record's name, states,
 * interior point and area build the links from the lake; the rest of the record is the frame's.
 */
export type StaffLink = { label: string; url: string };
export type KeyedLink = StaffLink & { key: string };

/**
 * **Each link's id, kept across an edit.** The record's links carry no id of their own, and a key
 * made from a link's words changes when its words do — so an edited link would look like a new row
 * (and a lift or a focus held on it would lose it). `carryIds` gives the new list the ids of the
 * old one — **only to the same link**: one with exactly the same words in the same place keeps its id
 * first (so twins keep their own), then one with the same words anywhere (a reorder). A link whose
 * words changed is never inferred from its place — it may be another moderator's replacement — so it
 * is new, and a change aimed at the old link finds nothing to change (refused, never re-aimed). The
 * page's own edits keep their ids another way: a list the server shows that is exactly one the page
 * sent takes that list's keys (`LinksTabView`). Pure; `fresh` mints an id.
 */
export function carryIds(
  prev: readonly KeyedLink[],
  next: readonly StaffLink[],
  fresh: () => string,
): KeyedLink[] {
  const used = new Set<string>();
  const same = (p: KeyedLink | undefined, link: StaffLink): p is KeyedLink =>
    p !== undefined && !used.has(p.key) && p.label === link.label && p.url === link.url;
  const ids: (string | null)[] = next.map(() => null);
  const claim = (i: number, p: KeyedLink) => {
    ids[i] = p.key;
    used.add(p.key);
  };
  // The same words in the same place: untouched by the edit, whatever moved around it.
  next.forEach((link, i) => {
    const p = prev[i];
    if (same(p, link)) claim(i, p);
  });
  // The same words elsewhere: a reorder.
  next.forEach((link, i) => {
    if (ids[i] !== null) return;
    const p = prev.find((q) => same(q, link));
    if (p !== undefined) claim(i, p);
  });
  return next.map((link, i) => ({ label: link.label, url: link.url, key: ids[i] ?? fresh() }));
}

/**
 * **The staff list's changes, by id** — what each save path hands the tab's write queue
 * (`listWriter`), applied there to the newest acknowledged list, never to the one a render held.
 * A change to a link that is gone (another moderator removed it) changes nothing.
 */
export const linkChanges = {
  /**
   * `keys` first, in that order; links it doesn't name (added since) stay last, in theirs. `null`
   * when a link it orders is no longer there (removed, or replaced — a new link): the order was
   * made for a list that has moved, and is refused rather than moving a link it never addressed.
   */
  order:
    (keys: readonly string[]) =>
    (base: readonly KeyedLink[]): KeyedLink[] | null => {
      const byKey = new Map(base.map((l) => [l.key, l]));
      if (keys.some((k) => !byKey.has(k))) return null;
      const named = keys.map((k) => byKey.get(k) as KeyedLink);
      return [...named, ...base.filter((l) => !keys.includes(l.key))];
    },
  add:
    (link: KeyedLink) =>
    (base: readonly KeyedLink[]): KeyedLink[] => [...base, link],
  /** `null` when the link is no longer there (another moderator removed it): nothing to edit. */
  edit:
    (key: string, link: StaffLink) =>
    (base: readonly KeyedLink[]): KeyedLink[] | null =>
      base.some((l) => l.key === key)
        ? base.map((l) => (l.key === key ? { label: link.label, url: link.url, key } : l))
        : null,
  /** `null` when the link is no longer there: nothing to remove (said, never a quiet success). */
  remove:
    (key: string) =>
    (base: readonly KeyedLink[]): KeyedLink[] | null =>
      base.some((l) => l.key === key) ? base.filter((l) => l.key !== key) : null,
};

/**
 * Two staff lists that save the same: the same words in the same order. The keys are the page's
 * own (`carryIds`), so the write queue compares without them — a link it added carries a key the
 * page never drew, and its echo must still read as the write landing.
 */
export function sameLinks(a: readonly StaffLink[], b: readonly StaffLink[]): boolean {
  return a.length === b.length && a.every((l, i) => l.label === b[i]?.label && l.url === b[i]?.url);
}

/** "43.6174°N 72.1360°W" — the interior point as the map's plate reads it. */
export function coordWords(c: LatLng): string {
  const lat = `${Math.abs(c.lat).toFixed(4)}°${c.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(c.lng).toFixed(4)}°${c.lng >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lng}`;
}
