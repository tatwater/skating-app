/**
 * **Maine's MIDAS → NHD crosswalk** — the find that turns D95's re-key from a guess into a lookup.
 *
 * ## What it is for
 *
 * Maine's 147,755 depth soundings are keyed on **MIDAS**, the state's own lake numbering since the
 * 1960s. Our corpus is keyed on NHD `Permanent_Identifier`. Until now the join between them was
 * geometric — match a sounding cloud to whatever polygon contains it — and D95 records what that
 * cost: nine containment rejects at 39–49%, Caribou Lake matched to Ripogenus at 15.7× the area,
 * Fahi Pond to Mud Pond at 22.3×, and 655 soundings of MIDAS 870 falling outside every body.
 *
 * `MaineDEP_Lakes_Data/MapServer/3` ("MIDAS Waterbodies") publishes **`PERMANENT_` on 5,639 of its
 * 5,831 rows**. So for Maine the join stops being a spatial argument and becomes an id lookup.
 *
 * ## Two traps in the layer itself, both measured (2026-08-09)
 *
 * **1. `PERMID` is not an identifier. It is a copy of `ACRES`.**
 *
 * ```
 * MIDAS 1680  Mud Lake   ACRES 1002.41542566   PERMID "1002.41542566475"
 * ```
 *
 * The name reads exactly like "permanent id" and the column is a *string*, so a join written against
 * it type-checks, runs, and matches nothing — or worse, matches a lake whose acreage happens to
 * collide. The real column is `PERMANENT_`, whose name reads like a truncation artifact and is the
 * one to use. This is the same shape as NH's `meters` column, which is a line *length* sitting next
 * to a `depth`.
 *
 * **2. One MIDAS number is not one lake.** MIDAS 9861 holds both Long Pond (651 ac) and Lewiston
 * Pond (24 ac); Moose Pond publishes five rows, three of them 0.0 acres. So the crosswalk is
 * MIDAS → *many* NHD ids, and a consumer that takes `[0]` will silently key a survey to whichever
 * row the service happened to return first. `crosswalkFor` sorts by area and says when it is
 * guessing.
 *
 * **3. The two catalogues disagree about names, and that is information rather than noise.** MIDAS
 * 1892 is `Harvey Pond` to Maine and `Umsaskis Lake` to GNIS. Both names are carried, because a
 * disagreement is the cheapest available signal that a key spans two bodies (D95 rule 2).
 */

/** One published crosswalk row. */
export interface MidasRow {
  midas: number;
  /** Maine's own name for the lake. */
  lakeName: string;
  /** NHD's `Permanent_Identifier`, where the row carries one. */
  permanentId?: string | undefined;
  /** The federal gazetteer's name, where NHD carries one. Often disagrees with `lakeName`. */
  gnisName?: string | undefined;
  reachCode?: string | undefined;
  acres: number;
}

/** Every NHD body one MIDAS number maps to, largest first. */
export interface MidasEntry {
  midas: number;
  lakeName: string;
  bodies: {
    permanentId: string;
    acres: number;
    lakeName: string;
    gnisName?: string | undefined;
    reachCode?: string | undefined;
  }[];
  /**
   * More than one NHD body carries this MIDAS number — so a survey keyed on it cannot be attributed
   * to a single lake without a second piece of evidence.
   *
   * **Counted and surfaced rather than resolved here.** Which of Long Pond and Lewiston Pond a
   * sounding belongs to is a spatial question, and this file is a lookup table.
   */
  ambiguous: boolean;
  /**
   * Maine's name and the gazetteer's name disagree on the largest body.
   *
   * D95 rule 2's tell: a MIDAS key that spans two bodies usually shows up first as two names.
   */
  nameConflict: boolean;
}

const num = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
};

const str = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s.length === 0 ? undefined : s;
};

