/**
 * **The summer aerial's records**: the build's manifest (B05 §2.1.3), the date index that ships beside
 * every archive (§2.7, D318), the credit's date range (§4.2), and the one command line the pipeline
 * and the July offer agree on (§3.1, §3.3).
 *
 * Also the build's hashes — each work tile's input hash and the exclusion list's — so the select
 * stage and anything that checks it compute them one way.
 *
 * The catalog walk (`naipCatalog.ts`) is exported through here: core's index lists this file, and
 * the walk sits beside the records it feeds.
 */

import { isQuarterQuadKey, NAIP_MAX_ZOOM, NAIP_MIN_ZOOM, NAIP_TILE_SIZE } from './naipGrid';
import {
  isNaipFlightStrike,
  isNaipState,
  type NaipExclusion,
  type NaipFoliageStrike,
  type NaipOffSeasonCell,
  type NaipPickStep,
  type NaipState,
} from './naipSelection';

export * from './naipCatalog';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The archive's file name ends with this… */
export const NAIP_ARCHIVE_SUFFIX = '.pmtiles';
/** …its date index's with this, in place of the archive's suffix (`naipIndexUrl`)… */
export const NAIP_INDEX_SUFFIX = '-cells.json';
/** …and its manifest's with this. */
export const NAIP_MANIFEST_SUFFIX = '-manifest.json';

// ── The manifest (§2.1.3) ─────────────────────────────────────────────────────────────────────────

/** 2 (2026-11-27, D319): `foliageStrikesHash`, and `offSeasonCells` names the cells the step reached. */
export const NAIP_MANIFEST_VERSION = 2;

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
  /**
   * Added by the assembler, before the manifest is published: what each frame supplied each cell in
   * this work tile, on the z16 grid (§2.2 step 4; the shard's done record's `cellCounts`, cell key →
   * item id → pixels). Kept so a later `--from-current` build that copies this work tile can date its
   * cells (§2.7) after the shards are deleted. Absent in the select stage's manifest.
   */
  cellCounts?: Record<string, Record<string, number>>;
}

/**
 * A published object the manifest names, with its integrity. **Which bytes** depends on the object:
 *
 * - the archive (`NaipManifest.archive`): the bytes as uploaded — it is stored as-is;
 * - the date index (`NaipManifest.cellIndex`): the **decoded JSON**, not the gzip body that was
 *   uploaded. The index is stored `Content-Encoding: gzip`, and the encoding is transport (a CDN may
 *   re-encode it); the JSON is what every client reads and what verify hashes after fetching it.
 */
export interface NaipPublishedObject {
  /** The file name (no key prefix), e.g. `naip-summer-20261212.pmtiles`. */
  name: string;
  /** Length of the hashed bytes: the archive's as uploaded, the index's decoded JSON. */
  bytes: number;
  /** Hex SHA-256 of those same bytes. */
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
    /**
     * Where the snapshot is archived (`inventoryKey`'s prefix), or `null` when it wasn't (a dry run,
     * or a pilot, which writes nothing outside its own prefixes).
     */
    archivedAt: string | null;
  };
  /** Hex SHA-256 of the exclusion list the rule ran with. */
  exclusionsHash: string;
  /** Hex SHA-256 of the foliage strikes the rule ran with (`naipFoliageStrikesHash`). */
  foliageStrikesHash: string;
  /**
   * Every cell the off-season step reached, with why, sorted by key (`NaipSelection.offSeason`):
   * the known off-season cells, for the July check to revisit.
   */
  offSeasonCells: NaipOffSeasonCell[];
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
 *
 * Returns a fresh copy holding only what the format names, so nothing extra the file carried is
 * read downstream.
 */
export function parseNaipCellIndex(json: unknown, archiveName: string): NaipCellIndex {
  const refuse = (why: string): never => {
    throw new Error(`the summer aerial's date index ${why}`);
  };
  if (!isRecord(json)) return refuse('is not an object');
  if (json.version !== NAIP_CELL_INDEX_VERSION) {
    return refuse(`is version ${JSON.stringify(json.version)}, not ${NAIP_CELL_INDEX_VERSION}`);
  }
  if (json.archive !== archiveName) {
    return refuse(`names ${JSON.stringify(json.archive)}, not ${archiveName}`);
  }
  if (!Array.isArray(json.flights)) return refuse('has no flights');
  const flights: NaipCellIndexFlight[] = json.flights.map((f: unknown, i: number) => {
    if (!isRecord(f)) return refuse(`flight ${i} is not an object`);
    const { date, gsd, state } = f;
    if (typeof date !== 'string' || !isCalendarDay(date)) {
      return refuse(`flight ${i} has no real day: ${JSON.stringify(date)}`);
    }
    if (typeof gsd !== 'number' || !Number.isFinite(gsd) || gsd <= 0) {
      return refuse(`flight ${i} has no resolution`);
    }
    if (typeof state !== 'string' || !isNaipState(state)) {
      return refuse(`flight ${i} names no state of the seven: ${JSON.stringify(state)}`);
    }
    return { date, gsd, state };
  });
  if (!isRecord(json.cells)) return refuse('has no cells');
  const cells: Record<string, number[]> = {};
  for (const [key, entry] of Object.entries(json.cells)) {
    if (!isQuarterQuadKey(key)) return refuse(`has a cell that isn't one: ${JSON.stringify(key)}`);
    if (!Array.isArray(entry) || entry.length === 0) return refuse(`dates no flight for ${key}`);
    const seen = new Set<number>();
    for (const at of entry) {
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= flights.length) {
        return refuse(`points ${key} at no flight: ${JSON.stringify(at)}`);
      }
      if (seen.has(at)) return refuse(`names flight ${at} twice for ${key}`);
      seen.add(at);
    }
    cells[key] = [...entry];
  }
  return { version: NAIP_CELL_INDEX_VERSION, archive: archiveName, flights, cells };
}

