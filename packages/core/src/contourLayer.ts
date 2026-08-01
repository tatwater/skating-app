/**
 * How bathymetric contours are drawn, and what the drawer says about them (N6b).
 *
 * Shared by web and mobile for the same reason `hazardLayer` is: *what gets drawn* is decided once,
 * and only the colours are per-app. But the reason is different here, and it is worth naming, because
 * these are the app's least important lines and its most easily misread ones.
 *
 * ## D81 — visibility is derived, never managed
 *
 * > *"I actually don't want the contour lines to be manually toggleable! I want them always visible
 * > when the water body detail is open, unless the satellite imagery is turned on."*
 *
 * Contours are a property of the detail view. There is no toggle, no persisted preference, no settings
 * row — the layer's visibility is a function of something the app already knows, which body is
 * selected. So the client's whole job is: on drawer-open, add the source and filter it to one
 * `bodyId`; on close, remove it. `contourFilter` is that filter.
 *
 * ## D82 — the palette must not be mistakable for the hazard palette
 *
 * > *"Depth's safety role stays inside the math. The contour layer makes no safety claim, because it
 * > makes no claim at all."*
 *
 * The one styling rule that carries real weight. A blue-to-navy depth ramp a skater could read as a
 * severity scale would reintroduce **through colour** exactly the claim we declined to make in words,
 * and it would do it silently. So the ramp is a single hue varying only in lightness, hazards render
 * above contours, and if the two ever compete for legibility the contour is the one that loses.
 *
 * ## D89 — the interval is a fixed ladder
 *
 * Every lake is drawn every 5 ft (or a whole multiple, where depth or thin data forced the ladder
 * coarser). That is what lets the drawer say *"5 ft contours"* from a feature property rather than
 * re-deriving it from geometry, and it is why ring count is worth reading as depth.
 */

/** The MapLibre source and layer ids, so both clients name them the same thing. */
export const CONTOUR_SOURCE_ID = 'bathymetry';
export const CONTOUR_LAYER_ID = 'bathymetry-contours';
/** The `layer` name inside the PMTiles archive — set by `tile.sh`. */
export const CONTOUR_SOURCE_LAYER = 'bathymetry';

/**
 * The floor below which contours are not drawn, however open the drawer is.
 *
 * **A guard rail, not the mechanism.** D81 keeps contours off the browse map entirely, so there is
 * nothing here to fight `displayScore` for prominence. This exists only because a drawer can be open
 * while the camera is zoomed out, and a lake's isobaths at z6 are a smear that says nothing.
 */
export const CONTOUR_MIN_ZOOM = 11;

/** Per-app colours. One hue; only lightness varies. See D82 above for why that is not a preference. */
export interface ContourPalette {
  /** The shallowest contour. */
  shallow: string;
  /** The deepest contour. */
  deep: string;
}

/** One contour, as a client reads it back off the tile. */
export interface ContourFeatureProperties {
  bodyId: string;
  depthFt: number;
  lane: 'surveyed' | 'interpolated';
  agency: string;
  state: string;
  intervalFt: number | null;
}

/**
 * Draw only the open lake's contours.
 *
 * The whole of D81 in one expression. `bodyId` is the OSM `externalId` rather than the Convex `_id`,
 * because `_id` changes if a row is ever recreated and re-tiling five states because a re-import
 * churned ids is not a thing we should be one accident away from.
 */
export function contourFilter(bodyId: string | undefined): unknown[] {
  // No body selected means no contours — not "all contours". Getting this backwards would put every
  // surveyed lake in the region on the browse map, which is precisely what D81 removed.
  if (!bodyId) return ['==', ['literal', true], ['literal', false]];
  return ['==', ['get', 'bodyId'], bodyId];
}

/**
 * Colour by depth, within a single hue.
 *
 * `maxDepthFt` scales the ramp to the lake on screen rather than to the corpus: a 17 ft pond and a
 * 400 ft lake should both read as "shallow at the edge, deep in the middle", and a corpus-wide ramp
 * would render every shallow lake in one flat tint. It is a *relative* reading either way — D82 means
 * the layer makes no claim, so there is nothing for an absolute scale to be faithful to.
 */
