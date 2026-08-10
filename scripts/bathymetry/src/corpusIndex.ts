/**
 * The corpus, on disk, indexed for point-in-polygon — **what the D95 re-key lane resolves against**.
 *
 * ## Why this is local, and why the first version was not
 *
 * The re-key asks one question, 17,922 times: *which body contains this sounding?* The first build
 * asked the deployment, one `listedBodiesNearCoord` per point, batched and adaptively split to
 * survive Convex's 16 MB read cap. It worked and it was far too slow — **4+ hours for one source
 * key** — because a scattered survey pulls a disjoint set of shorelines for every point, so every
 * batch tripped the cap and halved 250 → 15, burning five failed calls per success.
 *
 * A lookup grid was added to fix that, on the reasoning that *"a sounding survey is dense — transects
 * run tens of metres apart — so rounding collapses many measurements onto one lookup."* That is true
 * of a normal lake survey and **exactly false for the one key the lane exists for**: MIDAS 870's
 * soundings are scattered one or two per lake across 263 lakes and 348 km, so no two share an 11 m
 * cell. Measured: **16,191 measurements → 16,155 cells.** A 0.2% reduction. The optimisation was
 * written for the common case, and the pathological case is the entire job.
 *
 * None of it was necessary. **The corpus is already on disk** — `bodies.ndjson` is the merge's own
 * output, every polygon, and the re-key only needs to *split* a survey by body. The synthetic lakes
 * it emits go through the ordinary join afterwards, which resolves `waterBodyId` server-side exactly
 * as it always has. So there is no identity to look up here, only geometry to test, and geometry is
 * free.
 *
 * The same technique measured 40,260 depth-source records against 5,882 polygons in seconds.
 *
 * ## The index
 *
 * A flat grid keyed on a 0.05° cell (~4 km), bodies filed under every cell their bbox touches. The
 * corpus is ~25,000 polygons and a bbox test rejects almost everything before any ring arithmetic,
 * so this is a few hundred milliseconds to build and microseconds to probe.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type BBox, pointInPolygon } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/** A corpus body, as `bodies.ndjson` carries it. */
export interface CorpusBody {
  /** `<source>:<externalId>` — what a re-keyed lake is suffixed with, and what tiles are stamped with. */
  key: string;
  externalId: string;
  source: string;
  name: string;
  surfaceAreaSqM: number;
  bbox: BBox;
  polygon: Polygon | MultiPolygon;
}

/** Grid cell size in degrees, ~4 km at our latitude. */
const CELL_DEG = 0.05;

export interface CorpusIndex {
  bodies: CorpusBody[];
  cells: Map<string, CorpusBody[]>;
}

function cellKeys(bbox: BBox): string[] {
  const out: string[] = [];
  for (let x = Math.floor(bbox.minLng / CELL_DEG); x <= Math.floor(bbox.maxLng / CELL_DEG); x++) {
    for (let y = Math.floor(bbox.minLat / CELL_DEG); y <= Math.floor(bbox.maxLat / CELL_DEG); y++) {
      out.push(`${x}:${y}`);
    }
  }
  return out;
}

export function buildCorpusIndex(bodies: readonly CorpusBody[]): CorpusIndex {
  const cells = new Map<string, CorpusBody[]>();
  for (const body of bodies) {
    for (const key of cellKeys(body.bbox)) {
      const list = cells.get(key);
      if (list) list.push(body);
      else cells.set(key, [body]);
    }
  }
  return { bodies: [...bodies], cells };
}

/**
 * The body a point falls in — **largest first, like the server's join**.
 *
 * `bodiesCoveringPoint` ranks containment before proximity and then by area, so a point inside a bay
 * that is inside a lake is attributed to the lake. That rule is why Moosehead Lake stopped arriving
 * as North Bay, and the local path has to keep it or the two resolvers would disagree about nested
 * water.
 *
 * No buffer: this is membership. A sounding *near* a lake is not *in* it, and the ordinary join that
 * runs afterwards has its own proximity rules.
 */
export function coveringBody(
  index: CorpusIndex,
  point: { lat: number; lng: number },
): CorpusBody | null {
  const cell = `${Math.floor(point.lng / CELL_DEG)}:${Math.floor(point.lat / CELL_DEG)}`;
  let best: CorpusBody | null = null;
  for (const body of index.cells.get(cell) ?? []) {
    // The bbox rejects almost everything before any ring arithmetic runs.
    if (
      point.lat < body.bbox.minLat ||
      point.lat > body.bbox.maxLat ||
      point.lng < body.bbox.minLng ||
      point.lng > body.bbox.maxLng
    ) {
      continue;
    }
    if (!pointInPolygon(point, body.polygon)) continue;
    if (best === null || body.surfaceAreaSqM > best.surfaceAreaSqM) best = body;
  }
  return best;
}

/** Stream `bodies.ndjson` into memory. Geometry included — that is the point. */
export async function readCorpusBodies(path: string): Promise<CorpusBody[]> {
  const out: CorpusBody[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as {
      source: string;
      externalId: string;
      name?: string;
      surfaceAreaSqM?: number;
      bbox: BBox;
      polygon: Polygon | MultiPolygon;
    };
    out.push({
      key: `${row.source}:${row.externalId}`,
      externalId: row.externalId,
      source: row.source,
      name: row.name ?? '',
      surfaceAreaSqM: row.surfaceAreaSqM ?? 0,
      bbox: row.bbox,
      polygon: row.polygon,
    });
  }
  return out;
}