/** The date index's URL beside an archive's: `….pmtiles` → `…-cells.json`. */
export function naipIndexUrl(archiveUrl: string): string {
  // A query or fragment stays where it was: the suffix belongs to the path.
  const cut = archiveUrl.search(/[?#]/);
  const path = cut === -1 ? archiveUrl : archiveUrl.slice(0, cut);
  const rest = cut === -1 ? '' : archiveUrl.slice(cut);
  if (!path.endsWith(NAIP_ARCHIVE_SUFFIX) || path.length === NAIP_ARCHIVE_SUFFIX.length) {
    throw new Error(`not a summer aerial archive URL (no ${NAIP_ARCHIVE_SUFFIX}): ${archiveUrl}`);
  }
  return path.slice(0, -NAIP_ARCHIVE_SUFFIX.length) + NAIP_INDEX_SUFFIX + rest;
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
  let from: string | null = null;
  let to: string | null = null;
  for (const key of keys) {
    const entry = Object.hasOwn(index.cells, key) ? index.cells[key] : undefined;
    if (entry === undefined) continue;
    for (const at of entry) {
      const date = (index.flights[at] as NaipCellIndexFlight).date;
      if (from === null || date < from) from = date;
      if (to === null || date > to) to = date;
    }
  }
  return from === null || to === null ? null : { from, to };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2023-06-21` → `Jun 2023`. */
function monthYear(day: string): string {
  if (!isCalendarDay(day)) throw new Error(`not a YYYY-MM-DD day: ${JSON.stringify(day)}`);
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/**
 * The range as the credit's month words: `Jun 2023` for one month, `Jun 2021 – Aug 2023` for several.
 * The credit's surrounding words (*Aerial · NAIP …*, *none in view*) are the web's.
 */
export function formatNaipCreditRange(range: NaipCreditRange): string {
  const from = monthYear(range.from);
  const to = monthYear(range.to);
  if (range.from > range.to) {
    throw new Error(`a credit range runs forward: ${range.from} is after ${range.to}`);
  }
  return from === to ? from : `${from} – ${to}`;
}

// ── The build's hashes (§2.1.3) ───────────────────────────────────────────────────────────────────

/**
 * The tiling's own version: what the worker does to a stack (the warp, the cutlines, the WebP
 * settings, the per-cell counts). It is part of every work tile's input hash, so bumping it re-tiles
 * the region under `--from-current`. Bump it whenever `cut-aerial.sh` would draw different pixels
 * from the same stack.
 */
// 2 (B05-1's review, 2026-11-27): a frame that fills only a strip narrower than a counts' pixel is
// found at the deepest zoom and drawn there; under 1 such a strip stayed transparent.
export const NAIP_TILING_VERSION = 2;

/** One cell as a work tile's input hash reads it. */
export interface NaipHashedCell {
  key: string;
  pick: string;
  stack: readonly string[];
  partial: boolean;
  /** Every state whose catalog lists the cell: a border cell's fallbacks are cut (`naipFramesToCut`). */
  states: readonly string[];
}

/**
 * The frames the worker cuts for a cell, in the rule's order (§2.2, "fallbacks are read only where
 * needed"): the pick alone, unless the pick doesn't cover the cell (`partial`) or the cell sits on a
 * state line (listed by more than one state), where a flight may end and the other state's frame
 * must show through — then the pick and its whole stack. The one statement of the rule: the tiles
 * stage writes its units with it and the input hash covers its answer, so a change to anything it
 * reads re-cuts the work tile.
 */
export function naipFramesToCut(
  cell: Pick<NaipHashedCell, 'pick' | 'stack' | 'partial' | 'states'>,
): string[] {
  return cell.partial || cell.states.length > 1 ? [cell.pick, ...cell.stack] : [cell.pick];
}

/**
 * A work tile's input hash (§2.1.3): hex SHA-256 over everything that decides its pixels — the rule's
 * version, the tiling's (`NAIP_TILING_VERSION`, the zooms and the tile size), the work tile itself,
 * and each of its cells' pick, stack (in order), `partial` and the frames the worker cuts for it
 * (`naipFramesToCut`, which also reads whether the cell is on a state line). The cells' order doesn't
 * matter; anything else that changes does. "Landed" is a done record carrying this hash
 * (`shardLanded`).
 */
export function naipWorkTileInputHash(
  workTile: string,
  cells: readonly NaipHashedCell[],
  ruleVersion: number,
): string {
  if (new Set(cells.map((c) => c.key)).size !== cells.length) {
    throw new Error(`work tile ${workTile}: a cell is listed twice`);
  }
  const sorted = [...cells].sort((a, b) => (a.key < b.key ? -1 : 1));
  return sha256Hex(
    JSON.stringify({
      rule: ruleVersion,
      tiling: [NAIP_TILING_VERSION, NAIP_MIN_ZOOM, NAIP_MAX_ZOOM, NAIP_TILE_SIZE],
      workTile,
      cells: sorted.map((c) => [c.key, c.pick, [...c.stack], c.partial, naipFramesToCut(c)]),
    }),
  );
}

/**
 * The exclusion list's hash, for the manifest (`exclusionsHash`): hex SHA-256 of the list sorted by
 * item id, each entry's four fields in a fixed order — so two lists that strike the same frames for
 * the same reasons hash alike whatever their order in the file.
 */
export function naipExclusionsHash(exclusions: readonly NaipExclusion[]): string {
  // Sorted on the whole row, so even a doubled id (which the list's own test refuses) hashes alike
  // in any order.
  const rows = exclusions
    .map((e) => JSON.stringify([e.itemId, e.reason, e.reviewedBy, e.reviewedOn]))
    .sort();
  return sha256Hex(`[${rows.join(',')}]`);
}

/**
 * The foliage strikes' hash, for the manifest (`foliageStrikesHash`): hex SHA-256 of every entry as
 * a fixed row, sorted — a flight entry's state, day and sorted `keep`, a frame entry's item id, and
 * each one's review — so two lists that strike the same way hash alike whatever their order.
 */
export function naipFoliageStrikesHash(strikes: readonly NaipFoliageStrike[]): string {
  const rows = strikes
    .map((s) =>
      JSON.stringify(
        isNaipFlightStrike(s)
          ? [
              'flight',
              s.flight.state,
              s.flight.acquired,
              [...s.keep].sort(),
              s.reason,
              s.reviewedBy,
              s.reviewedOn,
            ]
          : ['frame', s.itemId, s.reason, s.reviewedBy, s.reviewedOn],
      ),
    )
    .sort();
  return sha256Hex(`[${rows.join(',')}]`);
}

/**
 * SHA-256 of a string's UTF-8 bytes, as hex (FIPS 180-4). Here rather than `node:crypto` because
 * core runs in Convex and the browser too, and the July check recomputes what the select stage
 * wrote; `crypto.subtle` would make every caller async for a few kilobytes.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // The length's high word: zero below 512 MB, which a manifest's text never approaches.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K[i] as number) +
          (w[i] as number)) >>>
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (next[i] as number)) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Is `s` a `YYYY-MM-DD` day the calendar has? */
export function isCalendarDay(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
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
  /** `cleanup`'s: the day (or ISO time) the web began serving the replacement. */
  liveSince?: string;
}

/** Where the entry point lives, from the repository's root. */
export const AERIAL_ENTRY_POINT = 'scripts/aerial/run-aerial.sh';

const CAMPAIGN = /^naip-(pilot-)?\d{8}$/;
const PILOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A shell word, single-quoted only when it must be (`'` itself closed, escaped and reopened). */
function shellWord(word: string): string {
  if (word === '') return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact `run-aerial.sh` line for a campaign, as the July offer stores it and as `parseStageArgs`
 * reads it back: the campaign, then the flags in `AerialRunOptions`' order, each only when set
 * (`--stage` only when it isn't `all`, the default). Throws on a campaign or pilot name the entry
 * point would refuse, so an offer never stores a command that can't run.
 */
export function aerialRebuildCommand(campaign: string, options: AerialRunOptions): string {
  if (!CAMPAIGN.test(campaign)) {
    throw new Error(`campaign ${JSON.stringify(campaign)} is not naip-<YYYYMMDD>`);
  }
  if (options.pilot !== undefined && !PILOT_NAME.test(options.pilot)) {
    throw new Error(`pilot ${JSON.stringify(options.pilot)} is not lowercase words and hyphens`);
  }
  if (
    options.stage !== undefined &&
    !(AERIAL_STAGES as readonly string[]).includes(options.stage)
  ) {
    throw new Error(`unknown stage ${JSON.stringify(options.stage)}`);
  }
  const words = [AERIAL_ENTRY_POINT, campaign];
  if (options.stage !== undefined && options.stage !== 'all') words.push('--stage', options.stage);
  if (options.states !== undefined && options.states.length > 0) {
    words.push('--states', [...new Set(options.states)].sort().join(','));
  }
  if (options.cells !== undefined) words.push('--cells', options.cells);
  if (options.fromCurrent === true) words.push('--from-current');
  if (options.pilot !== undefined) words.push('--pilot', options.pilot);
  if (options.dryRun === true) words.push('--dry-run');
  if (options.old !== undefined) words.push('--old', options.old);
  if (options.liveSince !== undefined) words.push('--live-since', options.liveSince);
  return words.map(shellWord).join(' ');
}
