/**
 * Tier 1 of N6e's reveal: 0.3 m public-domain aerial orthoimagery, and the date it was taken.
 *
 * ## The source, and the one this replaced
 *
 * **`USGSNAIPPlus` on `imagery.nationalmap.gov`** — `pixelSizeX: 0.3`, no key, CORS `*`.
 *
 * The 2026-07-31 scoping named `USGSImageryOnly` at "~0.6 m". Both halves were wrong and the error was
 * load-bearing: that service's `maxScale` is 9027.977411 — **ArcGIS level 16**, ~1.7 m/px at our
 * latitude — and z17+ returns a hard 404 rather than upsampling. At 1.7 m you can see that a clearing
 * is a parking lot; you cannot count spaces, and a footpath under canopy is invisible. Which is the
 * entire job this tier has (D147, and N6e §A2's pairing with N6d).
 *
 * ## It is an ImageServer, not a tile cache, and that changes three things
 *
 * There is no `/tile/{z}/{y}/{x}` endpoint. Every request is rendered on demand from `exportImage`,
 * which MapLibre can drive because it substitutes **`{bbox-epsg-3857}`** into a raster template. So:
 *
 * 1. **No max-zoom cliff.** The renderer will draw any bbox at any scale, so there is nothing to clamp
 *    and no blank map at high zoom — the failure mode that made the old service unusable here.
 * 2. **No CDN, and therefore a courtesy problem.** Every tile is compute on somebody else's machine.
 *    `bounds` is the answer — see `aerialSourceSpec`.
 * 3. **The acquisition date is queryable**, which is what lets B2 state a date rather than hedge.
 *
 * ## D147 — this imagery can never show ice
 *
 * NAIP is flown by aircraft on a **2–3 year per-state cycle, deliberately in mid-summer**, for the
 * USDA's crop program. Burlington's current scene is `m_4407339_ne_18_030_20230621` — the summer
 * solstice, 2023. The date is not a footnote on this tier; it is the reason the tier is for reading
 * *access* and never conditions.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { type BBox, type LatLng, polygonBBox } from './geometry';
import { toMercatorBox } from './webMercator';

/** The ImageServer's dynamic render endpoint. */
const NAIP_IMAGE_SERVER =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer';

/**
 * Public-domain federal imagery, so this is courtesy rather than obligation — but it carries the
 * refresh date, which is the honest half. Read off the service, not paraphrased.
 */
export const AERIAL_ATTRIBUTION = 'USDA, USGS The National Map: Orthoimagery';

/**
 * Tile edge in pixels. 256 matches what `size` asks the renderer for, and the two must agree or every
 * tile is silently resampled — which at 0.3 m looks like the imagery is blurrier than it is.
 */
export const AERIAL_TILE_SIZE = 256;

/**
 * The raster tile template MapLibre expands per tile.
 *
 * `{bbox-epsg-3857}` is substituted with `minx,miny,maxx,maxy` in Web Mercator metres, which is the
 * order `exportImage` wants — so `bboxSR` and `imageSR` both pin 3857 and no reprojection happens
 * anywhere in the round trip.
 *
 * `format=jpg` because this is photography: PNG would triple the bytes for no visible gain, and there
 * is no transparency to preserve (the mask is a separate fill layer — see `imageryMask`).
 */
export function aerialTileTemplate(): string {
  const params = new URLSearchParams({
    bbox: '{bbox-epsg-3857}',
    bboxSR: '3857',
    imageSR: '3857',
    size: `${AERIAL_TILE_SIZE},${AERIAL_TILE_SIZE}`,
    format: 'jpg',
    f: 'image',
  });
  // `URLSearchParams` percent-encodes the braces, which MapLibre then fails to recognise as a token.
  return `${NAIP_IMAGE_SERVER}/exportImage?${params.toString().replace('%7Bbbox-epsg-3857%7D', '{bbox-epsg-3857}')}`;
}

/**
 * The largest image the ImageServer will render in one call (`maxImageHeight`/`maxImageWidth`).
 *
 * Read off the service rather than guessed. Asking for more does not fail loudly — it returns a
 * *smaller* image than requested, which would silently rescale the alpha mask against it.
 */
export const AERIAL_MAX_EXPORT_PX = 4000;

/**
 * One rendered image covering `box` at `width` × `height` — the request behind the clipped reveal.
 *
 * `format=jpg` and **no transparency asked for**, deliberately: the alpha that clips this to the lake
 * is punched in on our side (see the web app's `imageryCanvas`), so asking the service for a PNG
 * would triple the bytes to carry an alpha channel we immediately overwrite.
 */
export function aerialExportUrl(
  box: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  width: number,
  height: number,
): string {
  const merc = toMercatorBox(box);
  const params = new URLSearchParams({
    bbox: `${merc.minX},${merc.minY},${merc.maxX},${merc.maxY}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${Math.round(Math.min(width, AERIAL_MAX_EXPORT_PX))},${Math.round(
      Math.min(height, AERIAL_MAX_EXPORT_PX),
    )}`,
    format: 'jpg',
    f: 'image',
  });
  return `${NAIP_IMAGE_SERVER}/exportImage?${params.toString()}`;
}

/** A MapLibre raster source, bounded to the reveal. */
export interface AerialSourceSpec {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  attribution: string;
  bounds: [number, number, number, number];
  maxzoom: number;
}

