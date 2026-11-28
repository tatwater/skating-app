/**
 * **Verify** (B05 §2.5): the operator's laptop, after assembly, reading the archive **from its public
 * URL** with the same `pmtiles` library the web uses. It refuses to call a build good on any miss.
 *
 * The checks that refuse (any problem fails the run, and the build is not published):
 *
 * - **archive** — the header the web will read: spec 3, clustered, WebP, uncompressed tiles, tile
 *   zooms 7–17; the object's length and the manifest's, the assembly record's hash and the manifest's;
 *   and what the archive was built from (core's `naipBuildInputsHash`) one value in the record, the
 *   published manifest and the build's manifest as it is now.
 * - **counts** — every addressed tile id, walked out of the published directories, is exactly the
 *   union of the landed shards' indexes, the tiles copied from the current archive and the
 *   overviews; the header's count agrees; every work tile in the manifest either landed (its done
 *   record carries the manifest's input hash) or was copied; every zoom has a tile.
 * - **spot reads** — a few hundred tiles, fetched by range from the public URL, byte-compared to
 *   their source (the shard's pack, the current archive, or the overview's recorded hash).
 * - **dates** (D318) — the published index's hash is the manifest's; it parses as the client parses
 *   it; `checkCellIndex` (every pixel's cell dated, by exactly the flights that supply it, each
 *   matching its item id's date); and no tile draws where no cell it touches is dated.
 *
 * And what is looked at rather than refused (`verifyReport.ts`): coverage per cell, the seams, the
 * low-zoom quilt, and the viewer page.
 */

import {
  NAIP_WORK_ZOOM,
  type NaipCellIndex,
  type NaipManifest,
  naipBuildInputsDiff,
  naipBuildInputsHash,
  naipTileZoom,
  parseWorkTileKey,
} from '@skating/core';
import { type Header, PMTiles, tileIdToZxy } from 'pmtiles';
import {
  type ArchiveEntries,
  readArchiveEntries,
  storeSource,
  tilesInRange,
} from './assemble/archiveRead';
import {
  ARCHIVE_ZOOMS,
  type AssembledManifest,
  type AssemblyRecord,
  assemblyKeys,
} from './assemble/assemble';
import { totalCounts } from './assemble/cellIndex';
import { prng } from './assemble/prng';
import type { ProcessRunner } from './assemble/process';
import { type ObjectStore, sha256Hex } from './assemble/stores';
import { tileBox, workTileIdRange } from './assemble/tileGrid';
import {
  archiveKey,
  archiveName,
  buildManifestKey,
  indexKey,
  manifestKey,
  publishPrefix,
  shardKeys,
} from './keys';
import { describeDifference, newCampaignAdvice } from './publishedBuild';
import { checkShardIndex, parseShardDone, SHARD_TILE_ZOOMS, shardLanded } from './shard';
import { type CellsIn, checkCellIndex, undatedTiles } from './verifyDates';

/** One check's outcome. `problems` empty means it passed. */
export interface CheckResult {
  name: string;
  problems: string[];
  /** Numbers for the run row and the report. */
  counts: Record<string, number>;
  /** Context for the report (never sent to Convex). */
  notes: string[];
}

export interface VerifyDeps {
  /** The public URL's objects: the archive, its index, its manifest (and the current archive's). */
  published: ObjectStore;
  /** The private bucket: the build prefix's shards and the assembly record. */
  build: ObjectStore;
  /** Core's `quarterQuadsIn`. */
  cellsIn: CellsIn;
  /** Core's `parseNaipCellIndex`: the client's own refusal, run on the published index. */
  parseIndex: (json: unknown, archiveName: string) => NaipCellIndex;
  /** How the index was served (`Content-Encoding`, length), for the report; optional. */
  indexHeaders?: () => Promise<Record<string, string>>;
  /** Spot reads to make (default 300). */
  spotReads?: number;
  /** Per check, as it finishes (the run row's heartbeat). */
  onCheck?: (result: CheckResult) => void | Promise<void>;
}

/** Everything verify read, for the report. */
export interface VerifyContext {
  campaign: string;
  pilot: string | null;
  manifest: AssembledManifest;
  record: AssemblyRecord;
  header: Header;
  index: NaipCellIndex | null;
  /** Every addressed tile id in the published archive, ascending. */
  tileIds: Float64Array;
}

