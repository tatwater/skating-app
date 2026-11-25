import type { MapItem } from '../../body/map/mapDescriptors';
import { frameBox, growBox, outlineCoords } from '../../inbox/map/inboxMapFrame';
import type { EmbedBody, InboxLegendRow, InboxMapView } from '../../inbox/map/inboxMapScene';

/**
 * **What a Corpus task's head map draws** (boards 4.2 and 4.3) — a pure builder over the Inbox
 * embed's vocabulary (`inboxMapScene`'s {@link InboxMapView}, `body/map`'s descriptors), so the
 * head map is the console map, not a second one:
 *
 * - **The body**, in the body's own style (the brightest line on the map), and the camera framed
 *   on it with a fifth of its size around it on each side — the boards' `pad: 0.2`.
 * - **Its neighbors** (the item's, from the stored geometry facts, at most three) in the quiet
 *   neighbor style, each named on the map at the point of its shore nearest the body (Taylor Pond's
 *   head under The Basin). They don't move the frame: the operator may pan and zoom out to them
 *   (the reach), as 4.3's *Osmore Pond* sits off the frame.
 * - **A legend plate**, when the handler gives the outline's words (4.3: whose drawing it is).
 *
 * Nothing here reads Convex; the head map's container turns the reads into these inputs.
 */

export type HeadMapInput = {
  body: EmbedBody;
  neighbors?: readonly EmbedBody[];
  /** The legend's row for the body's outline ("Outline · OSM · 5 ac"); none draws no plate. */
  outlineLabel?: string;
  caption?: string;
};

/** The room round the body, as a share of its own size on each side (the boards' `pad: 0.2`). */
export const HEAD_MAP_GROW = 0.2;

const outline = (b: EmbedBody, style: 'body' | 'neighbor'): MapItem => ({
  kind: 'outline',
  id: `${style === 'body' ? 'body' : 'neighbor'}:${b.id}`,
  layer: 'outline',
  geometry: b.outline,
  style,
});

/** The neighbor's vertex nearest the body's middle: where its name sits on the head map. */
function labelPoint(neighbor: EmbedBody, middle: readonly [number, number]): MapItem | null {
  const coords = outlineCoords(neighbor.outline);
  if (coords.length === 0 || neighbor.name.trim() === '') return null;
  const k = Math.cos((middle[1] * Math.PI) / 180);
  let best = coords[0] as readonly [number, number];
  let bestD = Infinity;
  for (const c of coords) {
    const dx = (c[0] - middle[0]) * k;
    const dy = c[1] - middle[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return {
    kind: 'label',
    id: `neighbor:${neighbor.id}:name`,
    layer: 'outline',
    at: best,
    text: neighbor.name,
    style: 'town',
  };
}

export function headMapScene({
  body,
  neighbors = [],
  outlineLabel,
  caption,
}: HeadMapInput): InboxMapView {
  const own = outlineCoords(body.outline);
  if (own.length === 0) throw new Error('A head map needs the body’s outline.');
  const frame = growBox(frameBox(own as [(typeof own)[number], ...typeof own]), HEAD_MAP_GROW);
  const middle: [number, number] = [
    (frame.minLng + frame.maxLng) / 2,
    (frame.minLat + frame.maxLat) / 2,
  ];
  const drawnNeighbors = neighbors.filter((n) => outlineCoords(n.outline).length > 0);
  const items: MapItem[] = [
    ...drawnNeighbors.map((n) => outline(n, 'neighbor')),
    outline(body, 'body'),
    ...drawnNeighbors.flatMap((n) => labelPoint(n, middle) ?? []),
  ];
  const layers = { outline: true } as const;
  const reachCoords = drawnNeighbors.flatMap((n) => outlineCoords(n.outline));
  const reach =
    reachCoords.length > 0
      ? frameBox([
          [frame.minLng, frame.minLat],
          [frame.maxLng, frame.maxLat],
          ...reachCoords,
        ])
      : null;
  const legend: InboxLegendRow[] =
    outlineLabel === undefined
      ? []
      : [{ label: outlineLabel, stroke: { kind: 'outline', style: 'body' } }];
  return {
    frame,
    reach,
    scene: { items, lit: null, layers },
    legend,
    caption: caption ?? null,
  };
}

/** A stored outline as the embed draws it: a polygon or a multipolygon, anything else nothing. */
export function embedOutline(
  geometry: { type: string; coordinates?: unknown } | null | undefined,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (geometry == null) return null;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  }
  return null;
}