/**
 * `bounds` is the courtesy mechanism, and it is doing more work than it looks like.
 *
 * MapLibre requests tiles for the whole **viewport**, not for the part of it a mask leaves visible —
 * so without bounds, panning around at a regional zoom with the reveal on would fire hundreds of
 * on-demand renders for pixels that are 99.9% painted over. Handing the source the reveal's own bbox
 * means it never asks for a tile outside the lake, at any zoom, however far the map is panned.
 *
 * **This is also what lets the founder's "no zoom floor" call stand** *(2026-08-21: "they should be
 * able to zoom so far out that it's not visible or so far in that it's too blurry to read — that's up
 * to them")*. The alternative to bounds would have been a minimum zoom, which is a rule about the
 * user; bounds is a rule about the request, and only one of those is our business.
 *
 * `maxzoom` is high rather than absent because a dynamic renderer will happily draw a 5 cm bbox from
 * 30 cm pixels forever. Past z21 that is pure upsampling served at real compute cost, so we let
 * MapLibre overzoom locally instead of asking USGS to.
 */
export function aerialSourceSpec(bounds: BBox): AerialSourceSpec {
  return {
    type: 'raster',
    tiles: [aerialTileTemplate()],
    tileSize: AERIAL_TILE_SIZE,
    attribution: AERIAL_ATTRIBUTION,
    bounds: [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat],
    maxzoom: 21,
  };
}

/** The reveal's own extent, which is what the source should be bounded to. */
export function aerialBoundsFor(shape: Polygon | MultiPolygon): BBox {
  return polygonBBox(shape);
}

/**
 * The `identify` call that answers *"when was this lake photographed?"*
 *
 * One point is enough: a lake smaller than a NAIP quarter-quad sits inside one scene, and a lake that
 * spans two was flown in the same campaign season anyway. Called once per body and cached — this is
 * ETL-shaped work, not a request path.
 */
export function aerialIdentifyUrl(point: LatLng): string {
  const geometry = JSON.stringify({
    x: point.lng,
    y: point.lat,
    spatialReference: { wkid: 4326 },
  });
  const params = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryPoint',
    returnCatalogItems: 'true',
    returnGeometry: 'false',
    f: 'pjson',
  });
  return `${NAIP_IMAGE_SERVER}/identify?${params.toString()}`;
}

/** What a body's aerial imagery is, as far as a caption is concerned. */
export interface AerialScene {
  /** Epoch ms the photograph was taken. */
  capturedAt: number;
  /** Ground sample distance in metres, from the scene name (`…_030_…` ⇒ 0.30 m). */
  resolutionM?: number;
  /** The USGS scene id, kept so a surprising date can be traced to a file. */
  sceneName?: string;
}

/** The shape of an ArcGIS `identify` response, narrowed to what we read. */
interface IdentifyResponse {
  catalogItems?: {
    features?: {
      attributes?: Record<string, unknown>;
    }[];
  };
}

/**
 * Pull the newest real scene out of an `identify` response.
 *
 * **The filtering is the whole function.** The response is mostly *overview* rasters — pyramid levels
 * named `Ov_i02_L01_…` with `acquisition_date: null` — and only a handful of genuine source scenes.
 * Taking `features[0]` works against the response I sampled and would silently start returning `null`
 * the day the ordering changed, so the rule is **"has a date, newest wins"** rather than "is first".
 *
 * Returns `null` when nothing in the response carries a date, which is the correct answer for a lake
 * outside NAIP coverage — and the caller must then say nothing rather than guess a year.
 */
export function parseAerialScene(response: unknown): AerialScene | null {
  const features = (response as IdentifyResponse)?.catalogItems?.features;
  if (!Array.isArray(features)) return null;

  let best: AerialScene | null = null;
  for (const item of features) {
    const attrs = item?.attributes;
    if (!attrs) continue;
    const captured = attrs.acquisition_date;
    if (typeof captured !== 'number' || !Number.isFinite(captured)) continue;
    if (best && captured <= best.capturedAt) continue;
    const name = typeof attrs.raster_name === 'string' ? attrs.raster_name : undefined;
    best = {
      capturedAt: captured,
      sceneName: name,
      resolutionM: name ? resolutionFromSceneName(name) : undefined,
    };
  }
  return best;
}

/**
 * NAIP quarter-quad names carry their own ground sample distance:
 * `m_4407339_ne_18_030_20230621` ⇒ the `030` field ⇒ **0.30 m**.
 *
 * Worth reading rather than assuming, because it is the field that would tell us a state had been
 * re-flown at a different resolution — the kind of change that otherwise shows up as "the imagery
 * looks different now" with nothing to point at.
 */
export function resolutionFromSceneName(name: string): number | undefined {
  const parts = name.split('_');
  for (const part of parts) {
    // A three-digit field of centimetres: 030 ⇒ 0.3 m, 060 ⇒ 0.6 m, 100 ⇒ 1 m.
    if (/^\d{3}$/.test(part)) {
      const cm = Number(part);
      if (cm > 0 && cm <= 200) return cm / 100;
    }
  }
  return undefined;
}

/**
 * The caption, and it is deliberately coarse: **"June 2023"**, never a day.
 *
 * A day implies the photograph is *of* that day in a way that matters, and for imagery on a 2–3 year
 * cycle it does not — the useful facts are the season (leaf-on, so this is not ice) and roughly how
 * old it is. D151's grammar applies here too, one tier down: the claim is about the photograph.
 */
export function formatAerialCaptureDate(capturedAt: number, now: number = Date.now()): string {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const year = date.getUTCFullYear();
  const label = `${month} ${year}`;
  // Past the flight cycle, say so — otherwise a 2023 date on a 2026 map reads as our staleness rather
  // than the program's. "latest available" and not "oldest available": this *is* the newest flight,
  // which is the opposite of what the first wording implied and the sort of thing that only reads
  // wrong once you see it printed against real data.
  const years = (now - capturedAt) / (365.25 * 24 * 60 * 60 * 1000);
  return years >= 3 ? `${label} · latest available` : label;
}
