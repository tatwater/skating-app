import {
  type ClaimSource,
  STATE_NAMES,
  WATER_BODY_CLASS_LABELS,
  WATER_BODY_CLASSES,
  type WaterBodyClass,
} from '@skating/core';
import { isFailed, type Loadable, readState } from '@/components/admin/reads/consoleReads';
import { NAMES_READ_PARTS } from '../../consoleWords';
import { NOT_COMPUTED } from '../../frame/bodyModel';
import type { BodyMapScene, LngLat, MapItem } from '../../map/mapDescriptors';

type LatLng = { lat: number; lng: number };

/**
 * The Names tab's data, from the body's record and the boundaries it lies in: the name ladder (each
 * spelling the catalogs gave, the one displayed wearing Now), the aliases, the class with each
 * catalog's answer, and where the body is. Pure — the tab's view and its map drawing both read
 * what this returns.
 *
 * `null` anywhere means *not recorded* — said so, never zero or "none". A part read on its own is
 * in its read's state ({@link Loaded}).
 */

/** A catalog written out where it is the subject (Review 12 #7); its caps tag everywhere else. */
export const CATALOG_NAMES: Readonly<Record<ClaimSource, string>> = {
  gnis: 'USGS Geographic Names',
  nhd: 'National Hydrography Dataset',
  '3dhp': '3D Hydrography Program',
  osm: 'OpenStreetMap',
  name: 'Read from the name',
  user: 'Named by a moderator',
};

/** The caps tag a catalog wears after a value it vouches for (Review 11 #2). */
export const CATALOG_TAGS: Readonly<Record<ClaimSource, string>> = {
  gnis: 'GNIS',
  nhd: 'NHD',
  '3dhp': '3DHP',
  osm: 'OSM',
  name: 'NAME',
  user: 'MOD',
};

/** One spelling on the ladder, with every catalog that spelled it so. */
export type NameRung = {
  value: string;
  /** Every catalog that gave this spelling, most authoritative first. */
  sources: ClaimSource[];
  /** The spelling the body displays. */
  now: boolean;
};

/** One catalog's answer to "what kind of water is this", for the class choice. */
export type ClassOption = {
  cls: WaterBodyClass;
  /** The catalogs that say so, as caps tags. */
  sources: string[];
  /** A catalog's own code for it, when that is what it said ("fcode 390"). */
  note?: string;
};

/**
 * `bodyConsole.townLines`' answer: each town the body lies in with its state and its boundary's
 * stored outline (`ring`, ≤96 points; `null` while not stored). `null` until the places are computed.
 */
export type TownLinesRead = {
  towns: { name: string; state: string | null; ring: number[][] | null }[];
  capped: boolean;
  computedAt: number;
} | null;

/** The body's extent, `[minLng, minLat, maxLng, maxLat]`. */
export type Extent = readonly [number, number, number, number];

/**
 * **The town lines near the body, from each town's outline.** The read gives each town's own ring,
 * not the borders between towns, so each ring is drawn where it passes the body's view (the extent
 * grown by its own size on each side) and named on its inside only: where two towns meet, the two
 * rings run side by side, each naming its own town — the board's line with a town either side. A
 * town whose outline isn't stored draws nothing (`missing` counts it, for the tab to say).
 */
export function townLinesFrom(
  read: TownLinesRead,
  extent: Extent | null,
): { lines: TownLine[]; missing: number } {
  if (read === null) return { lines: [], missing: 0 };
  const view =
    extent === null
      ? null
      : (() => {
          const [w, s, e, n] = extent;
          const dx = e - w;
          const dy = n - s;
          return [w - dx, s - dy, e + dx, n + dy] as const;
        })();
  const near = (a: LatLng, b: LatLng) =>
    view === null ||
    (Math.max(a.lng, b.lng) >= view[0] &&
      Math.min(a.lng, b.lng) <= view[2] &&
      Math.max(a.lat, b.lat) >= view[1] &&
      Math.min(a.lat, b.lat) <= view[3]);
  const lines: TownLine[] = [];
  let missing = 0;
  for (const town of read.towns) {
    if (town.ring === null || town.ring.length < 2) {
      missing += 1;
      continue;
    }
    const ring = town.ring.map(([lng, lat]) => ({ lng: lng ?? 0, lat: lat ?? 0 }));
    // Counter-clockwise (positive area) keeps the inside on a run's left as drawn.
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as LatLng;
      const b = ring[(i + 1) % ring.length] as LatLng;
      twice += a.lng * b.lat - b.lng * a.lat;
    }
    const ccw = twice > 0;
    const runs: LatLng[][] = [];
    let run: LatLng[] = [];
    const flush = () => {
      if (run.length >= 2) runs.push(run);
      run = [];
    };
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1] as LatLng;
      const b = ring[i] as LatLng;
      if (near(a, b)) {
        if (run.length === 0) run.push(a);
        run.push(b);
      } else flush();
    }
    // A closed ring's start is an arbitrary vertex: a stretch near the body that runs through it
    // (still going at the ring's end, and from its start) is one line with one name, never two.
    const first = runs[0];
    if (
      run.length >= 2 &&
      first !== undefined &&
      first[0] === ring[0] &&
      sameAt(ring[0], ring[ring.length - 1])
    ) {
      runs[0] = [...run, ...first.slice(1)];
      run = [];
    }
    flush();
    runs.forEach((path, n) => {
      const id = `${town.name}|${town.state ?? ''}|${n}`;
      lines.push({ id, path, faces: facesOf(path, ccw, town.name) });
    });
  }
  return { lines, missing };
}

