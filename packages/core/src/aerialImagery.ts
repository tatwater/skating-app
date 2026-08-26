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
 * ## It is an ImageServer, not a tile cache, and that shapes everything downstream
 *
 * There is no `/tile/{z}/{y}/{x}` endpoint — every request is rendered on demand from `exportImage`.
 * Three consequences:
 *
 * 1. **No max-zoom cliff.** The renderer draws any bbox at any scale, so there is nothing to clamp and
 *    no blank map at high zoom — the failure mode that made the old service unusable here.
 * 2. **There IS a CDN, and it is the whole performance story.** This note used to say the opposite —
 *    *"no CDN, and therefore a courtesy problem"* — and building on that was expensive. Measured
 *    against the live service on 2026-08-21, `exportImage` answers with `cache-control: max-age=43200`
 *    through CloudFront, and a repeat of an identical URL is **0.08 s against 29.3 s** for a fresh
 *    render. A one-metre change of bbox, or a one-pixel change of size, is a full miss.
 *
 *    So the courtesy problem is real but it is not the one that was written down: the cost is not
 *    "every request is compute", it is *"every request we make is compute **because we never repeat a
 *    URL**"*. That is why requests are snapped to a fixed grid — see `imageryTiles`.
 * 3. **The acquisition date is queryable**, which is what lets B2 state a date rather than hedge.
 *
 * An earlier build drove this through MapLibre's `{bbox-epsg-3857}` raster template, one tile per
 * request. That is gone: clipping a photograph to a lake means owning its alpha channel, and owning
 * the alpha channel means fetching the image ourselves. See the web app's `imageryCanvas`.
 *
 * ⚠ **Call this with a grid cell's box and `AERIAL_TILE_PX`, not with a live camera's.** The URL is
 * the cache key, so a bbox derived from `map.getBounds()` guarantees a miss — that is the 350×.
 *
 * ## D147 — this imagery can never show ice
 *
 * NAIP is flown by aircraft on a **2–3 year per-state cycle, deliberately in mid-summer**, for the
 * USDA's crop program. Burlington's current scene is `m_4407339_ne_18_030_20230621` — the summer
 * solstice, 2023. The date is not a footnote on this tier; it is the reason the tier is for reading
 * *access* and never conditions.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { type BBox, expandBBox, type LatLng, polygonBBox } from './geometry';
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

/**
 * The reveal's extent, **grown by the feather** — the box the imagery has to cover.
 *
 * `padMeters` is not an optional nicety, and leaving it at zero is a visible bug. The feather fades
 * outward from the *solid* shape, so an image cropped to that shape's bounding box cuts the fade off
 * wherever the shape touches its own bbox — which is every lake, at the northernmost and southernmost
 * points at minimum. On screen that is a **hard straight line across the middle of a soft gradient**,
 * and it reads as a rendering artefact because it is one.
 *
 * Pass the tier's feather distance. Erring generous costs a few metres of image nobody sees; erring
 * tight costs the edge the feather exists to create.
 */
export function aerialBoundsFor(shape: Polygon | MultiPolygon, padMeters = 0): BBox {
  const box = polygonBBox(shape);
  return padMeters > 0 ? expandBBox(box, padMeters) : box;
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

/**
 * The same flight, named the way the **archive** names its winters — `summer 2023`, not `June 2023`.
 *
 * > **Founder, 2026-08-26:** *"when it's showing summer imagery, it can say 'Freeze-up timeline …
 * > summer 2023 • latest aerial available'; when it's showing winter imagery … 'winter 2025–26'."*
 *
 * One slot in the panel's heading answers *what season is on this lake*, and it is filled from two
 * different sources — an archived Sentinel frame or the aerial under it. Two grammars in one slot is
 * a comparison a reader has to do arithmetic for, so the aerial adopts the archive's: a season and a
 * year, which are also exactly the two facts {@link formatAerialCaptureDate} argues are the useful
 * ones. The precise month survives in the drawer's provenance line, where somebody asking *when* is
 * already looking.
 */
export function formatAerialSeason(capturedAt: number, now: number = Date.now()): string {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const season =
    month === 11 || month <= 1
      ? 'winter'
      : month <= 4
        ? 'spring'
        : month <= 7
          ? 'summer'
          : 'autumn';
  // ⚠ A winter spans two calendar years, and this slot also holds `winter 2025–26` — so a winter
  // flight has to be named the same way or the one grammar the merge bought is lost again. NAIP is
  // flown leaf-on and should never reach this branch; a label quietly reading `winter 2023` for a
  // January flight is precisely the sort of wrong that nobody goes looking for.
  const label =
    season === 'winter'
      ? month === 11
        ? `winter ${year}–${String((year + 1) % 100).padStart(2, '0')}`
        : `winter ${year - 1}–${String(year % 100).padStart(2, '0')}`
      : `${season} ${year}`;
  // "latest **aerial** available", where the month form says only "latest available": in the heading
  // it sits beside a season the archive also publishes, and an unqualified "latest" there would read
  // as a claim about the satellite timeline rather than about the flight programme.
  const years = (now - capturedAt) / (365.25 * 24 * 60 * 60 * 1000);
  return years >= 3 ? `${label} · latest aerial available` : label;
}
