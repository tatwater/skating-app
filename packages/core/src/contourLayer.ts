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
 * The layer the contours are inserted *beneath*.
 *
 * D82's z-order in one constant: hazards are the product and contours are decoration, so the
 * contours go under everything a skater can act on. Both clients add the water fill/outline and the
 * bay outlines at map-init, so inserting before the first bay layer puts contours directly above the
 * lake's own fill and below every pin, track and hazard that comes after it.
 */
export const CONTOUR_BEFORE_LAYER_ID = 'sub-area-outline';

/**
 * The vector source, from the archive URL.
 *
 * The `pmtiles://` prefix lives here rather than at two call sites because it is the difference
 * between a source that range-reads an archive and one that asks a static host for a TileJSON
 * document it does not have — and the failure is a lake that renders flat, which looks exactly like
 * a lake no agency ever surveyed.
 */
export function contourSourceSpec(archiveUrl: string): {
  type: 'vector';
  url: string;
} {
  return { type: 'vector', url: `pmtiles://${archiveUrl}` };
}

/**
 * The id a contour line is stamped with, and the id the client filters on.
 *
 * **The OSM `externalId`, falling back to the Convex `_id`.** `_id` changes if a row is ever
 * recreated, and re-tiling five states because a re-import churned ids is not a thing we should be
 * one accident away from; `externalId` is what `importCanonical` upserts on, so it survives a
 * re-import by construction. The fallback exists so a body somehow lacking an `externalId` still
 * renders rather than silently vanishing.
 *
 * Shared with the ETL (`scripts/bathymetry`'s `stampBodyId` delegates here) because the two sides
 * agreeing is the whole contract: a stamp and a filter that disagree draw nothing, with no error.
 */