/** The same point (a closed ring repeats its first vertex last). */
const sameAt = (a: LatLng | undefined, b: LatLng | undefined): boolean =>
  a !== undefined && b !== undefined && a.lat === b.lat && a.lng === b.lng;

/**
 * Which side of a run its town is on, as {@link townNames} names the sides: the run's longest
 * segment read west to east, its left (north) first.
 */
function facesOf(run: LatLng[], ccw: boolean, name: string): [string, string] {
  // The same segment `townNames` names the sides across.
  const best = longestRun(run);
  if (best === null) return [name, ''];
  const [a, b] = best;
  const flipped = b.lng - a.lng < 0 || (b.lng === a.lng && b.lat - a.lat < 0);
  // Inside is on the drawn run's left for a counter-clockwise ring; reading it the other way round
  // swaps the sides.
  return ccw !== flipped ? [name, ''] : ['', name];
}

/** A town line crossing the body, as the boundary read returns it. */
export type TownLine = { id: string; path: LatLng[]; faces: [string, string] };

/** The towns and counties a body lies in, from the boundaries (`bodyConsole.places`). */
export type AdminPlaces = { towns: string[]; counties: string[] };

export type Place = {
  /**
   * The towns and county, in their read's state; *not computed yet* until the body's geometry is
   * (`computedAt` unset). Computed, empty lists say the body is in no town or county.
   */
  admin: Loadable<AdminPlaces | typeof NOT_COMPUTED>;
  /** The states the record says the body is in, as two-letter codes; empty when it says none. */
  states: string[];
  /** The boundary lines that cross the map's view of the body, `null` until a read serves them. */
  townLines: TownLine[] | null;
  /**
   * What the map's town lines leave out, said under the towns: towns whose outline isn't stored
   * yet, and towns past what one read returns. Absent when nothing is left out.
   */
  townLinesShort?: { unstored: number; capped: boolean };
};

/**
 * The Names tab's data. **What its reads return and the tab doesn't keep, and why**:
 * - `bodyConsole.places`: `counties` past the first, read at the interior point only (a body rarely
 *   spans two), and `states`, since the record's own states are what the location shows.
 * - `waterBodies.get`: everything but the name, the class, the name claims and the states is the
 *   frame's or another tab's.
 */
export type NamesData = {
  name: string;
  /** The catalogs' spellings, ranked. Empty for a body no catalog named. */
  rungs: NameRung[];
  /**
   * No catalog names this body, and it is nameless or named only by a moderator: the name is the
   * community's, typed — the server's own rule for a typed name. A body with a name and no claim at
   * all (one a skater drew) is not: its name stays where its author put it, drawn as it stands.
   */
  community: boolean;
  /** A moderator chose the displayed name over the catalogs' ranking. */
  overridden: boolean;
  /** Names skaters use that the body doesn't display: the moderator's, once that read lands. */
  aliases: string[];
  /** The aliases above are the moderator's own list (`bodyConsole.identity`), the one an edit writes. */
  aliasesEditable?: boolean;
  /** That read failed (said in `failures`): the editor isn't on its way, so it holds no place. */
  aliasesFailed?: boolean;
  /** A moderator set the class over the catalogs' (`moderatorClass`); `null` the import's. */
  moderatorClass?: WaterBodyClass | null;
  /** The class a clear would put back (`bodyConsole.identity`); `null` when the read can't say. */
  baseClass?: WaterBodyClass | null;
  cls: WaterBodyClass;
  /** Each catalog's answer; `null` until the claims are stored. Always holds the current class. */
  classOptions: ClassOption[] | null;
  /**
   * Whether every catalog's own name claim is kept, the ones that spelled it alike included. The
   * import keeps one source per spelling, so this is `null` (not recorded) until the ETL keeps them
   * all — until then a rung names the most authoritative catalog that gave its spelling, and no
   * other; `kept` once the ladder is whole (the board's).
   */
  perCatalogClaims: 'kept' | null;
  place: Place;
  /** What couldn't be read, in words ("the towns and county"). */
  failures: string[];
};

