import type { SilhouetteData } from '@skating/core';
import { INACTIVE_BADGE, waterBodyClassLabel, waterBodyDisplayName } from '@skating/core';

import type { SearchResultKind } from '@/lib/analytics';
import type { RecentPick } from '@/stores/searchStore';

/**
 * Global search's pure half (boards 3.17–3.20): turning the two server searches, the recent-report
 * cards and the recents into the grouped rows the plate draws. Everything here is a function of
 * its inputs, so the grouping, the caps and the sub-lines are tested without Convex.
 */

/** The most rows the plate shows — the analytics `rank` runs 1 to this. */
export const MAX_SEARCH_ROWS = 6;
/** Skaters keep this many rows when lakes would otherwise fill the plate. */
const SKATER_SHARE = 2;

/** A water-body search hit, as `waterBodies.searchByName` returns it. */
export interface WaterHit {
  kind: 'body' | 'subArea';
  _id: string;
  waterBodyId: string;
  name: string;
  parentName?: string;
  type: string;
  states: string[];
  inactive?: boolean;
}

/** A public-profile hit, as `profiles.searchProfiles` returns it. */
export interface SkaterHit {
  userId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
}

/** The slice of a recent-report card the sub-lines read. */
export interface RecentCard {
  waterBodyId: string;
  skateEndTime: number;
  subAreaName?: string;
  subAreaNames?: string[];
  silhouette?: SilhouetteData;
}

export interface SearchRow {
  /** Unique across the plate. */
  key: string;
  kind: SearchResultKind;
  name: string;
  /** What it is: "Reservoir · NH", "In Mascoma Lake", "@mochs". */
  sub: string;
  /** The recent-report line at the row's end ("3 reports today"), when there is one. */
  meta?: string;
  /** Where picking it goes. */
  href: string;
  /** What picking it records in the recents. */
  pick: RecentPick;
  /** A lake's outline, when a recent report brought one; otherwise the row shows a pin. */
  silhouette?: Pick<SilhouetteData, 'rings' | 'bbox'>;
  /** A skater's photo. */
  imageUrl?: string;
}

export type SearchGroupId = 'recent' | 'lakes' | 'bays' | 'skaters';

