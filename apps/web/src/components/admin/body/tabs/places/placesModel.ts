import { LANDMARK_KIND_LABELS, type LandmarkKind } from '@skating/core';
import {
  isFailed,
  type Loadable,
  mapLoadable,
  retryAll,
} from '@/components/admin/reads/consoleReads';
import type { BodyMapScene, MapItem } from '../../map/mapDescriptors';
import { PLACE_NAMES_READ_CAP } from '../../readCaps';

type LatLng = { lat: number; lng: number };

/**
 * The Places tab's data: what is asked of the body's places (the community's email names and the
 * skaters' proposals) and its landmarks — and, for the one selected, what its card shows. Pure.
 * Each part is a read's state ({@link Loaded}: loading, failed, or its value); `null` in a value
 * means *not recorded*.
 */

/** A person as a lockup names them: their real name, the handle as the link to their page. */
export type Person = { name: string; handle: string; href?: string };

/** When a landmark was added, and by whom or by what. */
export type Added = { at: number; by: Person | string };

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
  /** The bay it falls in, by name; `null` when it is in none. */
  bay: Loadable<string | null>;
  areaSqM: number | null;
  /** When it was added and by whom; `null` when the provenance read doesn't know it. */
  added: Loadable<Added | null>;
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
  /**
   * Who asked first: a person; `erased` for an account since erased; `null` when the askers' read
   * holds no row for this ask — it covers the same proposals as the proposals' read (the newest
   * 200), so that is a requester not on record: *Not recorded yet*; `hidden` for a viewer who can't
   * see who asks (no `inbox.read`) — drawn as nothing at all; loading or failed as a read.
   */
  asker: Asker;
  /** The landmark already on the map under that name, at that place. */
  existingLandmarkId: string | null;
  /** A live landmark it may be, near it under one of its names. */
  similar: { landmarkId: string; name: string; point: LatLng; meters: number } | null;
};

export type Asker = Loadable<Person | 'erased' | null> | 'hidden';

export type PlaceAsk = PlaceNameAsk | ProposalAsk;

export type PlacesData = {
  asks: Loadable<PlaceAsk[]>;
  /** More is asked than the reads returned: the asks' count is a floor. */
  asksCapped: boolean;
  /** The live landmarks, in the list's order (by the list's word, then name). */
  landmarks: Loadable<LandmarkRow[]>;
  /** What couldn't be read, in words ("the landmarks", "who asked"). */
  failures: string[];
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

/** A read's map, looked up: loading and failed pass through; a missing key is `fallback`. */
function lookUp<V, F>(
  map: Loadable<ReadonlyMap<string, V>>,
  key: string,
  fallback: F,
): Loadable<V | F> {
  if (map === undefined || isFailed(map)) return map;
  return map.get(key) ?? fallback;
}

/** The live landmarks, ready for the list and the card: removed ones stay out of the default view. */
export function landmarkRows(
  rows: readonly EditorLandmarkInput[],
  bayNames: Loadable<ReadonlyMap<string, string>>,
  // Required, never defaulted: a default would turn a read still loading (`undefined`) into one
  // that landed empty.
  added: Loadable<ReadonlyMap<string, Added>>,
): LandmarkRow[] {
  return rows
    .filter((r) => r.removedAt === undefined)
    .map((r): LandmarkRow => {
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
        bay: r.subAreaId !== undefined ? lookUp(bayNames, r.subAreaId, null) : null,
        areaSqM: r.areaSqM ?? null,
        added: lookUp(added, r._id, null),
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
  // Required, never defaulted (a default would read a loading `undefined` as `hidden`).
  askers: Loadable<ReadonlyMap<string, Person | 'erased'>> | 'hidden',
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
        asker: askers === 'hidden' ? 'hidden' : lookUp(askers, p.requestId, null),
        existingLandmarkId: p.existingLandmarkId ?? null,
        similar: p.similarLandmark ?? null,
      }),
    ),
  ];
}

// ── From the reads ───────────────────────────────────────────────────────────────────────────

/** A person as the console's reads return them. */
export type PersonInput = { userId: string; username: string; displayName: string };

/** Where a person's page is, for the handle's link. */
export const personPath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;

/** A person as a lockup names them: the real name (the handle when none), the handle as the link. */
export function personFrom(p: PersonInput): Person {
  return {
    name: p.displayName.trim() || p.username,
    handle: p.username,
    href: personPath(p.userId),
  };
}

/** What added a landmark no person placed, by its source. */
export const ADDED_BY: Readonly<Record<string, string>> = {
  osm: 'By the landmark pass',
  gnis: 'By the landmark pass',
  corpus: 'From the community’s emails',
  proposal: 'From a skater’s proposal',
  moderator: 'By a moderator',
};

/** `bodyConsole.landmarkProvenance`'s row, trimmed to what the card reads. */
export type ProvenanceInput = {
  landmarkId: string;
  source: string;
  createdAt: number;
  createdBy: PersonInput | null;
};

/** When each landmark was added, and by whom: the moderator who placed it, else its source. */
export function addedByLandmark(rows: readonly ProvenanceInput[]): Map<string, Added> {
  return new Map(
    rows.map((r) => [
      r.landmarkId,
      {
        at: r.createdAt,
        by: r.createdBy !== null ? personFrom(r.createdBy) : (ADDED_BY[r.source] ?? r.source),
      },
    ]),
  );
}

