import {
  type ClaimSource,
  STATE_NAMES,
  WATER_BODY_CLASS_LABELS,
  WATER_BODY_CLASSES,
  type WaterBodyClass,
} from '@skating/core';

import type { BodyMapScene, LngLat, MapItem } from '../../map/mapDescriptors';

type LatLng = { lat: number; lng: number };

/**
 * The Names tab's data, from the body's record: the name ladder (every catalog's spelling, the
 * one displayed wearing Now), the aliases, the class with each catalog's answer, and where the body
 * is. Pure — the tab's view and its map drawing both read what this returns.
 *
 * `null` anywhere means *not recorded* — drawn as absent, never as zero or "none".
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

/** A town line crossing the body, as the boundary read returns it. */
export type TownLine = { id: string; path: LatLng[]; faces: [string, string] };

export type Place = {
  towns: string[] | null;
  county: string | null;
  /** The two-letter state code. */
  state: string | null;
  /** The boundary lines that cross the map's view of the body, `null` until a read serves them. */
  townLines: TownLine[] | null;
};

export type NamesData = {
  name: string;
  /** The catalogs' spellings, ranked. Empty for a body no catalog named. */
  rungs: NameRung[];
  /** No catalog names this body: the name is the community's, typed by a moderator. */
  community: boolean;
  /** A moderator chose the displayed name over the catalogs' ranking. */
  overridden: boolean;
  /** Names skaters use that the body doesn't display. */
  aliases: string[];
  cls: WaterBodyClass;
  /** Each catalog's answer; `null` until the claims are read. Always holds the current class. */
  classOptions: ClassOption[] | null;
  place: Place;
};

/** What the model reads off the body's record. */
export type NamesBody = {
  name: string;
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

export function namesFromBody(
  body: NamesBody,
  extras: { classOptions?: ClassOption[] | null; place?: Partial<Place> } = {},
): NamesData {
  const rungs = nameRungs(body.name, body.nameClaims);
  const overridden = (body.nameClaims ?? []).some(
    (c) => c.source === 'user' && same(c.value, body.name),
  );
  const options = extras.classOptions ?? null;
  return {
    name: body.name,
    rungs,
    community: rungs.length === 0,
    overridden,
    aliases: aliasesOf(body.name, body.nameClaims),
    cls: body.type,
    classOptions: options === null ? null : withCurrentClass(options, body.type),
    place: {
      towns: extras.place?.towns ?? null,
      county: extras.place?.county ?? null,
      // One state is a fact the record holds; a body across a state line names its first.
      state: extras.place?.state ?? body.states?.[0] ?? null,
      townLines: extras.place?.townLines ?? null,
    },
  };
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

/**
 * Where a line's two towns are named: facing each other across the middle of its longest run, each
 * {@link TOWN_NAME_OFFSET_M} off the line, the text along the run (degrees clockwise from east,
 * turned to read left to right). The first town is on the run's left (its north or west side).
 */
export function townNames(
  path: readonly LatLng[],
): { left: LngLat; right: LngLat; angle: number } | null {
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
  if (best === null || bestLen === 0) return null;
  const [a, b] = best;
  // Measured at the run's middle, so the run reads the same whichever end it was drawn from.
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  // East and north in meters along the run, then its angle on screen (y down: clockwise from east).
  let dx = (b.lng - a.lng) * cos;
  let dy = b.lat - a.lat;
  if (dx < 0) {
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