/** One ArcGIS feature's attributes → a row, or `undefined` when it carries no MIDAS number. */
export function parseMidasRow(attributes: Record<string, unknown>): MidasRow | undefined {
  const midas = num(attributes.MIDAS_NUM);
  if (midas === undefined) return undefined;
  return {
    midas,
    lakeName: str(attributes.LAKENAME) ?? '',
    // **`PERMANENT_`, never `PERMID`.** See the header: the second is a copy of `ACRES`.
    ...(str(attributes.PERMANENT_) ? { permanentId: str(attributes.PERMANENT_) } : {}),
    ...(str(attributes.GNIS_NAME) ? { gnisName: str(attributes.GNIS_NAME) } : {}),
    ...(str(attributes.REACHCODE) ? { reachCode: str(attributes.REACHCODE) } : {}),
    acres: num(attributes.ACRES) ?? 0,
  };
}

/**
 * Fold rows into one entry per MIDAS number.
 *
 * **Rows with no `PERMANENT_` are dropped from `bodies` but do not remove the MIDAS number**, so a
 * lake Maine knows and NHD does not still appears — with an empty body list, which is the honest
 * statement that the crosswalk cannot answer it. Silently omitting those would make the coverage
 * figure a count of what we could answer over what we could answer.
 */
export function midasCrosswalk(rows: readonly MidasRow[]): Map<number, MidasEntry> {
  const byMidas = new Map<number, MidasEntry>();
  for (const row of rows) {
    let entry = byMidas.get(row.midas);
    if (entry === undefined) {
      entry = {
        midas: row.midas,
        lakeName: row.lakeName,
        bodies: [],
        ambiguous: false,
        nameConflict: false,
      };
      byMidas.set(row.midas, entry);
    }
    if (row.permanentId === undefined) continue;
    entry.bodies.push({
      permanentId: row.permanentId,
      acres: row.acres,
      lakeName: row.lakeName,
      ...(row.gnisName ? { gnisName: row.gnisName } : {}),
      ...(row.reachCode ? { reachCode: row.reachCode } : {}),
    });
  }
  for (const entry of byMidas.values()) {
    // **Largest first, and the zero-acre rows sort last rather than being dropped.** Moose Pond's
    // three 0.0-acre rows are real published records; removing them would make the row count
    // disagree with the service's own, and the count is how a future run notices a republication.
    entry.bodies.sort((a, b) => b.acres - a.acres);
    entry.ambiguous = entry.bodies.length > 1;
    const largest = entry.bodies[0];
    entry.nameConflict =
      largest?.gnisName !== undefined &&
      largest.lakeName.length > 0 &&
      largest.gnisName.toLowerCase() !== largest.lakeName.toLowerCase();
  }
  return byMidas;
}

/**
 * The single NHD body a MIDAS number should key to, plus whether that was a guess.
 *
 * Returns the largest, which is right for the Moose Pond shape (one real polygon and some 0.0-acre
 * residue) and is a **coin toss** for the Long Pond / Lewiston Pond shape. `confident` is the
 * difference, and a caller that ignores it will silently attribute one lake's soundings to another.
 */
export function crosswalkFor(
  crosswalk: ReadonlyMap<number, MidasEntry>,
  midas: number,
): { permanentId: string; confident: boolean } | undefined {
  const entry = crosswalk.get(midas);
  const largest = entry?.bodies[0];
  if (entry === undefined || largest === undefined) return undefined;
  const runnerUp = entry.bodies[1];
  // Confident when there is one body, or when the largest dwarfs everything else — the 0.0-acre
  // residue case. A genuine second lake (Lewiston Pond at 24 ac against Long Pond's 651) is 3.7% of
  // the largest and still real, so the bar is deliberately low.
  const confident = runnerUp === undefined || runnerUp.acres <= largest.acres * 0.01;
  return { permanentId: largest.permanentId, confident };
}

export interface MidasCrosswalkStats {
  rows: number;
  midasNumbers: number;
  withPermanentId: number;
  withoutPermanentId: number;
  ambiguous: number;
  nameConflicts: number;
}

export function crosswalkStats(crosswalk: ReadonlyMap<number, MidasEntry>): MidasCrosswalkStats {
  let withPermanentId = 0;
  let ambiguous = 0;
  let nameConflicts = 0;
  let rows = 0;
  for (const entry of crosswalk.values()) {
    rows += entry.bodies.length;
    if (entry.bodies.length > 0) withPermanentId++;
    if (entry.ambiguous) ambiguous++;
    if (entry.nameConflict) nameConflicts++;
  }
  return {
    rows,
    midasNumbers: crosswalk.size,
    withPermanentId,
    withoutPermanentId: crosswalk.size - withPermanentId,
    ambiguous,
    nameConflicts,
  };
}