export interface VerifyOutcome {
  ok: boolean;
  checks: CheckResult[];
  context: VerifyContext | null;
}

const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

const check = (name: string): CheckResult => ({ name, problems: [], counts: {}, notes: [] });

/** Expand an archive's entries into every addressed id, ascending. */
export function addressedIds(entries: ArchiveEntries): Float64Array {
  let n = 0;
  for (let i = 0; i < entries.entries.count; i++) n += entries.entries.runLength[i] as number;
  const out = new Float64Array(n);
  let at = 0;
  for (let i = 0; i < entries.entries.count; i++) {
    const start = entries.entries.tileId[i] as number;
    for (let r = 0; r < (entries.entries.runLength[i] as number); r++) out[at++] = start + r;
  }
  return out;
}

/** Where verify expects each tile's bytes: a shard pack's range, the current archive's, or a hash. */
type Expected =
  | { kind: 'shard'; key: string; offset: number; length: number; sha256: string }
  | { kind: 'copied'; key: string; offset: number; length: number }
  | { kind: 'overview'; length: number; sha256: string };

/** Run every check. Never throws on a bad build — a miss is a problem in its check. */
export async function verifyBuild(
  campaign: string,
  pilot: string | null,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const p = pilot ?? undefined;
  const checks: CheckResult[] = [];
  const finish = async (c: CheckResult): Promise<void> => {
    checks.push(c);
    await deps.onCheck?.(c);
  };
  const name = archiveName(campaign);

  // ── The three published objects and the record ────────────────────────────────────────────
  const archive = check('archive');
  const manifestBytes = await deps.published.get(manifestKey(campaign, p));
  const recordBytes = await deps.build.get(assemblyKeys(campaign, p).record);
  if (manifestBytes === null) archive.problems.push(`${manifestKey(campaign, p)} is not published`);
  if (recordBytes === null)
    archive.problems.push('the assembly record is missing: was it assembled?');
  if (manifestBytes === null || recordBytes === null) {
    await finish(archive);
    return { ok: false, checks, context: null };
  }
  const manifest = decodeJson(manifestBytes) as AssembledManifest;
  const record = decodeJson(recordBytes) as AssemblyRecord;
  const key = archiveKey(campaign, p);
  let header: Header;
  let entries: ArchiveEntries;
  try {
    entries = await readArchiveEntries(storeSource(deps.published, key));
    header = entries.header;
  } catch (e) {
    archive.problems.push(`the archive can't be read from the public URL: ${(e as Error).message}`);
    await finish(archive);
    return { ok: false, checks, context: null };
  }
  const expectHeader: [string, unknown, unknown][] = [
    ['spec version', header.specVersion, 3],
    ['clustered', header.clustered, true],
    ['tile type', header.tileType, 4],
    ['tile compression', header.tileCompression, 1],
    ['min zoom', header.minZoom, ARCHIVE_ZOOMS.min],
    ['max zoom', header.maxZoom, ARCHIVE_ZOOMS.max],
  ];
  for (const [what, got, want] of expectHeader) {
    if (got !== want)
      archive.problems.push(`the header's ${what} is ${String(got)}, not ${String(want)}`);
  }
  if (manifest.archive?.name !== name) {
    archive.problems.push(`the manifest names ${String(manifest.archive?.name)}, not ${name}`);
  }
  if (manifest.archive?.sha256 !== record.archive.sha256) {
    archive.problems.push("the manifest's archive hash is not the one the assembler streamed");
  }
  // **What the archive was built from** (core's `naipBuildInputsHash`, the one identity): the
  // record's, the published manifest's and the build's manifest's now must be one value — a build
  // manifest re-selected after the assembly (other picks, re-cut) would otherwise pass here while
  // the archive keeps the earlier selection (PR #188's review).
  const published = asManifest(manifest);
  if (record.inputs !== naipBuildInputsHash(published)) {
    archive.problems.push(
      typeof record.inputs === 'string'
        ? 'the assembly record names other inputs than the published manifest'
        : "the assembly record names no inputs, so what the archive was built from can't be checked",
    );
  }
  const buildBytes = await deps.build.get(buildManifestKey(campaign, p));
  if (buildBytes === null) {
    archive.problems.push(
      `the build's manifest (${buildManifestKey(campaign, p)}) is missing, so what the archive was built from can't be checked`,
    );
  } else {
    const diff = naipBuildInputsDiff(published, decodeJson(buildBytes) as NaipManifest);
    if (diff.length > 0) {
      archive.problems.push(
        `the build's manifest has changed since the archive was assembled (${describeDifference(diff)}): the archive keeps the earlier selection, and ${newCampaignAdvice(published)}`,
      );
    }
  }
  const size = await deps.published.size(key);
  if (size !== manifest.archive.bytes) {
    archive.problems.push(
      `the archive is ${String(size)} bytes, the manifest says ${manifest.archive.bytes}`,
    );
  }
  const lastByte = header.tileDataOffset + (header.tileDataLength as number);
  if (lastByte !== manifest.archive.bytes) {
    archive.problems.push(
      `the header ends the data at ${lastByte}, the manifest says ${manifest.archive.bytes} bytes`,
    );
  }
  if (entries.entries.count !== header.numTileEntries) {
    archive.problems.push(
      `the directories hold ${entries.entries.count} tile entries, the header says ${header.numTileEntries}`,
    );
  }
  archive.counts = { bytes: manifest.archive.bytes, leaves: entries.leaves };
  await finish(archive);

  // ── Counts ─────────────────────────────────────────────────────────────────────────────────
  const counts = check('counts');
  const tileIds = addressedIds(entries);
  const expected = new Map<number, Expected>();
  const add = (id: number, e: Expected): void => {
    if (expected.has(id)) counts.problems.push(`tile ${id} comes from two sources`);
    expected.set(id, e);
  };
  let oldEntries: ArchiveEntries | null = null;
  if (record.copiedFrom !== null) {
    try {
      oldEntries = await readArchiveEntries(storeSource(deps.published, record.copiedFrom));
    } catch (e) {
      counts.problems.push(
        `the current archive ${record.copiedFrom} can't be read: ${(e as Error).message}`,
      );
    }
  }
  let cut = 0;
  let copied = 0;
  for (const wt of manifest.workTiles) {
    const tile = parseWorkTileKey(wt.key);
    if (wt.retile) {
      const keys = shardKeys(campaign, tile, p);
      const doneBytes = await deps.build.get(keys.done);
      const done = doneBytes === null ? null : parseShardDone(decodeJson(doneBytes));
      if (!shardLanded(done, { campaign, workTile: wt.key, inputHash: wt.inputHash })) {
        counts.problems.push(`work tile ${wt.key} has not landed`);
        continue;
      }
      if (JSON.stringify(done?.cellCounts) !== JSON.stringify(wt.cellCounts)) {
        counts.problems.push(
          `work tile ${wt.key}: the manifest's counts are not its done record's`,
        );
      }
      const indexBytes = await deps.build.get(keys.index);
      if (indexBytes === null) {
        counts.problems.push(`work tile ${wt.key} has no index`);
        continue;
      }
      const index = checkShardIndex(decodeJson(indexBytes), done?.bytes);
      for (const e of index.entries) {
        add(e.tileId, {
          kind: 'shard',
          key: keys.pack,
          offset: e.offset,
          length: e.length,
          sha256: e.sha256,
        });
      }
      cut++;
    } else {
      if (oldEntries === null) {
        counts.problems.push(
          `work tile ${wt.key} is copied, but there is no current archive to copy from`,
        );
        continue;
      }
      for (let z = SHARD_TILE_ZOOMS.min; z <= SHARD_TILE_ZOOMS.max; z++) {
        const [first, n] = workTileIdRange(tile, z);
        for (const t of tilesInRange(oldEntries, first, n)) {
          add(t.tileId, {
            kind: 'copied',
            key: record.copiedFrom as string,
            offset: t.offset,
            length: t.length,
          });
        }
      }
      copied++;
    }
  }
  for (const o of record.overviews)
    add(o.tileId, { kind: 'overview', length: o.length, sha256: o.sha256 });
  const want = Float64Array.from(expected.keys()).sort();
  let missing = 0;
  let extra = 0;
  for (let i = 0, j = 0; i < want.length || j < tileIds.length; ) {
    const a = want[i];
    const b = tileIds[j];
    if (b === undefined || (a !== undefined && a < b)) {
      if (missing++ < 5) counts.problems.push(`tile ${a} is in its source but not in the archive`);
      i++;
    } else if (a === undefined || b < a) {
      if (extra++ < 5) counts.problems.push(`tile ${b} is in the archive but in no source`);
      j++;
    } else {
      i++;
      j++;
    }
  }
  if (missing > 5) counts.problems.push(`…and ${missing - 5} more missing`);
  if (extra > 5) counts.problems.push(`…and ${extra - 5} more unexplained`);
  if (header.numAddressedTiles !== tileIds.length) {
    counts.problems.push(
      `the header addresses ${header.numAddressedTiles}, the directories ${tileIds.length}`,
    );
  }
  const perZoom = new Map<number, number>();
  for (const id of tileIds) {
    const z = tileIdToZxy(id)[0];
    perZoom.set(z, (perZoom.get(z) ?? 0) + 1);
  }
  for (let z = ARCHIVE_ZOOMS.min; z <= ARCHIVE_ZOOMS.max; z++) {
    if (!perZoom.has(z)) counts.problems.push(`zoom ${z} has no tile`);
  }
  counts.counts = {
    addressed: tileIds.length,
    expected: want.length,
    missing,
    unexplained: extra,
    workTilesCut: cut,
    workTilesCopied: copied,
    overviews: record.overviews.length,
    ...Object.fromEntries([...perZoom].map(([z, n]) => [`zoom${z}`, n])),
  };
  await finish(counts);

  // ── Spot reads ────────────────────────────────────────────────────────────────────────────
  const spot = check('spot reads');
  const reader = new PMTiles(storeSource(deps.published, key));
  const sample = sampleIds(tileIds, deps.spotReads ?? 300);
  let compared = 0;
  for (const id of sample) {
    const e = expected.get(id);
    if (e === undefined) continue;
    const [z, x, y] = tileIdToZxy(id);
    const got = await reader.getZxy(z, x, y);
    if (got === undefined) {
      spot.problems.push(`tile ${z}/${x}/${y} reads as absent`);
      continue;
    }
    const bytes = new Uint8Array(got.data);
    let same: boolean;
    if (e.kind === 'overview') {
      same = bytes.length === e.length && sha256Hex(bytes) === e.sha256;
    } else {
      const store = e.kind === 'shard' ? deps.build : deps.published;
      const source = await store.range(e.key, e.offset, e.length);
      same = Buffer.compare(Buffer.from(bytes), Buffer.from(source)) === 0;
      if (e.kind === 'shard' && sha256Hex(source) !== e.sha256) {
        spot.problems.push(
          `tile ${z}/${x}/${y}: its shard bytes don't match the shard's own index`,
        );
      }
    }
    if (!same) spot.problems.push(`tile ${z}/${x}/${y} differs from its ${e.kind} source`);
    compared++;
  }
  spot.counts = { compared };
  await finish(spot);

  // ── Dates ─────────────────────────────────────────────────────────────────────────────────
  const dates = check('dates');
  let index: NaipCellIndex | null = null;
  const indexBytes = await deps.published.get(indexKey(campaign, p));
  if (indexBytes === null) {
    dates.problems.push(`${indexKey(campaign, p)} is not published: every cell would be undated`);
  } else {
    if (sha256Hex(indexBytes) !== manifest.cellIndex?.sha256) {
      dates.problems.push("the published index's hash is not the manifest's");
    }
    let json: unknown = null;
    try {
      json = decodeJson(indexBytes);
    } catch {
      dates.problems.push('the published index is not JSON (served still gzipped?)');
    }
    if (json !== null) {
      try {
        index = deps.parseIndex(json, name);
      } catch (e) {
        dates.problems.push(`the client refuses the index: ${(e as Error).message}`);
      }
      const totals = totalCounts(manifest.workTiles.map((w) => w.cellCounts));
      dates.problems.push(
        ...checkCellIndex({ json, archiveName: name, manifest: asManifest(manifest), totals }),
      );
      const cells = (json as { cells?: Record<string, number[]> }).cells ?? {};
      const deep = tileIds.filter((id) => tileIdToZxy(id)[0] >= naipTileZoom(NAIP_WORK_ZOOM + 1));
      const undated = undatedTiles(
        deep,
        { cells },
        (id) => {
          const [z, x, y] = tileIdToZxy(id);
          return tileBox(z, x, y);
        },
        deps.cellsIn,
      );
      if (undated.count > 0) {
        dates.problems.push(
          `${undated.count} tiles draw where no cell they touch is dated (e.g. ${undated.sample
            .slice(0, 5)
            .map((id) => tileIdToZxy(id).join('/'))
            .join(', ')})`,
        );
      }
      dates.counts = {
        cells: Object.keys(cells).length,
        flights: Array.isArray((json as { flights?: unknown[] }).flights)
          ? (json as { flights: unknown[] }).flights.length
          : 0,
        indexBytes: indexBytes.length,
        undatedTiles: undated.count,
      };
    }
    if (deps.indexHeaders) {
      const h = await deps.indexHeaders();
      dates.notes.push(
        `index served with content-encoding ${h['content-encoding'] ?? 'none'}, content-length ${h['content-length'] ?? 'unknown'}`,
      );
    }
  }
  await finish(dates);

  return {
    ok: checks.every((c) => c.problems.length === 0),
    checks,
    context: { campaign, pilot, manifest, record, header, index, tileIds },
  };
}