/** What the model reads off the body's record. */
export type NamesBody = {
  name: string;
  /** Its extent, for the town lines near it. */
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  type: WaterBodyClass;
  nameClaims?: ReadonlyArray<{ source: ClaimSource; value: string }>;
  states?: readonly string[];
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The ladder, one rung per distinct spelling the catalogs gave, in the order they were stored —
 * authority order, so the first source on a rung is the one that vouches most. A moderator's own
 * claim is not a rung: it is the override, and it says which rung is Now.
 */
export function nameRungs(name: string, claims: NamesBody['nameClaims']): NameRung[] {
  const rungs: NameRung[] = [];
  for (const claim of claims ?? []) {
    if (claim.source === 'user') continue;
    const value = claim.value.trim();
    if (value === '') continue;
    const rung = rungs.find((r) => same(r.value, value));
    if (rung) {
      if (!rung.sources.includes(claim.source)) rung.sources.push(claim.source);
    } else {
      rungs.push({ value, sources: [claim.source], now: same(value, name) });
    }
  }
  return rungs;
}

/**
 * The aliases: a moderator's names for the body that it doesn't display. (A moderator's claim that
 * matches the displayed name is the override, not an alias; the catalogs' other spellings are
 * rungs.)
 */
export function aliasesOf(name: string, claims: NamesBody['nameClaims']): string[] {
  const out: string[] = [];
  for (const claim of claims ?? []) {
    if (claim.source !== 'user' || same(claim.value, name)) continue;
    if (!out.some((a) => same(a, claim.value))) out.push(claim.value.trim());
  }
  return out;
}

/**
 * `bodyConsole.places`' answer: the towns, counties and states sampled, and when; `null` until the
 * body's geometry is computed (never "in no boundary", which is empty lists).
 */
export type PlacesInput = {
  towns: string[];
  counties: string[];
  states: string[];
  computedAt: number;
} | null;

export function namesFromBody(
  body: NamesBody,
  // Required, never defaulted: a default would read a boundary read still loading as landed.
  places: Loadable<PlacesInput>,
  extras: {
    classOptions?: ClassOption[] | null;
    townLines?: TownLine[] | null;
    /** `bodyConsole.townLines`: drawn into `townLines`, near the body's extent, when given. */
    townLinesRead?: Loadable<TownLinesRead>;
    /** `bodyConsole.identity`: the moderator's aliases and class (the aliases are what's edited). */
    identity?: Loadable<NamesIdentity>;
  } = {},
): NamesData {
  const identity =
    extras.identity === undefined || isFailed(extras.identity) ? null : extras.identity;
  const rungs = nameRungs(body.name, body.nameClaims);
  const claims = body.nameClaims ?? [];
  const overridden = claims.some((c) => c.source === 'user' && same(c.value, body.name));
  const options =
    extras.classOptions ?? (identity === null ? null : classOptionsOf(identity.classClaims));
  return {
    name: body.name,
    rungs,
    // `setWaterBodyName`'s rule: no catalog claim, and nameless or named by a moderator's claim.
    community: rungs.length === 0 && (body.name === '' || claims.some((c) => c.source === 'user')),
    overridden,
    // The moderator's aliases are the list the editor writes (`setAliases`); until that read lands,
    // the catalogs' other spellings are shown as they stand.
    aliases: identity === null ? aliasesOf(body.name, body.nameClaims) : identity.moderatorAliases,
    aliasesEditable: identity !== null,
    ...(extras.identity !== undefined && isFailed(extras.identity) && { aliasesFailed: true }),
    moderatorClass: identity?.moderatorClass ?? null,
    baseClass: identity?.baseClass ?? null,
    cls: body.type,
    classOptions: options === null ? null : withCurrentClass(options, body.type),
    perCatalogClaims: null,
    place: {
      admin: adminOf(places),
      // The record's states; a body across a state line names each.
      states: [...(body.states ?? [])],
      ...townLinesPart({
        ...extras,
        extent:
          body.bbox === undefined
            ? null
            : [body.bbox.minLng, body.bbox.minLat, body.bbox.maxLng, body.bbox.maxLat],
      }),
    },
    failures: [
      ...(isFailed(places) ? ['the towns and county'] : []),
      ...(extras.identity !== undefined && isFailed(extras.identity)
        ? [NAMES_READ_PARTS.identity]
        : []),
      ...(extras.townLinesRead !== undefined && isFailed(extras.townLinesRead)
        ? [NAMES_READ_PARTS.townLines]
        : []),
    ],
  };
}

/** The map's town lines and what they leave out, from the read when one is given. */
function townLinesPart(extras: {
  townLines?: TownLine[] | null;
  townLinesRead?: Loadable<TownLinesRead>;
  extent?: Extent | null;
}): Pick<Place, 'townLines' | 'townLinesShort'> {
  // The read's own answers, apart (`readState`): on its way or failed draws no lines (`null`; a
  // failure is in the tab's note); settled with the places not computed is no lines at all (`[]`).
  const read = readState(extras.townLinesRead);
  if (read.kind === 'none') return { townLines: [] };
  if (read.kind !== 'value') return { townLines: extras.townLines ?? null };
  const got = read.value;
  const { lines, missing } = townLinesFrom(got, extras.extent ?? null);
  return {
    townLines: lines,
    ...((missing > 0 || got.capped) && {
      townLinesShort: { unstored: missing, capped: got.capped },
    }),
  };
}

/** `bodyConsole.identity`'s answer. */
export type NamesIdentity = {
  bodyClass: WaterBodyClass;
  /** Each catalog's class, `null` until the import stores them (a body's next campaign). */
  classClaims: { source: string; value: WaterBodyClass }[] | null;
  moderatorClass: WaterBodyClass | null;
  /** The class a clear would put back; `null` when the record can't say without its history. */
  baseClass?: WaterBodyClass | null;
  moderatorAliases: string[];
};

/** The class claims as options: each class with the catalogs that say so; `null` not recorded. */
export function classOptionsOf(claims: NamesIdentity['classClaims']): ClassOption[] | null {
  if (claims === null) return null;
  const by = new Map<WaterBodyClass, string[]>();
  // Each catalog's caps tag, as the name ladder wears it (`CATALOG_TAGS`); an unknown one as given.
  const tag = (s: string) => CATALOG_TAGS[s as ClaimSource] ?? s.toUpperCase();
  for (const c of claims) by.set(c.value, [...(by.get(c.value) ?? []), tag(c.source)]);
  return [...by].map(([cls, sources]) => ({ cls, sources }));
}

/**
 * The towns and counties from the boundary read — every town the outline reaches into, and each of
 * their counties (a border lake spans several). Not computed yet until the geometry is.
 */
export function adminOf(
  places: Loadable<PlacesInput>,
): Loadable<AdminPlaces | typeof NOT_COMPUTED> {
  if (places === undefined || isFailed(places)) return places;
  if (places === null) return NOT_COMPUTED;
  return { towns: [...places.towns], counties: [...places.counties] };
}

/** The displayed name a moderator chose over the ranking, or `null` for the catalogs' ranking. */
export const nameChoice = (data: NamesData): string | null => (data.overridden ? data.name : null);

/** The moderator's class over the catalogs', or `null` for the catalogs' own. */
export const classChoice = (data: NamesData): WaterBodyClass | null => data.moderatorClass ?? null;

/**
 * **The tab's data with its latest presses shown** (`useLatestPick`), before the server answers:
 * the name chosen (`null`, the catalogs' ranking — its first rung, as `setWaterBodyName` puts back)
 * wears Now, and the class chosen (`null`, the class a clear puts back, when the read says which) is
 * the checked one. A pick the server already holds changes nothing, and the data keeps its identity.
 */
export function namesWithPicks(
  data: NamesData,
  picks: { name: string | null; cls: WaterBodyClass | null },
): NamesData {
  let out = data;
  if (picks.name !== nameChoice(data)) {
    const name = picks.name ?? data.rungs[0]?.value ?? data.name;
    out = {
      ...out,
      name,
      overridden: picks.name !== null,
      rungs: data.rungs.map((r) => ({ ...r, now: same(r.value, name) })),
    };
  }
  if (picks.cls !== classChoice(data)) {
    // A clear whose class the read can't say keeps the record's until the server answers.
    const cls = picks.cls ?? data.baseClass ?? data.cls;
    out = {
      ...out,
      cls,
      moderatorClass: picks.cls,
      classOptions: data.classOptions === null ? null : withCurrentClass(data.classOptions, cls),
    };
  }
  return out;
}

/** The class options with the current class among them, so Now always has a row to sit on. */
function withCurrentClass(options: ClassOption[], cls: WaterBodyClass): ClassOption[] {
  return options.some((o) => o.cls === cls) ? options : [{ cls, sources: [] }, ...options];
}

/** The classes the "Another class" menu offers: every class the options don't already hold. */
export function otherClasses(options: readonly ClassOption[] | null, cls: WaterBodyClass) {
  const shown = new Set<WaterBodyClass>(options?.map((o) => o.cls) ?? [cls]);
  return WATER_BODY_CLASSES.filter((c) => !shown.has(c));
}

export const classLabel = (cls: WaterBodyClass) => WATER_BODY_CLASS_LABELS[cls];

/** A state's name from its code; the code itself when it isn't one of the corpus's states. */
export function stateName(code: string): string {
  return STATE_NAMES[code] ?? code;
}

/** The country a corpus state is in. Every state the corpus loads is a US state. */
export function countryOf(code: string | null): string | null {
  if (code === null) return null;
  return code in STATE_NAMES ? 'United States' : null;
}

/**
 * The lit-item ids Names answers to, in `?lit=`'s grammar (a lower-camel kind, a colon, an id of
 * word characters): a rung or an alias by its place in its list, a class by its key, a town line by
 * its id.
 */
export const litId = {
  name: (index: number) => `name:${index}`,
  alias: (index: number) => `alias:${index}`,
  cls: (cls: WaterBodyClass) => `class:${cls}`,
  townLine: (id: string) => `townLine:${id}`,
};

/** How far each town's name sits off its line, either side: about a block, in meters. */
export const TOWN_NAME_OFFSET_M = 140;

const M_PER_DEG = 111_320;

/** A path's longest segment on the ground (east–west shrunk by latitude); `null` for none. */
function longestRun(path: readonly LatLng[]): [LatLng, LatLng] | null {
  let best: [LatLng, LatLng] | null = null;
  let bestLen = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as LatLng;
    const b = path[i] as LatLng;
    const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const len = Math.hypot((b.lng - a.lng) * cos, b.lat - a.lat);
    if (len > bestLen) {
      bestLen = len;
      best = [a, b];
    }
  }
  return best;
}

