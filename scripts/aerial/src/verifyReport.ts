/**
 * **What verify shows rather than refuses** (B05 §2.5): coverage per cell, the seams, the low-zoom
 * quilt, and the report page that holds them with every check's outcome and the viewer.
 *
 * - **Coverage.** Per quarter-quad, the pixels its frames supplied (the cut's counts, on the z16
 *   grid) over the pixels its nominal outline holds on that grid; anything under 99% is listed
 *   (expected: only cells cut by the coast or the Canadian border). It reads the cut's counts, which
 *   the worker took from the same alphas it tiled, rather than decoding the archive at z14: decoding
 *   is GDAL's job, and the spot reads already hold the archive to the shards byte for byte.
 * - **Seams.** Every cell edge whose two sides are dated by different flights (year or resolution),
 *   sampled a few per pair of flights, as the tile at tile zoom 14 over the edge's middle.
 * - **The quilt.** Every tile at tile zoom 8 (pixel zoom 9), laid out on its grid: the region at the
 *   zoom where the flights' tones show as a patchwork (§5.4).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NaipCellIndex } from '@skating/core';
import { type PMTiles, tileIdToZxy } from 'pmtiles';
import type { AssembledManifest } from './assemble/assemble';
import { totalCounts } from './assemble/cellIndex';
import { worldPixel } from './assemble/tileGrid';
import type { CheckResult, VerifyOutcome } from './verify';

/** Core's grid, injected (S's `quarterQuadCell` and `quarterQuadAt`). */
export interface Grid {
  cellBox(key: string): { minLat: number; minLng: number; maxLat: number; maxLng: number };
  cellAt(lat: number, lng: number): string;
}

/** Nominal pixels of a lat/lng box on the z16 grid (256-px tiles). */
export function boxPixelsAtZ16(b: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}): number {
  const a = worldPixel(b.minLng, b.maxLat, 16);
  const c = worldPixel(b.maxLng, b.minLat, 16);
  return (c.x - a.x) * (c.y - a.y);
}

/** Cells whose frames supplied under `threshold` of their outline, lowest first. */
export function coverage(
  manifest: AssembledManifest,
  grid: Pick<Grid, 'cellBox'>,
  threshold = 0.99,
): { key: string; share: number }[] {
  const totals = totalCounts(manifest.workTiles.map((w) => w.cellCounts));
  const out: { key: string; share: number }[] = [];
  for (const cell of manifest.cells) {
    const supplied = [...(totals.get(cell.key)?.values() ?? [])].reduce((n, v) => n + v, 0);
    const share = supplied / boxPixelsAtZ16(grid.cellBox(cell.key));
    if (share < threshold) out.push({ key: cell.key, share });
  }
  return out.sort((a, b) => a.share - b.share || (a.key < b.key ? -1 : 1));
}

/** A cell edge across which the dating flight changes. */
export interface Seam {
  a: string;
  b: string;
  /** `east` (b is a's east neighbor) or `north`. */
  side: 'east' | 'north';
  /** The edge's middle. */
  lat: number;
  lng: number;
  flights: [string, string];
}

const flightLabel = (index: NaipCellIndex, key: string): string | null => {
  const first = index.cells[key]?.[0];
  if (first === undefined) return null;
  const f = index.flights[first];
  return f === undefined ? null : `${f.state} ${f.date} ${f.gsd} m`;
};

const differs = (index: NaipCellIndex, a: string, b: string): boolean => {
  const fa = index.flights[index.cells[a]?.[0] as number];
  const fb = index.flights[index.cells[b]?.[0] as number];
  if (fa === undefined || fb === undefined) return false;
  return fa.date.slice(0, 4) !== fb.date.slice(0, 4) || fa.gsd !== fb.gsd;
};

/** Edges between dated cells whose pick flights differ in year or resolution, a few per pair. */
export function seams(index: NaipCellIndex, grid: Grid, perPair = 3, cap = 120): Seam[] {
  const byPair = new Map<string, Seam[]>();
  for (const a of Object.keys(index.cells).sort()) {
    const box = grid.cellBox(a);
    const midLat = (box.minLat + box.maxLat) / 2;
    const midLng = (box.minLng + box.maxLng) / 2;
    const eps = 1e-6;
    const neighbors: [Seam['side'], string, number, number][] = [
      ['east', grid.cellAt(midLat, box.maxLng + eps), midLat, box.maxLng],
      ['north', grid.cellAt(box.maxLat + eps, midLng), box.maxLat, midLng],
    ];
    for (const [side, b, lat, lng] of neighbors) {
      if (!(b in index.cells) || !differs(index, a, b)) continue;
      const flights: [string, string] = [
        flightLabel(index, a) as string,
        flightLabel(index, b) as string,
      ];
      const pair = [...flights].sort().join(' | ');
      const list = byPair.get(pair) ?? [];
      if (list.length < perPair) list.push({ a, b, side, lat, lng, flights });
      byPair.set(pair, list);
    }
  }
  return [...byPair.values()].flat().slice(0, cap);
}

