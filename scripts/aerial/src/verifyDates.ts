/**
 * **Verify's date checks** (B05 §2.5 *Dates*, D318): an undated cell is never published.
 *
 * Independent of the code that built the index (`assemble/cellIndex.ts`): it re-derives, from the
 * manifest and the cut's own counts, which flights supply each cell, and holds the index to exactly
 * that. The assembler runs it before writing a byte; verify runs it again on the published copies.
 *
 * - the index is version 1, names this archive, and its flights are distinct, real days, a known
 *   resolution and one of the seven states;
 * - **every cell any frame supplied a pixel is listed, and no other cell is**;
 * - each listed cell names **exactly** the flights whose frames supplied it a pixel — none missing,
 *   none extra (a fallback the pick covers completely is not a date the cell shows) — the pick's
 *   flight first whenever the pick supplied any;
 * - every such frame's acquisition day is a real day and **matches the date in its item id** — the
 *   *first* date: a reprocessed item carries a second (`…_030_20231002_20240103` was flown on
 *   2 October 2023);
 * - every flight is used by some cell.
 *
 * And over the archive's own tiles (`undatedTiles`): a tile that lies inside one cell is in a dated
 * cell, and a tile across several touches at least one.
 */

import {
  isCalendarDay,
  isNaipState,
  type NaipCellIndex,
  type NaipManifest,
  parseNaipItemId,
} from '@skating/core';
import type { CellFrameTotals } from './assemble/cellIndex';

const CELL_KEY = /^\d{7}(?:ne|nw|se|sw)$/;

/** Is `s` a `YYYY-MM-DD` day the calendar has? Core's `isCalendarDay`, for any value. */
export function isRealDay(s: unknown): s is string {
  return typeof s === 'string' && isCalendarDay(s);
}

/**
 * The acquisition day an item id names (its first date), as `YYYY-MM-DD`; `null` if it isn't an
 * item id. **Core's `parseNaipItemId`, the pipeline's one reader of an id**: the catalog's walk, the
 * select stage's check and this all read a date the same way, whatever the id's resolution token
 * (`030`, `060`, `1`, `.5`, `.6`, `h` — verify once read only the three-digit ones and would have
 * refused any build where a 2015–2016 0.5 or 0.6 m fallback showed).
 */
