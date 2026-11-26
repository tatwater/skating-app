/**
 * **Where every object of a summer aerial build lives** (B05 §2.1.3, §2.2, §2.4) — the one key
 * layout the select stage, the worker, the assembler, verify and cleanup share, plus the local
 * scratch layout beside it.
 *
 * **The campaign carries the date; the pilot carries the place.** A build's campaign is
 * `naip-<YYYYMMDD>` and its objects are named for that day; a pilot's is `naip-pilot-<YYYYMMDD>` and
 * every one of its keys sits under `pilot/<name>/`. Every function here refuses a pilot campaign
 * without its name, or a name without a pilot campaign, so no path can put a pilot at the
 * production names (§3.1) — the keys are public and immutable once written, and the CDN caches them.
 *
 * Keys are bucket-relative. Which bucket (Governor fork G-6) is the caller's: the published three
 * under `dev/naip/` must be publicly readable; the build prefix and the inventory are private.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NAIP_ARCHIVE_SUFFIX,
  NAIP_INDEX_SUFFIX,
  NAIP_MANIFEST_SUFFIX,
  type NaipState,
  type WorkTile,
  workTileKey,
} from '@skating/core';

/** The only environment the archive is built for (the founder, F-4 a): prod points at dev's object. */
export const AERIAL_KEY_ENV = 'dev';

/** A campaign id, read. */
export interface Campaign {
  id: string;
  /** `YYYYMMDD`: the day the build's objects are named for. */
  date: string;
  /** A pilot's campaign (`naip-pilot-…`), whose objects must sit under its pilot name. */
  pilot: boolean;
}

const CAMPAIGN = /^naip-(pilot-)?(\d{4})(\d{2})(\d{2})$/;
const PILOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Is `yyyy-mm-dd` a day the calendar has? */
function isCalendarDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Reads `naip-<YYYYMMDD>` or `naip-pilot-<YYYYMMDD>`; throws on anything else or a day that isn't. */
export function parseCampaign(id: string): Campaign {
  const match = CAMPAIGN.exec(id);
  if (!match) {
    throw new Error(
      `campaign ${JSON.stringify(id)} is not naip-<YYYYMMDD> or naip-pilot-<YYYYMMDD>`,
    );
  }
  const [, pilot, y, m, d] = match as unknown as [
    string,
    string | undefined,
    string,
    string,
    string,
  ];
  if (!isCalendarDay(Number(y), Number(m), Number(d))) {
    throw new Error(`campaign ${id} names ${y}-${m}-${d}, which is not a day`);
  }
  return { id, date: `${y}${m}${d}`, pilot: pilot !== undefined };
}

/** Lowercase words joined by single hyphens: `champlain-nhma`. */
export function isPilotName(name: string): boolean {
  return PILOT_NAME.test(name);
}

/** The campaign read, and the pilot name checked against it. */
function resolveBuild(
  campaign: string,
  pilot: string | undefined,
): { date: string; pilot?: string } {
  const read = parseCampaign(campaign);
  if (read.pilot && pilot === undefined) {
    throw new Error(`${campaign} is a pilot campaign: name the pilot`);
  }
  if (!read.pilot && pilot !== undefined) {
    throw new Error(
      `pilot ${JSON.stringify(pilot)} needs a pilot campaign (naip-pilot-<YYYYMMDD>), not ${campaign}`,
    );
  }
  if (pilot !== undefined && !isPilotName(pilot)) {
    throw new Error(`pilot name ${JSON.stringify(pilot)} is not lowercase words joined by hyphens`);
  }
  return pilot === undefined ? { date: read.date } : { date: read.date, pilot };
}

// ── The published three (§2.4) ──────────────────────────────────────────────────────────────────

/** `naip-summer-<YYYYMMDD>`: the stem the archive, its date index and its manifest share. */
function stem(campaign: string): string {
  return `naip-summer-${parseCampaign(campaign).date}`;
}

/** The archive's file name, `naip-summer-<YYYYMMDD>.pmtiles` — the name its date index carries. */
export function archiveName(campaign: string): string {
  return `${stem(campaign)}${NAIP_ARCHIVE_SUFFIX}`;
}

/** The date index's file name, `naip-summer-<YYYYMMDD>-cells.json`. */
export function indexName(campaign: string): string {
  return `${stem(campaign)}${NAIP_INDEX_SUFFIX}`;
}

/** The published manifest's file name, `naip-summer-<YYYYMMDD>-manifest.json`. */
export function manifestName(campaign: string): string {
  return `${stem(campaign)}${NAIP_MANIFEST_SUFFIX}`;
}

/** `dev/naip/`, or `dev/naip/pilot/<name>/` for a pilot. */
export function publishPrefix(campaign: string, pilot?: string): string {
  const build = resolveBuild(campaign, pilot);
  return build.pilot === undefined
    ? `${AERIAL_KEY_ENV}/naip/`
    : `${AERIAL_KEY_ENV}/naip/pilot/${build.pilot}/`;
}

