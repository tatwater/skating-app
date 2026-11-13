import {
  type ClaimSource,
  STATE_NAMES,
  WATER_BODY_CLASS_LABELS,
  WATER_BODY_CLASSES,
  type WaterBodyClass,
} from '@skating/core';

import type { LatLng, NamesMapDrawing } from './namesMap';

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

/** What Names asks the map to draw: the town lines and, when there are any, their key. */
export function namesMapDrawing(data: NamesData, lit: string | null): NamesMapDrawing {
  const lines = (data.place.townLines ?? []).map((l) => ({
    id: `town-line:${l.id}`,
    style: 'town-line' as const,
    path: l.path,
    faces: l.faces,
    lit: lit === `town-line:${l.id}`,
  }));
  return {
    lines,
    key: lines.length > 0 ? [{ mark: 'town-line', label: 'Town line', tag: 'TIGER' }] : [],
    lit: lines.some((l) => l.lit) ? lit : null,
  };
}

/** The lit-item ids this tab answers to: `name:<value>`, `alias:<value>`, `class:<cls>`. */
export const litId = {
  name: (value: string) => `name:${value}`,
  alias: (value: string) => `alias:${value}`,
  cls: (cls: WaterBodyClass) => `class:${cls}`,
};
