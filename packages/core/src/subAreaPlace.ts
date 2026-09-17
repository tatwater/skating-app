/**
 * The bay view's header and wind caption (A09 / D175) — what a bay says about itself when it is
 * framed inside its parent's drawer, composed once here so web and mobile cannot disagree.
 *
 * The framing rule is the phase's principle applied to copy: a bay's own geometry is the only new
 * information it brings. What follows from geometry is **its own** (area, fetch, the depth clipped
 * from the parent's survey); what does not is **inherited and said to be** (elevation — the same
 * water surface; the wind rose — because our data has no finer answer, not because the wind is the
 * same); and nothing is ever inherited that would be a lie about the bay (depth).
 */

import { type DepthDisplay, type DepthSource, describeLakeDepth } from './lakeDepth';
import { formatAreaAcres, formatDepthFeet } from './units';

/** The bay fields the header reads — a subset of the `waterBodySubAreas` row. */
export interface SubAreaHeaderInput {
  name: string;
  surfaceAreaSqM: number;
  maxDepthM?: number;
  maxDepthSource?: DepthSource;
  depthUnderstatesMax?: boolean;
}

/** The parent fields the header inherits from. */
export interface SubAreaParentInput {
  name: string;
  elevationM?: number;
}

export interface SubAreaHeader {
  /** *"Part of Lake Champlain"* — the line under the bay's name. */
  partOf: string;
  /** The bay's own area, imperial (D25). */
  area: string;
  /**
   * The bay's own max depth, or `null` when none was derived — never the parent's. When the
   * contour lane produced it, the caption says the number is a floor.
   */
  depth: DepthDisplay | null;
  /** *"Elevation 95 ft — the lake's"* or `null`; inherited, and the copy says so. */
  elevation: string | null;
}

/** Feet, rounded, from meters — an elevation is read to the nearest foot on every surface. */
function formatElevationFeet(meters: number): string {
  return `${Math.round(meters * 3.28084).toLocaleString('en-US')} ft`;
}

/**
 * The bay header. `depth` reuses `describeLakeDepth` so a bay's number is framed exactly like a
 * lake's — measured reads plainly, modeled carries a `~` — with one addition: the contour lane's
 * `understatesMax`, which the lake header never needed because a lake's contour depth is stamped
 * on the body by the same ETL with the same caveat baked into its label. A bay's is derived from a
 * clip, and the deepest isobath fully inside a bay is a **lower bound** on the water it encloses.
 */
export function describeSubAreaHeader(
  bay: SubAreaHeaderInput,
  parent: SubAreaParentInput,
): SubAreaHeader {
  const base = describeLakeDepth({
    ...(bay.maxDepthM !== undefined ? { maxDepthM: bay.maxDepthM } : {}),
    ...(bay.maxDepthSource !== undefined ? { maxDepthSource: bay.maxDepthSource } : {}),
  });
  const depth =
    base === null
      ? null
      : bay.depthUnderstatesMax === true
        ? {
            ...base,
            text: `max at least ${formatDepthFeet(bay.maxDepthM as number)}`,
            caption: `${base.caption} The deepest charted contour inside this bay; the true maximum may be deeper.`,
          }
        : base;
  return {
    partOf: `Part of ${parent.name}`,
    area: formatAreaAcres(bay.surfaceAreaSqM),
    depth,
    elevation:
      parent.elevationM === undefined
        ? null
        : `Elevation ${formatElevationFeet(parent.elevationM)} — the lake’s`,
  };
}

/**
 * The caveat under every wind rose (A09 kickoff call 6): the rose is the 2 km reanalysis cell's,
 * wherever it is shown — for a bay *and* for a 12-acre pond, since the corpus median body is a
 * tenth of one cell. D3's rule against implying knowledge we do not have applies to a rose as much
 * as to an ice condition. A bay adds the half that *is* local: fetch, measured off its own outline.
 */
export function windRoseCaption(scope: 'body' | 'subArea'): string {
  const climate = 'Wind climate is the 2 km grid cell’s, not this water’s own';
  return scope === 'subArea'
    ? `${climate}; fetch is measured from this bay’s own outline.`
    : `${climate}.`;
}