/** Who asked for each open landmark, by request: a person, or `erased` for an erased account. */
export function askersByRequest(
  rows: ReadonlyArray<{ requestId: string; requester: PersonInput | null }>,
): Map<string, Person | 'erased'> {
  return new Map(
    rows.map((r) => [r.requestId, r.requester === null ? 'erased' : personFrom(r.requester)]),
  );
}

/** The most open place names `corpusPlaceNames.openForBody` returns: the console's one cap. */
export { PLACE_NAMES_READ_CAP } from '../../readCaps';

/** A read's map, built once it lands; loading and failed pass through (the read layer's own). */
const mapOf = mapLoadable;

/** The Places tab's reads, as they stand. */
export type PlacesReads = {
  landmarks: Loadable<readonly EditorLandmarkInput[]>;
  bays: Loadable<ReadonlyArray<{ _id: string; name: string }>>;
  names: Loadable<Parameters<typeof placeAsks>[0]>;
  proposals: Loadable<{ proposals: Parameters<typeof placeAsks>[1]; more: boolean }>;
  provenance: Loadable<readonly ProvenanceInput[]>;
  /** `hidden` for a viewer who can't see who asks. */
  proposers:
    | Loadable<ReadonlyArray<{ requestId: string; requester: PersonInput | null }>>
    | 'hidden';
};

/** The tab's data from its reads, each part in its read's state. Pure. */
export function placesFrom(r: PlacesReads): PlacesData {
  const failures: string[] = [];
  if (isFailed(r.landmarks)) failures.push('the landmarks');
  if (isFailed(r.names) || isFailed(r.proposals)) failures.push('what is asked');
  if (isFailed(r.bays)) failures.push('the bays');
  if (isFailed(r.provenance)) failures.push('when each landmark was added');
  if (isFailed(r.proposers)) failures.push('who asked');

  const askers =
    r.proposers === 'hidden' ? ('hidden' as const) : mapOf(r.proposers, askersByRequest);
  let asks: Loadable<PlaceAsk[]>;
  if (isFailed(r.names) || isFailed(r.proposals)) {
    asks = retryAll([r.names, r.proposals].filter(isFailed));
  } else if (r.names === undefined || r.proposals === undefined) asks = undefined;
  else asks = placeAsks(r.names, r.proposals.proposals, askers);

  const landmarks =
    r.landmarks === undefined || isFailed(r.landmarks)
      ? r.landmarks
      : landmarkRows(
          r.landmarks,
          mapOf(r.bays, (bays) => new Map(bays.map((b) => [b._id, b.name]))),
          mapOf(r.provenance, addedByLandmark),
        );
  return {
    asks,
    asksCapped:
      (valueOrNull(r.proposals)?.more ?? false) ||
      (valueOrNull(r.names)?.length ?? 0) >= PLACE_NAMES_READ_CAP,
    landmarks,
    failures,
  };
}

const valueOrNull = <T>(read: Loadable<T>): T | null =>
  read === undefined || isFailed(read) ? null : read;

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

/**
 * The lit-item ids Places answers to, in `?lit=`'s grammar and the frame's words: a landmark as
 * the frame's map addresses it, and an ask as the left column's *Asked of this body* links it.
 */
export const litId = {
  landmark: (id: string) => `landmark:${id}`,
  placeName: (id: string) => `placeName:${id}`,
  landmarkAsk: (requestId: string) => `landmarkAsk:${requestId}`,
  ask: (ask: PlaceAsk) =>
    ask.kind === 'place-name' ? `placeName:${ask.id}` : `landmarkAsk:${ask.id}`,
};

/** The rows of a list read that landed; none while it loads or if it failed. */
export function rowsOf<T>(list: Loadable<readonly T[]>): readonly T[] {
  return list === undefined || isFailed(list) ? [] : list;
}

/** The landmark a lit id selects, when it is one of the live ones. */
export function selectedLandmark(data: PlacesData | undefined, lit: string | null) {
  if (data === undefined || lit === null || !lit.startsWith('landmark:')) return null;
  const id = lit.slice('landmark:'.length);
  return rowsOf(data.landmarks).find((l) => l.id === id) ?? null;
}

/**
 * What Places asks the map to draw beyond the frame's own (which draws every live landmark as
 * `landmark:<id>`): each skater's proposal as proposed, a dashed `?` at its point. The lit item is
 * kept when it is on the map — a landmark the frame draws, or a proposal drawn here.
 */
export function placesMapScene(data: PlacesData, lit: string | null): BodyMapScene {
  const items: MapItem[] = rowsOf(data.asks).flatMap((a): MapItem[] =>
    a.kind === 'proposal'
      ? [
          {
            kind: 'point',
            id: litId.landmarkAsk(a.id),
            layer: 'marks',
            at: [a.point.lng, a.point.lat],
            mark: 'proposal',
            name: a.name,
            hoverKicker: 'Proposed by a skater',
          },
        ]
      : [],
  );
  const onMap =
    lit !== null &&
    (items.some((i) => i.id === lit) ||
      rowsOf(data.landmarks).some((l) => litId.landmark(l.id) === lit));
  return { items, lit: onMap ? lit : null };
}