export interface SearchGroup {
  id: SearchGroupId;
  label: string;
  items: SearchRow[];
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────────

/** "Reservoir · NH", or "Inactive · Pond · VT" for a dormant body (the old search box's rule). */
export function waterSubLine(type: string, states: readonly string[], inactive = false): string {
  const kind = waterBodyClassLabel(type);
  const line = states.length > 0 ? `${kind} · ${states.join(', ')}` : kind;
  return inactive ? `${INACTIVE_BADGE} · ${line}` : line;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The calendar day of `ms` in `timeZone`, as a sortable key. */
function dayKey(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-CA', timeZone ? { timeZone } : {});
}

/**
 * The row-end line from the reports skated there in the last few days: "3 reports today", or the
 * latest day's count by weekday ("1 report Tue"). Nothing when nobody has reported — silence here
 * says only that, and never anything about the ice.
 */
export function recentReportsLabel(
  cards: readonly Pick<RecentCard, 'skateEndTime'>[],
  now: number,
  timeZone?: string,
): string | undefined {
  if (cards.length === 0) return undefined;
  const latest = Math.max(...cards.map((c) => c.skateEndTime));
  const day = dayKey(latest, timeZone);
  const count = cards.filter((c) => dayKey(c.skateEndTime, timeZone) === day).length;
  const when =
    day === dayKey(now, timeZone)
      ? 'today'
      : new Date(latest).toLocaleDateString('en-US', {
          weekday: 'short',
          ...(timeZone ? { timeZone } : {}),
        });
  return `${plural(count, 'report', 'reports')} ${when}`;
}

/** A bay's cards: the reports stamped with its name (a two-bay skate counts for both). */
function cardsInBay(cards: readonly RecentCard[], waterBodyId: string, bay: string): RecentCard[] {
  return cards.filter(
    (c) =>
      c.waterBodyId === waterBodyId &&
      (c.subAreaName === bay || (c.subAreaNames ?? []).includes(bay)),
  );
}

function outlineFrom(cards: readonly RecentCard[]): SearchRow['silhouette'] {
  const s = cards.find((c) => c.silhouette)?.silhouette;
  return s ? { rings: s.rings, bbox: s.bbox } : undefined;
}

// ── Recents ──────────────────────────────────────────────────────────────────────────────────

/**
 * A bay's recent pick needs its lake to resolve (a bay is a name on a lake, D60), so its id is the
 * pair. Lakes store their own id; skaters their username.
 */
export function bayPickId(waterBodyId: string, subAreaId: string): string {
  return `${waterBodyId}/${subAreaId}`;
}

export function parseBayPickId(id: string): { waterBodyId: string; subAreaId: string } | null {
  const [waterBodyId, subAreaId, ...rest] = id.split('/');
  if (!waterBodyId || !subAreaId || rest.length > 0) return null;
  return { waterBodyId, subAreaId };
}

/** Where a pick goes. */
export function hrefForPick(pick: RecentPick): string | null {
  switch (pick.kind) {
    case 'water_body':
      return `/water/${encodeURIComponent(pick.id)}`;
    case 'sub_area': {
      const bay = parseBayPickId(pick.id);
      return bay
        ? `/water/${encodeURIComponent(bay.waterBodyId)}?sub=${encodeURIComponent(bay.subAreaId)}`
        : null;
    }
    case 'skater':
      return `/u/${encodeURIComponent(pick.id)}`;
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

export function rowFromWaterHit(
  hit: WaterHit,
  cards: readonly RecentCard[],
  now: number,
  timeZone?: string,
): SearchRow {
  const name = waterBodyDisplayName(hit.name);
  if (hit.kind === 'subArea') {
    const pick: RecentPick = { kind: 'sub_area', id: bayPickId(hit.waterBodyId, hit._id) };
    const meta = recentReportsLabel(cardsInBay(cards, hit.waterBodyId, hit.name), now, timeZone);
    return {
      key: `sub_area:${hit._id}`,
      kind: 'sub_area',
      name,
      sub: hit.parentName ? `In ${hit.parentName}` : 'A bay',
      ...(meta ? { meta } : {}),
      href: hrefForPick(pick) as string,
      pick,
    };
  }
  const mine = cards.filter((c) => c.waterBodyId === hit._id);
  const meta = recentReportsLabel(mine, now, timeZone);
  const silhouette = outlineFrom(mine);
  const pick: RecentPick = { kind: 'water_body', id: hit._id };
  return {
    key: `water_body:${hit._id}`,
    kind: 'water_body',
    name,
    sub: waterSubLine(hit.type, hit.states, hit.inactive),
    ...(meta ? { meta } : {}),
    ...(silhouette ? { silhouette } : {}),
    href: hrefForPick(pick) as string,
    pick,
  };
}

export function rowFromSkater(hit: SkaterHit): SearchRow {
  const pick: RecentPick = { kind: 'skater', id: hit.username };
  return {
    key: `skater:${hit.userId}`,
    kind: 'skater',
    name: hit.displayName,
    sub: `@${hit.username}`,
    href: hrefForPick(pick) as string,
    pick,
    ...(hit.profileImageUrl ? { imageUrl: hit.profileImageUrl } : {}),
  };
}

/**
 * The plate's groups for a query: lakes, then bays, then skaters, at most {@link MAX_SEARCH_ROWS}
 * rows. Water fills first, but skaters keep {@link SKATER_SHARE} rows when there are any, so a
 * person's name never disappears under a page of fuzzy pond matches. Empty groups are dropped.
 */
export function buildResultGroups(
  water: readonly WaterHit[],
  skaters: readonly SkaterHit[],
  cards: readonly RecentCard[],
  now: number,
  timeZone?: string,
): SearchGroup[] {
  const skaterRoom = Math.min(skaters.length, SKATER_SHARE);
  const waterShown = water.slice(0, MAX_SEARCH_ROWS - skaterRoom);
  const skatersShown = skaters.slice(0, MAX_SEARCH_ROWS - waterShown.length);
  const rows = waterShown.map((h) => rowFromWaterHit(h, cards, now, timeZone));
  const groups: SearchGroup[] = [
    { id: 'lakes', label: 'Lakes', items: rows.filter((r) => r.kind === 'water_body') },
    { id: 'bays', label: 'Bays', items: rows.filter((r) => r.kind === 'sub_area') },
    { id: 'skaters', label: 'Skaters', items: skatersShown.map(rowFromSkater) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** A recent pick once its query has answered: enough to draw its row. */
export type ResolvedPick =
  | { kind: 'water_body'; name: string; type: string; states: string[]; inactive?: boolean }
  | { kind: 'sub_area'; name: string; parentName: string }
  | { kind: 'skater'; displayName: string; username: string; imageUrl?: string };

/** The key a pick resolves under. */
export function pickKey(pick: RecentPick): string {
  return `${pick.kind}:${pick.id}`;
}

/**
 * The Recent group (3.19), in the order picked. A pick still loading, gone (a removed lake, a
 * deleted or blocking account) or stored in a shape that no longer parses is left out rather than
 * drawn half-known.
 */
export function buildRecentGroup(
  picks: readonly RecentPick[],
  resolved: ReadonlyMap<string, ResolvedPick>,
  cards: readonly RecentCard[],
  now: number,
  timeZone?: string,
): SearchGroup[] {
  const items: SearchRow[] = [];
  for (const pick of picks.slice(0, MAX_SEARCH_ROWS)) {
    const r = resolved.get(pickKey(pick));
    const href = hrefForPick(pick);
    if (!r || r.kind !== pick.kind || href === null) continue;
    if (r.kind === 'water_body') {
      const mine = cards.filter((c) => c.waterBodyId === pick.id);
      const meta = recentReportsLabel(mine, now, timeZone);
      const silhouette = outlineFrom(mine);
      items.push({
        key: pickKey(pick),
        kind: 'water_body',
        name: waterBodyDisplayName(r.name),
        sub: waterSubLine(r.type, r.states, r.inactive),
        ...(meta ? { meta } : {}),
        ...(silhouette ? { silhouette } : {}),
        href,
        pick,
      });
    } else if (r.kind === 'sub_area') {
      const bay = parseBayPickId(pick.id) as { waterBodyId: string };
      const meta = recentReportsLabel(cardsInBay(cards, bay.waterBodyId, r.name), now, timeZone);
      items.push({
        key: pickKey(pick),
        kind: 'sub_area',
        name: r.name,
        sub: `In ${r.parentName}`,
        ...(meta ? { meta } : {}),
        href,
        pick,
      });
    } else {
      items.push({
        key: pickKey(pick),
        kind: 'skater',
        name: r.displayName,
        sub: `@${r.username}`,
        href,
        pick,
        ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
      });
    }
  }
  return items.length > 0 ? [{ id: 'recent', label: 'Recent', items }] : [];
}

/** The lakes a list of recent picks touches (a bay's lake included), for their report lines. */
export function recentBodyIds(picks: readonly RecentPick[]): string[] {
  const ids = picks.flatMap((p) => {
    if (p.kind === 'water_body') return [p.id];
    if (p.kind === 'sub_area') {
      const bay = parseBayPickId(p.id);
      return bay ? [bay.waterBodyId] : [];
    }
    return [];
  });
  return [...new Set(ids)].slice(0, MAX_SEARCH_ROWS).sort();
}

/** The water bodies whose recent reports the plate wants — a bounded, stable list. */
export function cardBodyIds(water: readonly Pick<WaterHit, 'waterBodyId'>[]): string[] {
  return [...new Set(water.map((h) => h.waterBodyId))].slice(0, MAX_SEARCH_ROWS).sort();
}

/** The flat 1-based rank of a row in the plate: what `search_result_opened` reports. */
export function rankOf(groups: readonly SearchGroup[], key: string): number {
  const flat = groups.flatMap((g) => g.items);
  return flat.findIndex((r) => r.key === key) + 1;
}

/**
 * The name split around the first case-insensitive match of the query, for the underlined
 * highlight. `null` when the query isn't in the name (a fuzzy or alias hit): then nothing is lit.
 */
export function splitMatch(
  name: string,
  query: string,
): { before: string; match: string; after: string } | null {
  const q = query.trim();
  if (q.length === 0) return null;
  const at = name.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  return {
    before: name.slice(0, at),
    match: name.slice(at, at + q.length),
    after: name.slice(at + q.length),
  };
}