/** The archive's key: `dev/naip/naip-summer-<YYYYMMDD>.pmtiles`. Immutable once written. */
export function archiveKey(campaign: string, pilot?: string): string {
  return `${publishPrefix(campaign, pilot)}${archiveName(campaign)}`;
}

/** The date index's key, beside the archive. Immutable once written. */
export function indexKey(campaign: string, pilot?: string): string {
  return `${publishPrefix(campaign, pilot)}${indexName(campaign)}`;
}

/** The published manifest's key, beside the archive. Immutable once written. */
export function manifestKey(campaign: string, pilot?: string): string {
  return `${publishPrefix(campaign, pilot)}${manifestName(campaign)}`;
}

/** A published archive key, read back: what cleanup's `--old` must be. */
export interface ArchiveKey {
  key: string;
  /** `YYYYMMDD`. */
  date: string;
  /** The pilot's name, or `null` for a production archive. */
  pilot: string | null;
}

const ARCHIVE_KEY = new RegExp(
  `^${AERIAL_KEY_ENV}/naip/(?:pilot/([^/]+)/)?naip-summer-(\\d{8})\\${NAIP_ARCHIVE_SUFFIX}$`,
);

/** Reads a key `archiveKey` would have written; throws on any other. */
export function parseArchiveKey(key: string): ArchiveKey {
  const match = ARCHIVE_KEY.exec(key);
  if (!match) throw new Error(`${JSON.stringify(key)} is not a summer aerial archive key`);
  const [, pilot, date] = match as unknown as [string, string | undefined, string];
  // The regex fixes the shape; writing the key again checks the day and the pilot's name (it
  // throws on either), and whatever it then writes is `key` itself.
  archiveKey(pilot === undefined ? `naip-${date}` : `naip-pilot-${date}`, pilot);
  return { key, date, pilot: pilot ?? null };
}

// ── The private build prefix (§2.2) ────────────────────────────────────────────────────────────

/** `naip/build/<campaign>/`, or `naip/build/pilot/<name>/<campaign>/`. Deleted once verify passes. */
export function buildPrefix(campaign: string, pilot?: string): string {
  const build = resolveBuild(campaign, pilot);
  return build.pilot === undefined
    ? `naip/build/${campaign}/`
    : `naip/build/pilot/${build.pilot}/${campaign}/`;
}

/** The select stage's manifest, where the later stages read it before it is published. */
export function buildManifestKey(campaign: string, pilot?: string): string {
  return `${buildPrefix(campaign, pilot)}manifest.json`;
}

/** One work tile's three objects (`shard.ts`). */
export interface ShardKeys {
  /** The tiles' bytes, concatenated in the index's order. */
  pack: string;
  /** The index: tile id, offset, length, hash per tile. */
  index: string;
  /** The done record. Written last: its input hash is what "landed" means. */
  done: string;
}

/** `<build prefix>shards/11/<x>/<y>.{pack,idx.json,done.json}`. */
export function shardKeys(campaign: string, tile: WorkTile, pilot?: string): ShardKeys {
  const base = `${buildPrefix(campaign, pilot)}shards/${workTileKey(tile)}`;
  return { pack: `${base}.pack`, index: `${base}.idx.json`, done: `${base}.done.json` };
}

/** The catalog snapshot, archived per state: `naip/inventory/<YYYY-MM-DD>/<st>.jsonl.gz`. */
export function inventoryKey(walkedOn: string, state: NaipState): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(walkedOn);
  if (!match || !isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new Error(`walkedOn ${JSON.stringify(walkedOn)} is not a YYYY-MM-DD day`);
  }
  return `naip/inventory/${walkedOn}/${state.toLowerCase()}.jsonl.gz`;
}

// ── Local scratch ───────────────────────────────────────────────────────────────────────────────

// `fileURLToPath`, never `new URL(...).pathname`: the latter percent-encodes, so a checkout under a
// directory with a space in it would resolve `.scratch` to somewhere that isn't there.
const HERE = dirname(fileURLToPath(import.meta.url));

/** The package's gitignored scratch, `scripts/aerial/.scratch/`. */
export const AERIAL_SCRATCH = join(HERE, '..', '.scratch');

/** Where one campaign's local files go. */
export interface ScratchPaths {
  /** `<scratch>/<campaign>/`. */
  dir: string;
  /** The select stage's manifest, before it is uploaded. */
  manifest: string;
  /** The catalog snapshot, one `<st>.jsonl` per state. */
  inventory: string;
  /** Verify's report: counts, contact sheets, the viewer page. */
  report: string;
  /** `run-aerial.sh`'s timestamped log, `<scratch>/run-<campaign>.log`. */
  log: string;
}

/** One campaign's scratch layout under `root` (default the package's `.scratch/`). */
export function scratchPaths(campaign: string, root: string = AERIAL_SCRATCH): ScratchPaths {
  parseCampaign(campaign);
  const dir = join(root, campaign);
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    inventory: join(dir, 'inventory'),
    report: join(dir, 'report'),
    log: join(root, `run-${campaign}.log`),
  };
}
