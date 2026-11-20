import { WIND_ARCHIVE_MIN_FETCH_M } from '@skating/core';
import { convexRun } from '@skating/run-log';
import { gridKey } from './wtk';

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
}

interface TargetPage {
  targets: Target[];
  scanned: number;
  belowFloor?: number;
  cursor: string;
  isDone: boolean;
}

type ReadPage = (
  name: 'waterBodies:listNeedingWindRose',
  args: { cursor?: string; refresh: true; minFetchM: number; importFloorOnly?: true },
) => TargetPage;

/** Snapshot and derive must agree on the corpus and grid, or derive can ask for unfetched cells. */
export function collectWindTargets(importFloorOnly: boolean, readPage: ReadPage = convexRun) {
  const cells = new Map<string, Target[]>();
  let scanned = 0;
  let belowFloor = 0;
  let bodies = 0;
  let cursor: string | undefined;
  let isDone = false;
  while (!isDone) {
    const page = readPage('waterBodies:listNeedingWindRose', {
      ...(cursor ? { cursor } : {}),
      // Both passes need all qualifying bodies, even those already stamped with a rose.
      refresh: true,
      minFetchM: WIND_ARCHIVE_MIN_FETCH_M,
      ...(importFloorOnly ? { importFloorOnly: true } : {}),
    });
    cursor = page.cursor;
    isDone = page.isDone;
    scanned += page.scanned;
    belowFloor += page.belowFloor ?? 0;
    bodies += page.targets.length;
    for (const target of page.targets) {
      const key = gridKey(target);
      const bucket = cells.get(key);
      if (bucket) bucket.push(target);
      else cells.set(key, [target]);
    }
  }
  return { cells, scanned, belowFloor, bodies };
}