/**
 * Where a line's two towns are named: facing each other across the middle of its longest run, each
 * {@link TOWN_NAME_OFFSET_M} off the line, the text along the run (degrees clockwise from east,
 * turned to read left to right). The first town is on the run's left (its north or west side).
 */
export function townNames(
  path: readonly LatLng[],
): { left: LngLat; right: LngLat; angle: number } | null {
  const best = longestRun(path);
  if (best === null) return null;
  const [a, b] = best;
  // Measured at the run's middle, so the run reads the same whichever end it was drawn from.
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  // East and north in meters along the run, then its angle on screen (y down: clockwise from east).
  let dx = (b.lng - a.lng) * cos;
  let dy = b.lat - a.lat;
  // Read west to east — and a due north–south run south to north, so its left is its west side
  // and it reads the same whichever end it was drawn from.
  if (dx < 0 || (dx === 0 && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  const angle = (-Math.atan2(dy, dx) * 180) / Math.PI;
  const norm = Math.hypot(dx, dy);
  // The left-hand normal of a run read west to east points north.
  const nx = -dy / norm;
  const ny = dx / norm;
  const off = TOWN_NAME_OFFSET_M / M_PER_DEG;
  const mid = { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
  return {
    left: [mid.lng + (nx * off) / cos, mid.lat + ny * off],
    right: [mid.lng - (nx * off) / cos, mid.lat - ny * off],
    angle,
  };
}

/**
 * What Names asks the map to draw beyond the frame's own: each town line that crosses the body,
 * with its two towns named either side. A lit row that isn't on the map lights nothing there.
 */
export function namesMapScene(data: NamesData, lit: string | null): BodyMapScene {
  const items: MapItem[] = [];
  for (const line of data.place.townLines ?? []) {
    const id = litId.townLine(line.id);
    items.push({
      kind: 'line',
      id,
      layer: 'outline',
      style: 'townLine',
      path: line.path.map((p) => [p.lng, p.lat] as const),
    });
    const names = townNames(line.path);
    if (names === null) continue;
    for (const [side, at, text] of [
      ['l', names.left, line.faces[0]],
      ['r', names.right, line.faces[1]],
    ] as const) {
      // A side no town is named on (a town's own outline names its inside only).
      if (text === '') continue;
      items.push({
        kind: 'label',
        id: `townName:${line.id}.${side}`,
        layer: 'outline',
        at,
        text,
        style: 'town',
        angle: names.angle,
      });
    }
  }
  return { items, lit: lit !== null && items.some((i) => i.id === lit) ? lit : null };
}
