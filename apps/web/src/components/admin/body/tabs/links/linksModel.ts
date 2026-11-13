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

export type StaffLink = { label: string; url: string };
export type KeyedLink = StaffLink & { key: string };

/**
 * Each staff link with a key that survives a reorder: its label and address, and which repeat of
 * that pair it is (links are never deduplicated, so two rows may be the same pair).
 */
export function keyedLinks(links: readonly StaffLink[]): KeyedLink[] {
  const seen = new Map<string, number>();
  return links.map((link) => {
    const pair = `${link.label}\u0000${link.url}`;
    const n = seen.get(pair) ?? 0;
    seen.set(pair, n + 1);
    return { ...link, key: `${pair}\u0000${n}` };
  });
}

/** `links` in the order `keys` names. Keys it doesn't hold are skipped; rows `keys` misses stay last. */
export function inKeyOrder(links: readonly KeyedLink[], keys: readonly string[]): StaffLink[] {
  const byKey = new Map(links.map((l) => [l.key, l]));
  const ordered = keys.flatMap((k) => {
    const l = byKey.get(k);
    return l === undefined ? [] : [l];
  });
  const rest = links.filter((l) => !keys.includes(l.key));
  return [...ordered, ...rest].map(({ label, url }) => ({ label, url }));
}

/** "43.6174°N 72.1360°W" — the interior point as the map's plate reads it. */
export function coordWords(c: LatLng): string {
  const lat = `${Math.abs(c.lat).toFixed(4)}°${c.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(c.lng).toFixed(4)}°${c.lng >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lng}`;
}
