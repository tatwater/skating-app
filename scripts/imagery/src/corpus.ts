/**
 * Paging the corpus out of Convex for the mask bake (N6e PR 2a).
 *
 * Subprocess boundary — `convexRun` shells to `pnpm exec convex run`, the same way every other ETL
 * here reaches an `internalQuery`. Excluded from coverage on the usual rule: the decisions live in
 * `revealMasks.ts`, and what is left is a loop around a process boundary.
 */

import { convexRun } from '@skating/run-log';
import type { CorpusMaskRow } from './revealMasks';

/** One page of `imageryMasks:listForImageryMask`. */
interface MaskPage {
  masks: CorpusMaskRow[];
  scanned: number;
  belowFloor: number;
  cursor: string | null;
  isDone: boolean;
}

export interface CorpusScanProgress {
  pages: number;
  scanned: number;
  belowFloor: number;
}

/**
 * Yield every corpus body's mask input, one page at a time.
 *
 * A generator rather than an array, because the whole corpus of polygons is hundreds of megabytes
 * and the caller writes each feature to disk as it arrives — holding all 25,197 buffered shapes in
 * memory at once is the difference between a bake that runs on a laptop and one that does not.
 */
export async function* scanCorpusMasks(
  batchSize: number,
  onProgress?: (progress: CorpusScanProgress) => void,
): AsyncGenerator<CorpusMaskRow> {
  let cursor: string | undefined;
  const progress: CorpusScanProgress = { pages: 0, scanned: 0, belowFloor: 0 };

  for (;;) {
    const page = convexRun<MaskPage>('imageryMasks:listForImageryMask', {
      ...(cursor === undefined ? {} : { cursor }),
      batchSize,
    });

    progress.pages++;
    progress.scanned += page.scanned;
    progress.belowFloor += page.belowFloor;
    onProgress?.(progress);

    for (const row of page.masks) yield row;

    // `isDone` is the authority, not an empty page: a page can legitimately return zero masks when
    // every body in it fell below the corpus floor, and stopping on that would truncate the bake
    // somewhere in the middle of the alphabet with nothing saying so.
    if (page.isDone || !page.cursor) return;
    cursor = page.cursor;
  }
}
