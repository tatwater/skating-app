/**
 * **The overviews** (B05 §2.3): the archive's tile zooms 7–10 (pixel zooms 8–11), built by the
 * assembler from the work tiles' own top tiles (tile zoom 11), each level from the one below — a few
 * hundred tiles for the region.
 *
 * A parent is its up-to-four children side by side, halved. GDAL does the pixels: a 1024 × 1024 VRT
 * of the children's WebP files (a missing child is simply absent, so transparent), then
 * `gdal_translate -outsize 512 512 -r average` to WebP q80, A06e's and the shards' setting. GDAL's
 * average **honors the alpha band** (checked on GDAL 3.13.2: a child of alternating opaque and empty
 * columns halves to its own color at alpha 128, not to a color darkened by the empty pixels), so a
 * coast or a border flight's edge doesn't grow a dark fringe at low zoom. A parent with no child is
 * never rendered, as `--skip-blank` writes no empty tile.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import { mustRun, type ProcessRunner, runProcess } from './process';

/** One child of a parent: which quadrant (0 or 1 on each axis), and its bytes. */
export interface OverviewChild {
  dx: 0 | 1;
  dy: 0 | 1;
  bytes: Uint8Array;
}

/** Renders a parent tile from its children. */
export interface OverviewRenderer {
  render(children: readonly OverviewChild[]): Promise<Uint8Array>;
}

/** The overview tiles of one zoom, ascending by id. */
export interface OverviewLevel {
  zoom: number;
  tiles: { tileId: number; bytes: Uint8Array }[];
}

/**
 * Build `fromZoom − 1` down to `minZoom` from `top` (tiles at `fromZoom`, by id). Returns the levels
 * shallowest first — the order they sit in the archive. `concurrency` parents render at once.
 */
export async function buildOverviews(
  top: ReadonlyMap<number, Uint8Array>,
  renderer: OverviewRenderer,
  options: { fromZoom: number; minZoom: number; concurrency?: number },
): Promise<OverviewLevel[]> {
  const levels: OverviewLevel[] = [];
  let below = top;
  for (let z = options.fromZoom - 1; z >= options.minZoom; z--) {
    const parents = new Map<number, OverviewChild[]>();
    for (const [id, bytes] of below) {
      const [cz, x, y] = tileIdToZxy(id);
      if (cz !== z + 1) throw new Error(`tile ${id} is at zoom ${cz}, not ${z + 1}`);
      const parent = zxyToTileId(z, x >> 1, y >> 1);
      const list = parents.get(parent) ?? [];
      list.push({ dx: (x & 1) as 0 | 1, dy: (y & 1) as 0 | 1, bytes });
      parents.set(parent, list);
    }
    const ids = [...parents.keys()].sort((a, b) => a - b);
    const rendered = new Map<number, Uint8Array>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++] as number;
        rendered.set(id, await renderer.render(parents.get(id) as OverviewChild[]));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
    levels.unshift({
      zoom: z,
      tiles: ids.map((tileId) => ({ tileId, bytes: rendered.get(tileId) as Uint8Array })),
    });
    below = new Map(ids.map((id) => [id, rendered.get(id) as Uint8Array]));
  }
  return levels;
}

const BANDS = ['Red', 'Green', 'Blue', 'Alpha'] as const;

/** The 1024 × 1024 four-band VRT over the children's files (named `child-<dx><dy>.webp`). */
export function parentVrt(
  children: readonly Pick<OverviewChild, 'dx' | 'dy'>[],
  tile = 512,
): string {
  const size = tile * 2;
  const bands = BANDS.map((interp, b) => {
    const sources = children
      .map(
        (c) =>
          `    <SimpleSource><SourceFilename relativeToVRT="1">child-${c.dx}${c.dy}.webp</SourceFilename>` +
          `<SourceBand>${b + 1}</SourceBand>` +
          `<SrcRect xOff="0" yOff="0" xSize="${tile}" ySize="${tile}"/>` +
          `<DstRect xOff="${c.dx * tile}" yOff="${c.dy * tile}" xSize="${tile}" ySize="${tile}"/>` +
          '</SimpleSource>',
      )
      .join('\n');
    return (
      `  <VRTRasterBand dataType="Byte" band="${b + 1}"><ColorInterp>${interp}</ColorInterp>\n` +
      `${sources}\n  </VRTRasterBand>`
    );
  });
  return `<VRTDataset rasterXSize="${size}" rasterYSize="${size}">\n${bands.join('\n')}\n</VRTDataset>\n`;
}

/** GDAL's `gdal_translate` arguments for one parent. */
export function parentTranslateArgs(quality: number, tile = 512): string[] {
  return [
    '-q',
    '-of',
    'WEBP',
    '-co',
    `QUALITY=${quality}`,
    '-outsize',
    String(tile),
    String(tile),
    '-r',
    'average',
    'parent.vrt',
    'parent.webp',
  ];
}

/** The GDAL renderer: one scratch directory per parent, removed after. */
export function gdalRenderer(
  options: { run?: ProcessRunner; quality?: number; scratch?: string } = {},
): OverviewRenderer {
  const run = options.run ?? runProcess;
  const quality = options.quality ?? 80;
  return {
    async render(children) {
      if (children.length === 0) throw new Error('a parent needs at least one child');
      const dir = await mkdtemp(join(options.scratch ?? tmpdir(), 'naip-overview-'));
      try {
        for (const c of children) await writeFile(join(dir, `child-${c.dx}${c.dy}.webp`), c.bytes);
        await writeFile(join(dir, 'parent.vrt'), parentVrt(children));
        await mustRun(run, 'gdal_translate', parentTranslateArgs(quality), { cwd: dir });
        return new Uint8Array(await readFile(join(dir, 'parent.webp')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
