import { LANDMARK_KIND_LABELS, type LandmarkKind } from '@skating/core';

import type { LatLng, PlacesMapDrawing, PlacesMapPoint } from './placesMap';

/**
 * The Places tab's data: what is asked of the body's places (the community's email names and the
 * skaters' proposals) and its landmarks — and, for the one selected, what its card shows. Pure.
 * `null` means *not recorded*, drawn as absent.
 */

/** A person as a lockup names them. */
export type Person = { name: string; handle: string };

export type LandmarkRow = {
  id: string;
  name: string;
  kind: LandmarkKind;
  point: LatLng;
  aliases: string[];
  /** The catalogs that list it, as caps tags, in the order its ids came. */
  catalogs: string[];
  /** Its ids in those catalogs: `{ catalog: 'OSM', id: 'node/158821324' }`. */
  ids: Array<{ catalog: string; id: string }>;
  /** The bay it falls in, by name; `null` when it is in none (or the bays aren't read yet). */
  bay: string | null;
  areaSqM: number | null;
  /** When it was added and by what, when the read says. */
  added: { at: number; by: string } | null;
};

export type PlaceNameAsk = {
  kind: 'place-name';
  id: string;
  name: string;
  /** How many of the community's emails use it. */
  messages: number;
  /** The emails name a landmark already on the map, without saying which. */
  alreadyNamed: boolean;
};

export type ProposalAsk = {
  kind: 'proposal';
  id: string;
  name: string;
  point: LatLng;
  askers: number;
  /** Who asked first, when the read names them. */
  asker: Person | null;
  /** The landmark already on the map under that name, at that place. */
  existingLandmarkId: string | null;
  /** A live landmark it may be, near it under one of its names. */
  similar: { landmarkId: string; name: string; point: LatLng; meters: number } | null;
};

export type PlaceAsk = PlaceNameAsk | ProposalAsk;

export type PlacesData = {
  asks: PlaceAsk[];
  /** The live landmarks, in the list's order (by the list's word, then name). */
  landmarks: LandmarkRow[];
};

/** One word per kind on the list (Review 13 #3): a waterway is a River, an establishment a Camp. */
const LIST_WORD: Partial<Record<LandmarkKind, string>> = {
  waterway: 'River',
  establishment: 'Camp',
};

export function kindWord(kind: LandmarkKind): string {
  return LIST_WORD[kind] ?? LANDMARK_KIND_LABELS[kind];
}

/** Only water named as a place can become a bay: a bay, a narrows, or Other (D202). */
export const PROMOTABLE: ReadonlySet<LandmarkKind> = new Set(['bay', 'narrows', 'other']);

/** A catalog written out where it is the subject. */
export const CATALOG_NAMES: Readonly<Record<string, string>> = {
  OSM: 'OpenStreetMap',
  GNIS: 'USGS Geographic Names',
};

/** `osm:way/123` → `{ catalog: 'OSM', id: 'way/123' }`; anything unprefixed keeps its words. */
export function parseExternalId(raw: string): { catalog: string; id: string } {
  const at = raw.indexOf(':');
  if (at <= 0) return { catalog: '', id: raw };
  return { catalog: raw.slice(0, at).toUpperCase(), id: raw.slice(at + 1) };
}

/** The editor's row as `landmarks.listForEditor` returns it, trimmed to what the tab reads. */
export type EditorLandmarkInput = {
  _id: string;
  name: string;
  kind: LandmarkKind;
  point: LatLng;
  aliases: readonly string[];
  source: string;
  externalIds: readonly string[];
  subAreaId?: string;
  areaSqM?: number;
  removedAt?: number;
};

/** The live landmarks, ready for the list and the card: removed ones stay out of the default view. */
export function landmarkRows(
  rows: readonly EditorLandmarkInput[],
  bayNames: ReadonlyMap<string, string> | null,
): LandmarkRow[] {
  return rows
    .filter((r) => r.removedAt === undefined)
    .map((r) => {
      const ids = r.externalIds.map(parseExternalId);
      const fromIds = [...new Set(ids.map((i) => i.catalog).filter((c) => c !== ''))];
      return {
        id: r._id,
        name: r.name,
        kind: r.kind,
        point: r.point,
        aliases: [...r.aliases],
        // A row the community or a moderator added has no catalog id: its source is its word.
        catalogs: fromIds.length > 0 ? fromIds : [r.source.toUpperCase()],
        ids,
        bay: r.subAreaId !== undefined ? (bayNames?.get(r.subAreaId) ?? null) : null,
        areaSqM: r.areaSqM ?? null,
        added: null,
      };
    })
    .sort(
      (a, b) => kindWord(a.kind).localeCompare(kindWord(b.kind)) || a.name.localeCompare(b.name),
    );
}