/** The layer, and the fields we ask for by name. */
export const MIDAS_SERVICE_URL =
  'https://gis.maine.gov/mapservices/rest/services/dep/MaineDEP_Lakes_Data/MapServer/3';

export const MIDAS_FIELDS = [
  'MIDAS_NUM',
  'LAKENAME',
  'PERMANENT_',
  'GNIS_NAME',
  'REACHCODE',
  'ACRES',
] as const;

/** The service advertises 5,000 and the layer is 5,831, so this pages exactly twice. */
export const MIDAS_PAGE_SIZE = 2000;

export function midasQueryUrl(offset: number, pageSize: number = MIDAS_PAGE_SIZE): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: MIDAS_FIELDS.join(','),
    // No geometry: this is an identifier table. The polygons are NHD's, and we already hold them.
    returnGeometry: 'false',
    orderByFields: 'MIDAS_NUM',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'json',
  });
  return `${MIDAS_SERVICE_URL}/query?${params.toString()}`;
}

/** The archive whose lake keys are MIDAS numbers. Only this lane can use the crosswalk. */
export const MIDAS_SOURCE_KEY = 'me-dep-soundings';

/** Why a lake carries no publisher id. Every one is a real, countable state. */
export type CrosswalkSkip =
  /** Not Maine — no other source keys on MIDAS. */
  | 'not-maine'
  /** `splitByBody` already decided this key holds more than one lake. See below. */
  | 'split-key'
  /** The lake key is not a MIDAS number, so there is nothing to look up. */
  | 'not-numeric'
  /** The crosswalk has no NHD id for this MIDAS number — 192 of 5,803. */
  | 'no-id'
  /** One MIDAS number, two real lakes. Sending either would be a coin toss dressed as an id. */
  | 'ambiguous';

/**
 * The publisher's NHD id for one archived lake, or a named reason there isn't one.
 *
 * ## The split-key rule, which is the subtle one
 *
 * `splitByBody` runs **before** the join and cuts a source key whose measurements fall in two
 * separated clouds into `5271#1`, `5271#2`. By the time this is asked, the geometry has already
 * decided that key holds more than one lake — so a single NHD id is wrong for at least one half, and
 * handing it over would attach the whole survey to whichever half the state happened to name.
 * Refusing is the only answer that cannot be confidently wrong.
 *
 * (It is also why this reads the suffix rather than stripping it: stripping would silently key both
 * halves to the same body, which is the failure this is avoiding, spelled slightly differently.)
 */
export function crosswalkNhdId(
  lake: { sourceKey: string; lakeKey: string },
  crosswalk: ReadonlyMap<number, MidasEntry>,
): { nhdId: string } | { skip: CrosswalkSkip } {
  if (lake.sourceKey !== MIDAS_SOURCE_KEY) return { skip: 'not-maine' };
  if (lake.lakeKey.includes('#')) return { skip: 'split-key' };
  const midas = Number(lake.lakeKey);
  if (!Number.isInteger(midas)) return { skip: 'not-numeric' };
  const resolved = crosswalkFor(crosswalk, midas);
  if (resolved === undefined) return { skip: 'no-id' };
  // `confident` is false when a second real lake shares the number — MIDAS 9861 holds Long Pond
  // (651 ac) and Lewiston Pond (24 ac). See `crosswalkFor`.
  if (!resolved.confident) return { skip: 'ambiguous' };
  return { nhdId: resolved.permanentId };
}

/** Read the archived crosswalk rows into a lookup. Returns an empty map when nothing is archived. */
export function crosswalkFromNdjson(ndjson: string): Map<number, MidasEntry> {
  const rows: MidasRow[] = [];
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    rows.push(JSON.parse(trimmed) as MidasRow);
  }
  return midasCrosswalk(rows);
}
