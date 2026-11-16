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
