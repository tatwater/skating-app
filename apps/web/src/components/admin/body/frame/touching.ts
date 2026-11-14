import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { waterBodyDisplayName } from '@skating/core';
import { useRef } from 'react';

import {
  isFailed,
  type Loadable,
  read,
  retryAll,
  useConsoleReads,
} from '@/components/admin/reads/consoleReads';

/**
 * **The bodies that touch this one** — `bodyConsole.consoleExtras`' `touchingBodyIds`, each read by
 * id (`waterBodies.get`) for its name and outline: the map draws them as neighbors, and Shape offers
 * the merge only when one exists (Review 13 #8). Bounded by the server: at most the 12 most
 * prominent bodies nearby are tested.
 *
 * `touchingBodyIds` is `null` for an outline too large to test (above 20,000 vertices): **not
 * computed**, which is not the same as none.
 */

/** What the touching test found, as the server says it. */
export interface TouchingFacts {
  touchingBodyIds: readonly string[] | null;
  /** More bodies stood nearby than the test read. */
  touchingCapped: boolean;
}

/** A body that touches this one. */
export interface Neighbor {
  id: string;
  name: string;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/**
 * The neighbors, each read by id: `undefined` while any loads, a failure if any failed (its *Try
 * again* re-runs each failed one), else every neighbor still listed. `null` when the test didn't
 * run (or the facts aren't in yet: `undefined` facts read nothing). The list keeps its identity
 * while its reads do, so a map drawing it isn't redrawn by a render.
 */
export function useNeighbors(facts: TouchingFacts | undefined): Loadable<readonly Neighbor[]> {
  const ids = facts?.touchingBodyIds ?? [];
  const specs = Object.fromEntries(
    ids.map((id) => [id, read(api.waterBodies.get, { waterBodyId: id as Id<'waterBodies'> })]),
  );
  const got = useConsoleReads(specs);
  const values = ids.map((id) => got[id]);
  const held = useRef<{ values: readonly unknown[]; out: Loadable<readonly Neighbor[]> }>({
    values: [],
    out: [],
  });
  if (facts === undefined) return undefined;
  const same =
    held.current.values.length === values.length &&
    held.current.values.every((v, i) => v === values[i]);
  if (same && held.current.out !== undefined && !isFailed(held.current.out)) {
    return held.current.out;
  }
  const failed = values.filter(isFailed);
  let out: Loadable<readonly Neighbor[]>;
  if (failed.length > 0) {
    out = retryAll(failed);
  } else if (values.some((v) => v === undefined)) {
    out = undefined;
  } else {
    out = values.flatMap((v) => {
      if (v === undefined || isFailed(v) || v === null || !v.available) return [];
      return [
        {
          id: v.body._id,
          name: waterBodyDisplayName(v.body.name),
          polygon: v.body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        },
      ];
    });
  }
  held.current = { values, out };
  return out;
}
