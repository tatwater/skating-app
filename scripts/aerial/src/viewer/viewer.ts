/**
 * **The verify report's viewer** (B05 §2.5): MapLibre over the archive's public URL, so a build can
 * be looked at before the console's swap exists — drawn the way the console will draw it (§4.1–§4.2).
 *
 * - The date index is fetched and parsed by **core's own** `parseNaipCellIndex` first; the layer is
 *   added only once it has loaded and names this archive (D318: no frame on screen without its
 *   date). An index that fails fails the layer: nothing draws, and the credit says so.
 * - The credit dates **the whole view**: core's `quarterQuadsIn` over the visible bounds, its
 *   `naipCreditRange` over those cells and its `formatNaipCreditRange` for the words, on load and on
 *   every `moveend`. No date is computed here.
 *
 * This file is the page's bundle entry (`page.ts` bundles it with core and `pmtiles`); MapLibre itself
 * is passed in, loaded by the page from unpkg as MapLibre's own README shows, pinned to the version
 * the web app resolves.
 */

import {
  formatNaipCreditRange,
  type NaipCellIndex,
  naipCreditRange,
  naipIndexUrl,
  parseNaipCellIndex,
  quarterQuadsIn,
} from '@skating/core';
import { PMTiles, Protocol } from 'pmtiles';

/** The slice of MapLibre's API the viewer uses. */
export interface ViewerMap {
  on(event: 'load' | 'moveend', fn: () => void): void;
  addSource(id: string, source: Record<string, unknown>): void;
  addLayer(layer: Record<string, unknown>): void;
  getBounds(): { getSouth(): number; getWest(): number; getNorth(): number; getEast(): number };
  fitBounds(bounds: [[number, number], [number, number]], options?: Record<string, unknown>): void;
}

export interface ViewerLibrary {
  Map: new (options: Record<string, unknown>) => ViewerMap;
  addProtocol(name: string, handler: unknown): void;
}

export interface ViewerConfig {
  /** The archive's public URL. */
  archiveUrl: string;
  /** Its file name, which the index must name. */
  archiveName: string;
  container: string;
}

/** Where the viewer writes its credit line. */
export interface CreditLine {
  textContent: string | null;
}

/** The credit for a view, by core's functions alone. Words are drafts (§4.2), as the console's. */
export function creditFor(
  index: NaipCellIndex,
  bounds: { south: number; west: number; north: number; east: number },
  grid: {
    cellsIn: typeof quarterQuadsIn;
    range: typeof naipCreditRange;
    format: typeof formatNaipCreditRange;
  } = { cellsIn: quarterQuadsIn, range: naipCreditRange, format: formatNaipCreditRange },
): string {
  const keys = grid.cellsIn({
    minLat: bounds.south,
    minLng: bounds.west,
    maxLat: bounds.north,
    maxLng: bounds.east,
  });
  const range = grid.range(index, keys);
  return range === null ? 'Aerial · NAIP · none in view' : `Aerial · NAIP ${grid.format(range)}`;
}

/** Start the viewer. Resolves once the layer is added (or the index has failed it). */
export async function startViewer(
  maplibre: ViewerLibrary,
  config: ViewerConfig,
  credit: CreditLine,
  env: {
    fetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    parse?: typeof parseNaipCellIndex;
    indexUrl?: typeof naipIndexUrl;
    credit?: typeof creditFor;
    archive?: {
      getHeader(): Promise<{ minLon: number; minLat: number; maxLon: number; maxLat: number }>;
    };
    /**
     * The page was opened at a view (`#zoom/lat/lng`, MapLibre's hash): keep it rather than fitting
     * the archive, so a link to one join opens on that join.
     */
    startsAtHash?: boolean;
  },
): Promise<{ ok: boolean }> {
  const protocol = new Protocol();
  maplibre.addProtocol('pmtiles', protocol.tile);
  const map = new maplibre.Map({
    container: config.container,
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#d9dee2' } }],
    },
    center: [-72.5, 44],
    zoom: 7,
    maxZoom: 19,
    // The view in the URL (`#zoom/lat/lng`), so a look at one join is a link anyone can open.
    hash: true,
  });
  credit.textContent = 'Aerial · NAIP · Loading…';
  const loaded = new Promise<void>((done) => map.on('load', done));

  let index: NaipCellIndex;
  try {
    const res = await env.fetch((env.indexUrl ?? naipIndexUrl)(config.archiveUrl));
    if (!res.ok) throw new Error(`the date index answered ${res.status}`);
    index = (env.parse ?? parseNaipCellIndex)(await res.json(), config.archiveName);
  } catch (e) {
    credit.textContent = `Aerial · NAIP · not drawn: ${(e as Error).message}`;
    return { ok: false };
  }

  const header = await (env.archive ?? new PMTiles(config.archiveUrl)).getHeader();
  await loaded;
  if (!env.startsAtHash) {
    map.fitBounds(
      [
        [header.minLon, header.minLat],
        [header.maxLon, header.maxLat],
      ],
      { padding: 20, animate: false },
    );
  }
  map.addSource('naip', { type: 'raster', url: `pmtiles://${config.archiveUrl}`, tileSize: 512 });
  map.addLayer({ id: 'naip', type: 'raster', source: 'naip' });
  const draw = (): void => {
    const b = map.getBounds();
    credit.textContent = (env.credit ?? creditFor)(index, {
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
    });
  };
  map.on('moveend', draw);
  draw();
  return { ok: true };
}