export function contourColorExpression(palette: ContourPalette, maxDepthFt: number): unknown[] {
  const top = Math.max(1, maxDepthFt);
  return [
    'interpolate',
    ['linear'],
    ['to-number', ['get', 'depthFt'], 0],
    0,
    palette.shallow,
    top,
    palette.deep,
  ];
}

/**
 * Line width by zoom.
 *
 * Deliberately thin at every zoom. Under D82 the contour is the layer that loses when anything
 * competes for legibility, and a hairline is how that rule looks in a stylesheet rather than in a
 * document nobody re-reads.
 */
export function contourWidthExpression(): unknown[] {
  return ['interpolate', ['linear'], ['zoom'], CONTOUR_MIN_ZOOM, 0.5, 14, 1.1, 17, 1.6];
}

/** Opacity when fully faded in. Below 1 so the basemap's labels stay readable underneath. */
export const CONTOUR_OPACITY = 0.75;

/**
 * How long the drawer-open fade takes, in ms.
 *
 * *"Fading in on open reads as a detail revealing itself; popping in reads as a bug. This is a small
 * thing that is entirely the feature."*
 */
export const CONTOUR_FADE_MS = 220;

/**
 * The credit line for whatever is on screen, and any notice its source requires.
 *
 * **Scoped to the body, not a standing list of all five states** — which is only possible *because*
 * contours are detail-view-only (D81), so we always know whose data is drawn. §5's finding was that
 * the minimum is smaller than it looks and belongs at the bottom of the drawer, next to the depth
 * provenance N6a already renders and the Open-Meteo credit the weather strip already carries.
 *
 * The lane is carried separately from the agency because they are **different claims**: a state's own
 * isobaths and a surface we fitted through its soundings must never render as the same thing (§Maine
 * step 5, and gate 3 of §6).
 */
export interface ContourCredit {
  agencies: string[];
  /** Present when any drawn contour is ours rather than the agency's. */
  interpolated: boolean;
  /** `null` when the drawn features disagree, which should not happen within one body. */
  intervalFt: number | null;
  notices: string[];
}

/**
 * Build the drawer credit from the features actually drawn.
 *
 * Derived from the tile rather than from a lookup table keyed by state, because the tile is what is
 * on screen — and a lake can only be credited to the agency whose lines are visible.
 */
export function contourCredit(
  features: readonly Partial<ContourFeatureProperties>[],
  noticesByAgency: Readonly<Record<string, string>> = {},
): ContourCredit | undefined {
  if (features.length === 0) return undefined;

  const agencies: string[] = [];
  const notices: string[] = [];
  const intervals = new Set<number>();
  let interpolated = false;

  for (const feature of features) {
    const agency = feature.agency?.trim();
    if (agency && !agencies.includes(agency)) {
      agencies.push(agency);
      const notice = noticesByAgency[agency];
      if (notice && !notices.includes(notice)) notices.push(notice);
    }
    if (feature.lane === 'interpolated') interpolated = true;
    if (typeof feature.intervalFt === 'number') intervals.add(feature.intervalFt);
  }

  if (agencies.length === 0) return undefined;
  return {
    agencies,
    interpolated,
    // One body should carry one interval. Disagreement means two sources overlapped, and the honest
    // answer is to say nothing rather than to pick one and label the other's lines with it.
    intervalFt: intervals.size === 1 ? ([...intervals][0] as number) : null,
    notices,
  };
}

/**
 * The credit as one line of drawer copy.
 *
 * Provenance only. **No interpretation** — D82 means the single sentence that survives is who
 * surveyed this and at what spacing, and nothing about what the depth implies for ice.
 */
export function formatContourCredit(credit: ContourCredit | undefined): string {
  if (!credit) return '';
  const source = credit.agencies.join(' · ');
  const interval = credit.intervalFt ? `${credit.intervalFt} ft contours` : 'depth contours';
  const claim = credit.interpolated
    ? `${interval}, interpolated from soundings published by ${source}`
    : `${interval} surveyed by ${source}`;
  return credit.notices.length > 0 ? `${claim}. ${credit.notices.join(' ')}` : claim;
}
