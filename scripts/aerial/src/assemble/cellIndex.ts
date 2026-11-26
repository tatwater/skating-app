/**
 * **The date index** (B05 §2.7, D318): every tiled cell, dated by the flights that actually supply
 * its pixels — built from the manifest's frames and what each work tile's cut counted (§2.2 step 4).
 *
 * The founder's requirement is the shape of it: *"we should always show the date of the imagery,
 * regardless of which tile/region"*. So a cell is listed **only if some frame supplied it a pixel**,
 * and a flight is listed for a cell **only if one of its frames supplied a pixel there** — a fallback
 * that the pick covers completely is in the stack but never in the dates. Per cell the pick's flight
 * comes first (when it supplied any pixel), then the others by pixels supplied, most first.
 *
 * A flight is one acquisition day, resolution and labeled state (§2.7): two frames of one flight
 * (a reprocessed item) share it.
 */

import {
  NAIP_CELL_INDEX_VERSION,
  type NaipCellIndex,
  type NaipCellIndexFlight,
  type NaipManifest,
} from '@skating/core';
import type { ShardCellCounts } from '../shard';
import { gzipBytes } from './pmtiles';
import { sha256Hex } from './stores';

/** Pixels per cell per frame, summed over every work tile. */
export type CellFrameTotals = Map<string, Map<string, number>>;

/** Sum the per-work-tile counts into per-cell totals. */
export function totalCounts(perWorkTile: Iterable<ShardCellCounts>): CellFrameTotals {
  const totals: CellFrameTotals = new Map();
  for (const counts of perWorkTile) {
    for (const [cell, frames] of Object.entries(counts)) {
      const t = totals.get(cell) ?? new Map<string, number>();
      for (const [item, n] of Object.entries(frames)) t.set(item, (t.get(item) ?? 0) + n);
      totals.set(cell, t);
    }
  }
  return totals;
}

const flightKey = (f: NaipCellIndexFlight): string => `${f.date}|${f.gsd}|${f.state}`;

const compareFlights = (a: NaipCellIndexFlight, b: NaipCellIndexFlight): number =>
  a.date < b.date
    ? -1
    : a.date > b.date
      ? 1
      : a.gsd - b.gsd || (a.state < b.state ? -1 : a.state > b.state ? 1 : 0);

/**
 * The index for `archive` from the manifest and the totals. Throws when a count names a cell the
 * manifest doesn't hold or a frame that isn't in that cell's pick or stack — a pixel that can't be
 * dated must stop the build, never ship undated.
 */
export function buildCellIndex(
  manifest: NaipManifest,
  totals: CellFrameTotals,
  archive: string,
): NaipCellIndex {
  const cells = new Map(manifest.cells.map((c) => [c.key, c]));
  const perCell: { key: string; flights: { flight: NaipCellIndexFlight; pixels: number }[] }[] = [];
  const flights = new Map<string, NaipCellIndexFlight>();

  for (const key of [...totals.keys()].sort()) {
    const cell = cells.get(key);
    if (cell === undefined)
      throw new Error(`counts name cell ${key}, which the manifest doesn't hold`);
    const allowed = new Set([cell.pick, ...cell.stack]);
    const byFlight = new Map<string, { flight: NaipCellIndexFlight; pixels: number }>();
    let pickFlight: string | null = null;
    for (const [item, pixels] of totals.get(key) as Map<string, number>) {
      if (!allowed.has(item)) {
        throw new Error(
          `cell ${key}: counts name ${item}, which is neither its pick nor its stack`,
        );
      }
      if (pixels <= 0) continue;
      const frame = manifest.frames[item];
      if (frame === undefined) throw new Error(`cell ${key}: frame ${item} is not in the manifest`);
      const flight: NaipCellIndexFlight = {
        date: frame.acquired,
        gsd: frame.gsd,
        state: frame.state,
      };
      const fk = flightKey(flight);
      const entry = byFlight.get(fk) ?? { flight, pixels: 0 };
      entry.pixels += pixels;
      byFlight.set(fk, entry);
      if (item === cell.pick) pickFlight = fk;
    }
    if (byFlight.size === 0) continue;
    const ordered = [...byFlight].sort(([ka, a], [kb, b]) => {
      if (ka === pickFlight) return -1;
      if (kb === pickFlight) return 1;
      return b.pixels - a.pixels || -compareFlights(a.flight, b.flight);
    });
    for (const [fk, { flight }] of ordered) flights.set(fk, flight);
    perCell.push({ key, flights: ordered.map(([, v]) => v) });
  }

  const flightList = [...flights.values()].sort(compareFlights);
  const at = new Map(flightList.map((f, i) => [flightKey(f), i]));
  const indexCells: Record<string, number[]> = {};
  for (const { key, flights: fs } of perCell) {
    indexCells[key] = fs.map((f) => at.get(flightKey(f.flight)) as number);
  }
  return { version: NAIP_CELL_INDEX_VERSION, archive, flights: flightList, cells: indexCells };
}

/** The index as published: compact JSON, its gzip (the upload's body), and the JSON's SHA-256. */
export interface EncodedCellIndex {
  json: Uint8Array;
  gzip: Uint8Array;
  /**
   * Of the JSON, not the gzip: the encoding is transport (a CDN may re-encode it), the JSON is what
   * every client reads and what verify hashes after fetching it.
   */
  sha256: string;
}

export function encodeCellIndex(index: NaipCellIndex): EncodedCellIndex {
  const json = new TextEncoder().encode(JSON.stringify(index));
  return { json, gzip: gzipBytes(json), sha256: sha256Hex(json) };
}