/** The asks, the community's names first (most-mentioned first), then the skaters' proposals. */
export function placeAsks(
  names: ReadonlyArray<{ _id: string; name: string; messages: number; alreadyNamed?: boolean }>,
  proposals: ReadonlyArray<{
    requestId: string;
    name: string;
    coord: LatLng;
    askers: number;
    existingLandmarkId?: string;
    similarLandmark?: { landmarkId: string; name: string; point: LatLng; meters: number };
  }>,
): PlaceAsk[] {
  return [
    ...[...names]
      .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name))
      .map(
        (n): PlaceNameAsk => ({
          kind: 'place-name',
          id: n._id,
          name: n.name,
          messages: n.messages,
          alreadyNamed: n.alreadyNamed === true,
        }),
      ),
    ...proposals.map(
      (p): ProposalAsk => ({
        kind: 'proposal',
        id: p.requestId,
        name: p.name,
        point: p.coord,
        askers: p.askers,
        asker: null,
        existingLandmarkId: p.existingLandmarkId ?? null,
        similar: p.similarLandmark ?? null,
      }),
    ),
  ];
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The ask's kicker: what kind of ask, and how many asked ("Place name · 12 emails"). */
export function askKicker(ask: PlaceAsk): string {
  return ask.kind === 'place-name'
    ? `Place name · ${plural(ask.messages, 'email', 'emails')}`
    : `Proposal · ${plural(ask.askers, 'skater', 'skaters')}`;
}

const METERS_PER_MILE = 1609.344;

/** A distance as the boards say it: tenths of a mile, or feet under a tenth. */
export function formatDistance(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles >= 0.095) return `${miles.toFixed(1)} mi`;
  return `${Math.round(meters * 3.28084).toLocaleString('en-US')} ft`;
}

/** A point as the card writes it: four decimals, a real minus sign. */
export function formatPoint(p: LatLng): string {
  const f = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(4)}` : v.toFixed(4));
  return `${f(p.lat)}, ${f(p.lng)}`;
}

/** Square meters to acres, one decimal. */
export function acres(sqm: number): string {
  return (sqm / 4046.8564224).toFixed(1);
}

/** The lit-item ids Places answers to. */
export const litId = {
  landmark: (id: string) => `landmark:${id}`,
  ask: (id: string) => `ask:${id}`,
};

/** The landmark a lit id selects, when it is one of the live ones. */
export function selectedLandmark(data: PlacesData | undefined, lit: string | null) {
  if (data === undefined || lit === null || !lit.startsWith('landmark:')) return null;
  const id = lit.slice('landmark:'.length);
  return data.landmarks.find((l) => l.id === id) ?? null;
}

/** What Places asks the map to draw. */
export function placesMapDrawing(
  data: PlacesData,
  lit: string | null,
  hovered: string | null = null,
): PlacesMapDrawing {
  const points: PlacesMapPoint[] = [
    ...data.landmarks.map(
      (l): PlacesMapPoint => ({
        id: litId.landmark(l.id),
        mark: 'landmark',
        kind: l.kind,
        at: l.point,
        label: l.name,
        slug: [kindWord(l.kind).toUpperCase(), ...l.catalogs].join(' · '),
        lit: lit === litId.landmark(l.id),
        hovered: hovered === litId.landmark(l.id),
      }),
    ),
    ...data.asks.flatMap((a): PlacesMapPoint[] =>
      a.kind === 'proposal'
        ? [
            {
              id: litId.ask(a.id),
              mark: 'proposal',
              at: a.point,
              label: a.name,
              lit: lit === litId.ask(a.id),
              hovered: hovered === litId.ask(a.id),
            },
          ]
        : [],
    ),
  ];
  const onMap = (id: string | null) => (id !== null && points.some((p) => p.id === id) ? id : null);
  return {
    points,
    key: points.some((p) => p.mark === 'proposal')
      ? [{ mark: 'proposal', label: 'Proposed by a skater' }]
      : [],
    lit: onMap(lit),
    hovered: onMap(hovered),
  };
}