export function contourBodyKey(externalId: string | undefined, fallbackId: string): string {
  return externalId?.trim() || fallbackId;
}

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
export function contourFilter(bodyId: string | null | undefined): unknown[] {
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
 * The deepest contour among the lines actually drawn.
 *
 * Feeds `contourColorExpression`, which scales the ramp to the lake on screen. Read off the tile
 * rather than from the body's N6a `maxDepthM` on purpose: the ramp has to span *the rings that are
 * drawn*, and the two numbers are from different sources — a lake whose deepest sounding is 42 ft
 * can carry a GLOBathy-derived `maxDepthM` of 60, which would leave every drawn ring in the pale
 * two-thirds of the ramp and flatten exactly the contrast the ramp exists to give.
 */
export function maxContourDepthFt(
  features: readonly Partial<ContourFeatureProperties>[],
): number | undefined {
  let deepest: number | undefined;
  for (const feature of features) {
    const depth = feature.depthFt;
    if (typeof depth !== 'number' || !Number.isFinite(depth)) continue;
    if (deepest === undefined || depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * What an agency's own terms require us to render, keyed by the `agency` a tile carries.
 *
 * **The tile carries a short agency label; the licence requires particular words.** For four of the
 * five sources those are nearly the same thing, and for the fifth they are not: VCGI's terms name
 * the University of Vermont as the copyright holder, and NOAA asks that attribution neither imply
 * its endorsement nor present modified data as unaltered NOAA data — so *"VCGI / NOAA"*, which is
 * what the tile says, is precisely the credit we may not render (see the phase doc, §The NOAA
 * notice). Hence a registry: the tile stays small and the required wording stays verbatim.
 *
 * **Mirrored from `scripts/bathymetry/src/sources.ts`, and the ETL's test suite asserts they match**
 * — `attribution` → `credit`, `notice` → `notice`, for every source. Duplicating it is deliberate:
 * the app cannot import from `scripts/`, and a client-side lookup table nobody checks against its
 * source is how a credit goes quietly stale after an agency's terms change.
 *
 * The notice is a **separate obligation** from the credit and is stored as its own field rather than
 * folded into the attribution string, because a reader checking one should not have to parse the
 * other to find it.
 */
export interface ContourSourceTerms {
  /** The attribution, exactly as the source's terms require it. Never paraphrased. */
  credit: string;
  /** A notice the terms require alongside the credit. */
  notice?: string;
}

export const CONTOUR_SOURCE_TERMS: Readonly<Record<string, ContourSourceTerms>> = {
  'NH GRANIT': {
    credit: 'NH Department of Environmental Services · NH Fish and Game (NH GRANIT)',
  },
  'VCGI / NOAA': {
    credit: 'Soundings digitised from NOAA nautical charts by University of Vermont and VCGI',
    notice: 'Not for navigation.',
  },
  'VT ANR': { credit: 'Vermont Agency of Natural Resources' },
  'MassGIS / MassWildlife': {
    credit: 'MassGIS · MassWildlife (Massachusetts Division of Fisheries & Wildlife)',
  },
  'Maine DEP / MaineIF&W': {
    credit:
      'Maine Department of Environmental Protection · Maine Dept. of Inland Fisheries & Wildlife',
  },
};

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
  /** The required wording per agency, resolved through `CONTOUR_SOURCE_TERMS`. */
  agencies: string[];
  /**
   * Whose lines these are. `'mixed'` when the drawn set contains both, which is handled here for
   * the same reason `intervalFt` goes `null` on disagreement: **the honest answer to "two sources
   * drew this lake" is to say so, not to pick one and label the other's lines with it.**
   *
   * A single boolean got this exactly backwards — any fitted line made the whole body read
   * *"interpolated by us"*, over a credit list that included the agency whose own survey was also on
   * screen. That is gate 3 of §6 inverted: the two claims must never render as the same thing, and
   * the same thing they rendered as was ours.
   *
   * The ETL now refuses to build a body from two lanes at all (`preferSurveyedLane`), so this should
   * not arise — but a tile archive outlives the build that made it, and the client is what a stale
   * archive is read by.
   */
  lane: 'surveyed' | 'interpolated' | 'mixed';
  /** `null` when the drawn features disagree, which should not happen within one body. */
  intervalFt: number | null;
  notices: string[];
}

/**
 * Build the drawer credit from the features actually drawn.
 *
 * Derived from the tile rather than from a lookup table keyed by state, because the tile is what is
 * on screen — and a lake can only be credited to the agency whose lines are visible. The tile's
 * short agency label is resolved to the required wording here; an agency with no registry entry
 * falls back to its own label, so a newly-added source credits *someone* rather than nobody.
 */
export function contourCredit(
  features: readonly Partial<ContourFeatureProperties>[],
  terms: Readonly<Record<string, ContourSourceTerms>> = CONTOUR_SOURCE_TERMS,
): ContourCredit | undefined {
  if (features.length === 0) return undefined;

  const agencies: string[] = [];
  const notices: string[] = [];
  const intervals = new Set<number>();
  const seen = new Set<string>();
  const lanes = new Set<string>();

  for (const feature of features) {
    const agency = feature.agency?.trim();
    if (agency && !seen.has(agency)) {
      seen.add(agency);
      const entry = terms[agency];
      const credit = entry?.credit ?? agency;
      if (!agencies.includes(credit)) agencies.push(credit);
      if (entry?.notice && !notices.includes(entry.notice)) notices.push(entry.notice);
    }
    if (feature.lane) lanes.add(feature.lane);
    if (typeof feature.intervalFt === 'number') intervals.add(feature.intervalFt);
  }

  if (agencies.length === 0) return undefined;
  return {
    agencies,
    lane: lanes.size > 1 ? 'mixed' : lanes.has('interpolated') ? 'interpolated' : 'surveyed',
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
 *
 * **The two lanes are two different sentences, and that is the point** (§Maine step 5, gate 3 of §6):
 * a state's own isobaths and a surface we fitted through its soundings must never render as the same
 * claim. The interpolated form also puts the required credit in its *own* sentence rather than
 * inside ours, because at least one source's required wording is itself a sentence about where the
 * soundings came from — *"Soundings digitised from NOAA nautical charts by…"* — and splicing that
 * into "…published by X" produces a line that is both ungrammatical and, worse, an alteration of
 * licence text.
 */
export function formatContourCredit(credit: ContourCredit | undefined): string {
  if (!credit) return '';
  const source = credit.agencies.join(' · ');
  const interval = credit.intervalFt ? `${credit.intervalFt} ft contours` : 'depth contours';
  const claim =
    credit.lane === 'surveyed'
      ? `${interval}, surveyed by ${source}.`
      : credit.lane === 'mixed'
        ? // Both claims, named. Neither collapsing to "surveyed" (which would credit the agency with
          // our fit) nor to "interpolated" (which would take credit for the agency's survey) is
          // available here, and dropping the lane entirely would render two different assertions as
          // one unlabelled thing — the exact failure gate 3 of §6 forbids.
          `${interval}, part surveyed and part interpolated by us from published soundings. ${source}.`
        : `${interval}, interpolated by us from published soundings. ${source}.`;
  return credit.notices.length > 0 ? `${claim} ${credit.notices.join(' ')}` : claim;
}