/** The published manifest as core's type (its extra fields are the assembler's). */
function asManifest(m: AssembledManifest) {
  return m as unknown as Parameters<typeof checkCellIndex>[0]['manifest'];
}

/**
 * A deterministic sample of `n` ids, spread over zooms: the shallow zooms (few tiles) are all taken
 * up to a share, the rest drawn evenly by a seeded generator.
 */
export function sampleIds(ids: Float64Array, n: number): number[] {
  if (ids.length <= n) return [...ids];
  const byZoom = new Map<number, number[]>();
  for (const id of ids) {
    const z = tileIdToZxy(id)[0];
    const list = byZoom.get(z) ?? [];
    list.push(id);
    byZoom.set(z, list);
  }
  const per = Math.max(1, Math.floor(n / byZoom.size));
  const rand = prng(ids.length);
  const out: number[] = [];
  for (const [, list] of [...byZoom].sort(([a], [b]) => a - b)) {
    if (list.length <= per) {
      out.push(...list);
      continue;
    }
    for (let i = 0; i < per; i++) out.push(list[Math.floor(rand() * list.length)] as number);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The publish prefix's public URL for an object, for the report and the viewer. */
export function publicUrl(
  base: string,
  campaign: string,
  pilot: string | null,
  file: string,
): string {
  return `${base.replace(/\/+$/, '')}/${publishPrefix(campaign, pilot ?? undefined)}${file}`;
}

/**
 * **A second reader of the published archive**: the `pmtiles` CLI's `show` over the public URL,
 * when the CLI is installed (`null` when it isn't). Not `pmtiles verify`: that one takes a local file
 * only — handed a URL it stats it as a path and fails (found by the integration's local run, which
 * is how verify refused a good build wherever the CLI is installed) — and a region's archive is
 * never on the laptop. The structural verify belongs to the assembler's round trip (`pmtiles
 * verify` on a local archive, B05 §7.3).
 */
export async function pmtilesCliCheck(
  run: ProcessRunner,
  archiveUrl: string,
): Promise<CheckResult | null> {
  const res = await run('pmtiles', ['show', archiveUrl]).catch(() => null);
  if (res === null) return null;
  const ok = res.code === 0 && /pmtiles spec version: 3/.test(res.stdout);
  return {
    name: 'pmtiles show',
    problems: ok
      ? []
      : [
          `pmtiles show exited ${res.code}: ${res.stderr.trim().split('\n').slice(-3).join(' ') || 'no spec-3 header'}`,
        ],
    counts: {},
    notes: ok ? ['the pmtiles CLI read the header and metadata over the public URL'] : [],
  };
}