export function itemIdDate(itemId: string): string | null {
  try {
    return parseNaipItemId(itemId).acquired;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every way `json` fails to date the archive, one line each; empty when it dates every pixel. */
export function checkCellIndex(args: {
  json: unknown;
  archiveName: string;
  manifest: NaipManifest;
  totals: CellFrameTotals;
}): string[] {
  const { json, archiveName, manifest, totals } = args;
  const problems: string[] = [];
  if (!isRecord(json)) return ['the index is not an object'];
  if (json.version !== 1) problems.push(`the index is version ${String(json.version)}, not 1`);
  if (json.archive !== archiveName) {
    problems.push(`the index names ${JSON.stringify(json.archive)}, not ${archiveName}`);
  }
  if (!Array.isArray(json.flights)) return [...problems, 'the index has no flights list'];
  if (!isRecord(json.cells)) return [...problems, 'the index has no cells'];

  const flights = json.flights as unknown[];
  const flightKeys: string[] = [];
  const seenFlights = new Set<string>();
  flights.forEach((f, i) => {
    if (!isRecord(f) || !isRealDay(f.date)) {
      problems.push(`flight ${i} has no real day`);
      flightKeys.push('');
      return;
    }
    if (typeof f.gsd !== 'number' || !(f.gsd > 0)) problems.push(`flight ${i} has no resolution`);
    if (typeof f.state !== 'string' || !isNaipState(f.state)) {
      problems.push(`flight ${i}'s state ${JSON.stringify(f.state)} is not one of the seven`);
    }
    const key = `${f.date}|${String(f.gsd)}|${String(f.state)}`;
    if (seenFlights.has(key)) problems.push(`flight ${i} repeats ${key}`);
    seenFlights.add(key);
    flightKeys.push(key);
  });

  const cells = new Map(manifest.cells.map((c) => [c.key, c]));
  const used = new Set<number>();
  const listed = json.cells as Record<string, unknown>;

  // Every cell the cut says has pixels.
  for (const [key, frames] of totals) {
    const supplied = [...frames].filter(([, n]) => n > 0);
    if (supplied.length === 0) continue;
    const entry = listed[key];
    if (entry === undefined) {
      problems.push(`cell ${key} has pixels and no date: an undated cell`);
      continue;
    }
    const cell = cells.get(key);
    if (cell === undefined) {
      problems.push(`cell ${key} has pixels but isn't in the manifest`);
      continue;
    }
    const expected = new Set<string>();
    let pickFlight: string | null = null;
    for (const [item] of supplied) {
      const frame = manifest.frames[item];
      if (frame === undefined) {
        problems.push(`cell ${key}: frame ${item} supplied pixels and isn't in the manifest`);
        continue;
      }
      if (!isRealDay(frame.acquired)) {
        problems.push(
          `frame ${item}: acquired ${JSON.stringify(frame.acquired)} is not a real day`,
        );
      } else if (itemIdDate(item) !== frame.acquired) {
        problems.push(
          `frame ${item}: acquired ${frame.acquired}, but its id says ${itemIdDate(item) ?? 'no date'}`,
        );
      }
      const fk = `${frame.acquired}|${frame.gsd}|${frame.state}`;
      expected.add(fk);
      if (item === cell.pick) pickFlight = fk;
    }
    if (!Array.isArray(entry) || entry.length === 0) {
      problems.push(`cell ${key} names no flight: an undated cell`);
      continue;
    }
    const named = new Set<string>();
    for (const i of entry) {
      if (!Number.isInteger(i) || i < 0 || i >= flights.length) {
        problems.push(`cell ${key} names flight ${String(i)}, which isn't in the list`);
        continue;
      }
      used.add(i);
      const fk = flightKeys[i] as string;
      if (named.has(fk)) problems.push(`cell ${key} names ${fk} twice`);
      named.add(fk);
    }
    for (const fk of expected) {
      if (!named.has(fk)) problems.push(`cell ${key}: ${fk} supplies pixels and isn't named`);
    }
    for (const fk of named) {
      if (fk !== '' && !expected.has(fk)) {
        problems.push(`cell ${key} names ${fk}, which supplies it no pixel`);
      }
    }
    const first = entry[0];
    if (
      pickFlight !== null &&
      Number.isInteger(first) &&
      flightKeys[first as number] !== pickFlight
    ) {
      problems.push(`cell ${key}: the pick's flight ${pickFlight} isn't first`);
    }
  }

  // And no cell without pixels.
  for (const key of Object.keys(listed)) {
    if (!CELL_KEY.test(key)) problems.push(`${JSON.stringify(key)} is not a cell key`);
    const frames = totals.get(key);
    if (frames === undefined || ![...frames.values()].some((n) => n > 0)) {
      problems.push(`cell ${key} is dated but no frame supplied it a pixel`);
      const entry = listed[key];
      if (Array.isArray(entry)) for (const i of entry) if (Number.isInteger(i)) used.add(i);
    }
  }
  flights.forEach((_, i) => {
    if (!used.has(i)) problems.push(`flight ${i} (${flightKeys[i]}) is used by no cell`);
  });
  return problems;
}

/** The quarter-quads a box touches: core's `quarterQuadsIn`, injected so verify is testable now. */
export type CellsIn = (box: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}) => string[];

/**
 * Tiles that would draw undated: one inside a single cell that the index doesn't list, or one
 * across several cells none of which it lists. `boxOf` gives a tile's ground. At most `limit`
 * returned (the run row carries counts, never lists).
 */
export function undatedTiles(
  tileIds: Iterable<number>,
  index: Pick<NaipCellIndex, 'cells'>,
  boxOf: (tileId: number) => { west: number; south: number; east: number; north: number },
  cellsIn: CellsIn,
  limit = 50,
): { count: number; sample: number[] } {
  let count = 0;
  const sample: number[] = [];
  for (const id of tileIds) {
    const b = boxOf(id);
    // Shrunk by a hair: a tile edge that lies on a cell edge touches the neighbor only in name.
    const eps = 1e-9;
    const keys = cellsIn({
      minLat: b.south + eps,
      minLng: b.west + eps,
      maxLat: b.north - eps,
      maxLng: b.east - eps,
    });
    if (!keys.some((k) => k in index.cells)) {
      count++;
      if (sample.length < limit) sample.push(id);
    }
  }
  return { count, sample };
}