/** The tile at tile zoom `z` (512 px) over a point. */
export function tileAt(lat: number, lng: number, z: number): [number, number, number] {
  // A 512-px tile at tile zoom z is a 256-px tile at pixel zoom z + 1: the slippy x/y at z.
  const p = worldPixel(lng, lat, z);
  return [z, Math.floor(p.x / 256), Math.floor(p.y / 256)];
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function checkHtml(c: CheckResult): string {
  const status = c.problems.length === 0 ? 'passed' : `failed (${c.problems.length})`;
  const counts = Object.entries(c.counts)
    .map(([k, v]) => `${esc(k)} ${v.toLocaleString('en-US')}`)
    .join(' · ');
  const problems = c.problems.map((p) => `<li>${esc(p)}</li>`).join('');
  const notes = c.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  return `<section><h2>${esc(c.name)}: ${status}</h2><p>${counts}</p>${problems ? `<ul class="bad">${problems}</ul>` : ''}${notes ? `<ul>${notes}</ul>` : ''}</section>`;
}

/**
 * Write the report under `dir`: `report.json` (every check), `index.html`, the seams' and the
 * quilt's tiles. `archive` reads tiles for the sheets (the public URL); `grid` is core's.
 */
export async function writeReport(
  dir: string,
  outcome: VerifyOutcome,
  options: { archive: PMTiles | null; grid: Grid | null; title: string; seamZoom?: number },
): Promise<{ seams: number; quilt: number; lowCoverage: number }> {
  await mkdir(join(dir, 'tiles'), { recursive: true });
  const ctx = outcome.context;
  const parts: string[] = outcome.checks.map(checkHtml);
  let seamCount = 0;
  let quiltCount = 0;
  let low: { key: string; share: number }[] = [];

  if (ctx !== null && options.grid !== null) {
    low = coverage(ctx.manifest, options.grid);
    parts.push(
      `<section><h2>Coverage: ${low.length} cells under 99%</h2><p>Expected: only cells cut by the coast or the border.</p><ul>${low
        .slice(0, 200)
        .map((c) => `<li>${esc(c.key)} ${(c.share * 100).toFixed(1)}%</li>`)
        .join('')}</ul></section>`,
    );
  }
  if (ctx !== null && ctx.index !== null && options.grid !== null && options.archive !== null) {
    const found = seams(ctx.index, options.grid);
    const cards: string[] = [];
    for (const s of found) {
      const [z, x, y] = tileAt(s.lat, s.lng, options.seamZoom ?? 14);
      const got = await options.archive.getZxy(z, x, y);
      if (got === undefined) continue;
      const file = `tiles/seam-${z}-${x}-${y}.webp`;
      await writeFile(join(dir, file), new Uint8Array(got.data));
      cards.push(
        `<figure><img src="${file}" width="256" height="256" alt=""><figcaption>${esc(s.a)} (${esc(s.flights[0])}) | ${esc(s.b)} (${esc(s.flights[1])}), ${s.side}</figcaption></figure>`,
      );
      seamCount++;
    }
    parts.push(
      `<section><h2>Seams: ${seamCount}</h2><div class="grid">${cards.join('')}</div></section>`,
    );
  }
  if (ctx !== null && options.archive !== null) {
    const quilt = [...ctx.tileIds].filter((id) => tileIdToZxy(id)[0] === 8);
    const xs = quilt.map((id) => tileIdToZxy(id)[1]);
    const ys = quilt.map((id) => tileIdToZxy(id)[2]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const cells: string[] = [];
    for (const id of quilt) {
      const [z, x, y] = tileIdToZxy(id);
      const got = await options.archive.getZxy(z, x, y);
      if (got === undefined) continue;
      const file = `tiles/quilt-${z}-${x}-${y}.webp`;
      await writeFile(join(dir, file), new Uint8Array(got.data));
      cells.push(
        `<img src="${file}" style="grid-column:${x - minX + 1};grid-row:${y - minY + 1}" width="128" height="128" alt="">`,
      );
      quiltCount++;
    }
    parts.push(
      `<section><h2>The quilt at pixel zoom 9</h2><div class="quilt">${cells.join('')}</div></section>`,
    );
  }
  parts.push(
    '<section><h2>Viewer</h2><p><a href="viewer/">Open the viewer</a> (serve this folder on localhost:3000).</p></section>',
  );

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(options.title)}</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;max-width:1200px;background:#fff;color:#1d2327}.bad{color:#a4161a}.grid{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:256px}figcaption{font-size:12px}.quilt{display:grid;grid-auto-columns:128px;grid-auto-rows:128px;gap:0}</style></head><body><h1>${esc(options.title)}: ${outcome.ok ? 'passed' : 'refused'}</h1>${parts.join('\n')}</body></html>\n`;
  await writeFile(join(dir, 'index.html'), html);
  await writeFile(
    join(dir, 'report.json'),
    JSON.stringify(
      {
        ok: outcome.ok,
        checks: outcome.checks,
        lowCoverage: low,
        seams: seamCount,
        quilt: quiltCount,
      },
      null,
      2,
    ),
  );
  return { seams: seamCount, quilt: quiltCount, lowCoverage: low.length };
}
