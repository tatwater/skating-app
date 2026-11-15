import { waterBodyDisplayName } from '@skating/core';

/**
 * **The bodies that touch this one** — `bodyConsole.consoleExtras`' `touching`: each neighbor with
 * its name and a simplified outline, computed with the body's geometry at the write. The map draws
 * them as neighbors, and Shape offers the merge only when one exists (Review 13 #8). Nothing is read
 * per neighbor.
 *
 * `geoComputedAt` is `null` until the body's geometry has been computed: the touching bodies are
 * then **not computed yet**, which is not the same as none.
 */

/** What the touching test found, as the server says it. */
export interface TouchingFacts {
  /** The neighbors' ids; `null` until computed. */
  touchingBodyIds: readonly string[] | null;
  /** Each neighbor, its name and simplified outer ring; `null` until computed. */
  touching: readonly { waterBodyId: string; name: string; ring: number[][] }[] | null;
  /** More bodies stood nearby than the test read. */
  touchingCapped: boolean;
  /** When the body's geometry was computed; `null` until it has been. */
  geoComputedAt: number | null;
}

/** A body that touches this one. */
export interface Neighbor {
  id: string;
  name: string;
  polygon: GeoJSON.Polygon;
}

/** The neighbors to draw: none until the geometry is computed (Shape says *not computed yet*). */
export function neighborsOf(facts: TouchingFacts): readonly Neighbor[] {
  return (facts.touching ?? []).map((n) => ({
    id: n.waterBodyId,
    name: waterBodyDisplayName(n.name),
    polygon: { type: 'Polygon', coordinates: [n.ring] },
  }));
}
