/**
 * **The summer aerial's records**: the build's manifest (B05 §2.1.3), the date index that ships beside
 * every archive (§2.7, D318), the credit's date range (§4.2), and the one command line the pipeline
 * and the July offer agree on (§3.1, §3.3).
 *
 * PLACEHOLDER (S's): the T0 seam. Every type and constant is final; `parseNaipCellIndex`,
 * `naipIndexUrl`, `naipCreditRange`, `formatNaipCreditRange` and `aerialRebuildCommand` throw until S
 * replaces their bodies.
 */

import type { NaipPickStep, NaipState } from './naipSelection';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The archive's file name ends with this… */
export const NAIP_ARCHIVE_SUFFIX = '.pmtiles';
/** …its date index's with this, in place of the archive's suffix (`naipIndexUrl`)… */
export const NAIP_INDEX_SUFFIX = '-cells.json';
/** …and its manifest's with this. */
export const NAIP_MANIFEST_SUFFIX = '-manifest.json';

// ── The manifest (§2.1.3) ─────────────────────────────────────────────────────────────────────────

export const NAIP_MANIFEST_VERSION = 1;

/** A frame the build may draw (a pick or a fallback), by what the date index and an offer need. */
export interface NaipManifestFrame {
  /** The acquisition day, `YYYY-MM-DD`, from the item's `datetime`. */
  acquired: string;
  /** Meters. */
  gsd: number;
  /** The program year (`naip:year`). */
  year: number;
  /** The labeled state. */
  state: NaipState;
}

/** One quarter-quad's record. */
export interface NaipManifestCell {
  key: string;
  /** Every state whose catalog lists it, sorted. */
  states: NaipState[];
  /** The pick's item id (a key of `NaipManifest.frames`). */
  pick: string;
  step: NaipPickStep;
  /** The fallback stack's item ids in the rule's order, the pick excluded (`NaipCellPick.stack`). */
  stack: string[];
  /** The pick doesn't cover the whole cell, so its fallbacks are warped too (§2.2). */
  partial: boolean;
  /** The pick's thumbnail score (neutral-white share of valid pixels, 0–1); `null`: unscored. */
  cloudScore: number | null;
  /** The work tiles the cell's outline touches (`workTileKey`), sorted. */
  workTiles: string[];
}

/** One unit of work: a z11 slippy tile. */
export interface NaipManifestWorkTile {
  /** `workTileKey`: `11/<x>/<y>`. */
  key: string;
  /**
   * A stable hash of everything that decides the work tile's pixels (its cells' stacks, the rule's
   * version, the tiling's settings). "Landed" is a done record carrying this hash, never presence.
   */
  inputHash: string;
  /** The quarter-quads it touches, sorted. */
  cells: string[];
  /**
   * Cut in this build. `false` only under `--from-current`, for a work tile whose input hash equals
   * the one in `basedOn`'s manifest: the assembler copies its tiles out of that archive instead.
   */
  retile: boolean;
}

/** A published object the manifest names, with its integrity. */
export interface NaipPublishedObject {
  /** The file name (no key prefix), e.g. `naip-summer-20261212.pmtiles`. */
  name: string;
  bytes: number;
  /** Hex SHA-256 of the bytes as uploaded. */
  sha256: string;
}

/** The build's record, written by the select stage and completed by the assembler. */
export interface NaipManifest {
  version: typeof NAIP_MANIFEST_VERSION;
  /** `naip-<YYYYMMDD>`, or `naip-pilot-<YYYYMMDD>` for a pilot. */
  campaign: string;
  /** The pilot's name, or `null` for a production build. */
  pilot: string | null;
  /** When the select stage wrote it, an ISO instant. */
  createdAt: string;
  ruleVersion: number;
  /** The catalog snapshot the rule read. */
  catalog: {
    /** The day it was walked, `YYYY-MM-DD`. */
    walkedOn: string;
    /** Items read, before any drop. */
    items: number;
    /** Items read per labeled state. */
    perState: Partial<Record<NaipState, number>>;
    /** Where the snapshot is archived (`inventoryKey`'s prefix), or `null` when it wasn't (a dry run). */
    archivedAt: string | null;
  };
  /** Hex SHA-256 of the exclusion list the rule ran with. */
  exclusionsHash: string;
  /** The committed off-season cells the rule ran with. */
  offSeasonCells: string[];
  /**
   * The build this one diffs against (`--from-current`), by its archive and manifest names; `null`
   * for a build from nothing, where every work tile is cut.
   */
  basedOn: { archive: string; manifest: string } | null;
  /** Every frame a cell picks or stacks, by item id. */
  frames: Record<string, NaipManifestFrame>;
  /** Every quarter-quad with a pick, sorted by key. */
  cells: NaipManifestCell[];
  /** Every work tile any cell touches, sorted by key. */
  workTiles: NaipManifestWorkTile[];
  /** Added by the assembler, before the manifest is published. */
  archive?: NaipPublishedObject;
  /** Added by the assembler, before the manifest is published. */
  cellIndex?: NaipPublishedObject;
}

