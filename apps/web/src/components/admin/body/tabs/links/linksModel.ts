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
 * old one: a link with the same words in the same place keeps its id first (so an edit that makes
 * one link read like another, or like its twin, never takes the other's id), then one with the same
 * words anywhere (a reorder); a link whose words changed takes the id of the link that stood in its
 * place (an edit); anything else is new. Pure; `fresh` mints an id.
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
  return next.map((link, i) => {
    let id = ids[i] ?? null;
    if (id === null) {
      const inPlace = prev[i];
      id = inPlace !== undefined && !used.has(inPlace.key) ? inPlace.key : fresh();
      used.add(id);
    }
    return { label: link.label, url: link.url, key: id };
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