// ── The date index (§2.7, D318) ───────────────────────────────────────────────────────────────────

export const NAIP_CELL_INDEX_VERSION = 1;

/** One distinct flight: an acquisition day, a resolution and a labeled state. */
export interface NaipCellIndexFlight {
  /** `YYYY-MM-DD`, the item's acquisition day — never a program year. */
  date: string;
  gsd: number;
  state: NaipState;
}

/**
 * Every tiled cell's flights. `cells[key]` indexes `flights`: the pick's flight first, then any other
 * flight that supplies at least one pixel to the cell, most pixels first. A cell with tiles always
 * appears; a cell without never does.
 */
export interface NaipCellIndex {
  version: typeof NAIP_CELL_INDEX_VERSION;
  /** The archive's file name, e.g. `naip-summer-20261212.pmtiles`. */
  archive: string;
  flights: NaipCellIndexFlight[];
  cells: Record<string, number[]>;
}

/**
 * The fetched index, checked: throws on a wrong version, an index naming another archive than
 * `archiveName`, an entry with no flight or an out-of-range one, or a malformed flight. The map
 * fails the layer on a throw (a mismatched pair never draws).
 */
export function parseNaipCellIndex(json: unknown, archiveName: string): NaipCellIndex {
  void json;
  void archiveName;
  return placeholder('parseNaipCellIndex');
}

/** The date index's URL beside an archive's: `….pmtiles` → `…-cells.json`. */
export function naipIndexUrl(archiveUrl: string): string {
  void archiveUrl;
  return placeholder('naipIndexUrl');
}

/** The earliest and latest flight under a view, as `YYYY-MM-DD` days. */
export interface NaipCreditRange {
  from: string;
  to: string;
}

/**
 * The flights under the view (§4.2): over every key the index holds, the earliest and latest flight
 * date, both attained. `null` exactly when no key is indexed — no photograph covers the view.
 */
export function naipCreditRange(
  index: NaipCellIndex,
  keys: Iterable<string>,
): NaipCreditRange | null {
  void index;
  void keys;
  return placeholder('naipCreditRange');
}

/**
 * The range as the credit's month words: `Jun 2023` for one month, `Jun 2021 – Aug 2023` for several.
 * The credit's surrounding words (*Aerial · NAIP …*, *none in view*) are the web's.
 */
export function formatNaipCreditRange(range: NaipCreditRange): string {
  void range;
  return placeholder('formatNaipCreditRange');
}

// ── The one command (§3.1) ────────────────────────────────────────────────────────────────────────

/** `run-aerial.sh`'s stages; `all` runs select → tiles → assemble → verify. */
export const AERIAL_STAGES = ['select', 'tiles', 'assemble', 'verify', 'cleanup', 'all'] as const;
export type AerialStage = (typeof AERIAL_STAGES)[number];

/** `run-aerial.sh`'s flags (§3.1), the shape `scripts/aerial`'s `parseStageArgs` reads them into. */
export interface AerialRunOptions {
  /** Default `all`. */
  stage?: AerialStage;
  /** Narrow what is considered changed to these states. */
  states?: readonly NaipState[];
  /** Narrow what is considered changed to the keys listed in this file. */
  cells?: string;
  /** The partial rebuild: diff against the current manifest, copy the unchanged work tiles. */
  fromCurrent?: boolean;
  /** Write under `dev/naip/pilot/<name>/…`; the campaign must be a pilot's. */
  pilot?: string;
  dryRun?: boolean;
  /** `cleanup`'s target: the old archive's key. */
  old?: string;
}

/**
 * The exact `run-aerial.sh` line for a campaign, as the July offer stores it and as `parseStageArgs`
 * reads it back.
 */
export function aerialRebuildCommand(campaign: string, options: AerialRunOptions): string {
  void campaign;
  void options;
  return placeholder('aerialRebuildCommand');
}

function placeholder(fn: string): never {
  throw new Error(`PLACEHOLDER (S): naipManifest.${fn} is not built yet`);
}
