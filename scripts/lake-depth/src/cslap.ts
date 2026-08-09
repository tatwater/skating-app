/**
 * **CSLAP** — New York's Citizens Statewide Lake Assessment Program (N7-3, founder 2026-08-09).
 *
 * ## Why a fourth New York source
 *
 * New York is 9,422 bodies of the corpus and the state publishes no lake bathymetry at all
 * (`scripts/bathymetry/src/sources.ts`'s `NEW_YORK_STATUS`, re-confirmed 2026-08-08). ALSC gave it
 * 1,345 measured ponds and every one of them is Adirondack, small, and forty years old. CSLAP is the
 * other half of the answer: **278 lakes carrying a mean depth**, sampled through 2024, spread across
 * the whole state — Chautauqua, the Finger Lakes, the Catskills, Long Island.
 *
 * It is small and it is *current*, which is exactly the shape ALSC is not.
 *
 * ## What was checked before writing it (2026-08-09)
 *
 * - **294 rows, 278 with a mean depth.** Queried live; the remaining 16 publish none.
 * - **Mean depth spans 0.4 m to 88.6 m.** The ceiling is Seneca Lake, whose published mean depth is
 *   88.6 m — so the extreme value in the file is a real lake rather than a units error, which is the
 *   cheapest sanity check available on a numeric column.
 * - **Coordinates are decimal degrees in the attributes.** The geometry is Web Mercator
 *   (`wkid 102100`), but every row also carries `Latitude` / `Longitude` in WGS84, so this reads
 *   those and never unprojects. One less transform to get subtly wrong.
 * - **No published licence.** The hosting item's `licenseInfo` and `accessInformation` are both
 *   empty and the service carries no `copyrightText`. Same finding as ALSC, same response:
 *   `DEPTH_SOURCE_TERMS.cslap` credits it. See that entry.
 *
 * ## Mean only, and that is the source rather than a limitation of this parser
 *
 * CSLAP publishes no maximum depth. A record therefore carries `meanDepthM` alone, which the ladder
 * handles natively — D68 makes provenance **per measurement**, so a body can perfectly well hold a
 * CSLAP mean beside a GLOBathy max and say so.
 *
 * The pure half is here and tested; the fetching and archiving is `snapshotCslap.ts`, and the
 * read-back into the depth pipeline is `parseCslapArchive` in `transform.ts`.
 */

/** The layer, as `services6.arcgis.com` serves it. One row per lake. */
export const CSLAP_SERVICE_URL =
  'https://services6.arcgis.com/DZHaqZm9cxOD4CWM/ArcGIS/rest/services/All_CSLAP_Lakes/FeatureServer/0';

/**
 * The attributes we ask for — **named, never `*`**.
 *
 * A `*` query is one schema change away from silently doubling the archive with columns nothing
 * reads, and it hides the fact that this lane deliberately ignores `Elevation__meters_` (a *string*
 * column here, and superseded by 1 m 3DEP anyway) and every water-quality field.
 */
export const CSLAP_FIELDS = [
  'CSLAP_Number',
  'Lake_Name',
  'Mean_Depth__meters_',
  'Area__hectares_',
  'County',
  'Town',
  'Latitude',
  'Longitude',
  'Last_Year_Sampled',
  'Sampling_Years',
] as const;

/**
 * Rows per request. The service advertises `maxRecordCount` 2000 and the whole layer is 294 rows, so
 * this is one request in practice — paged anyway, because a source that grows and a fetcher that
 * assumes it did not is how a lane silently stops covering half its data.
 */
export const CSLAP_PAGE_SIZE = 1000;

export function cslapQueryUrl(offset: number, pageSize: number = CSLAP_PAGE_SIZE): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: CSLAP_FIELDS.join(','),
    // The WGS84 coordinate is in the attributes; the geometry is Web Mercator and would need
    // unprojecting to say the same thing.
    returnGeometry: 'false',
    orderByFields: 'ObjectId',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'json',
  });
  return `${CSLAP_SERVICE_URL}/query?${params.toString()}`;
}

/** One CSLAP lake, as the layer publishes it, reduced to what the depth pipeline uses. */
export interface CslapLake {
  /** CSLAP's own lake number — the archive key. A string in the source, kept as one. */
  cslapNumber: string;
  name: string;
  lat: number;
  lng: number;
  meanDepthM: number;
  surfaceAreaHa?: number | undefined;
  county?: string | undefined;
  town?: string | undefined;
  /** The last season sampled, as published — carried so a stale row is visible rather than assumed. */
  lastYearSampled?: string | undefined;
}

/**
 * Deepest **mean** we will accept, in metres.
 *
 * Seneca Lake's published mean is 88.6 m and is the deepest in New York; 200 m is more than twice
 * that. A backstop exists to catch a units error or a column read across another, not to adjudicate
 * a real reading — the same reasoning as `MAX_PLAUSIBLE_ALSC_DEPTH_M`, which is why it is the same
 * number.
 */
export const MAX_PLAUSIBLE_CSLAP_MEAN_DEPTH_M = 200;

/** Why a published row yielded no usable record. Counted apart — they mean different things. */
export type CslapRefusal =
  /** The row publishes no mean depth. Real and expected: 16 of 294 on the 2026-08-09 read. */
  | 'no-depth'
  /** No usable coordinate, so there is nothing to match a depth against. */
  | 'no-coordinate'
  /** A depth outside the plausible window — a parse or units failure rather than a lake. */
  | 'implausible';

export type CslapOutcome =
  | { readonly ok: true; readonly lake: CslapLake }
  | { readonly ok: false; readonly reason: CslapRefusal };

/** A number, or `undefined` for the blanks and sentinels ArcGIS returns as `null` or `''`. */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s.length === 0 ? undefined : s;
}

/**
 * One `features[].attributes` object → a record, or a counted refusal.
 *
 * The bounds check on the coordinate is a **region** check rather than a validity one: a lake this
 * programme monitors is in New York, so a point outside the state's box means the columns were read
 * across each other (lat/lng swapped puts every lake in the Indian Ocean) rather than that CSLAP has
 * quietly gone national.
 */
export function parseCslapRow(attributes: Record<string, unknown>): CslapOutcome {
  const meanDepthM = num(attributes.Mean_Depth__meters_);
  if (meanDepthM === undefined || meanDepthM <= 0) return { ok: false, reason: 'no-depth' };
  if (meanDepthM > MAX_PLAUSIBLE_CSLAP_MEAN_DEPTH_M) return { ok: false, reason: 'implausible' };

  const lat = num(attributes.Latitude);
  const lng = num(attributes.Longitude);
  if (lat === undefined || lng === undefined) return { ok: false, reason: 'no-coordinate' };
  // New York's own box, generously drawn. See the docstring for why this is a read-across check.
  if (lat < 40 || lat > 45.1 || lng < -80 || lng > -71.5) {
    return { ok: false, reason: 'no-coordinate' };
  }

  const cslapNumber = str(attributes.CSLAP_Number);
  const name = str(attributes.Lake_Name);
  if (cslapNumber === undefined || name === undefined)
    return { ok: false, reason: 'no-coordinate' };

  const areaHa = num(attributes.Area__hectares_);
  return {
    ok: true,
    lake: {
      cslapNumber,
      name,
      lat,
      lng,
      meanDepthM,
      ...(areaHa !== undefined && areaHa > 0 ? { surfaceAreaHa: areaHa } : {}),
      ...(str(attributes.County) ? { county: str(attributes.County) } : {}),
      ...(str(attributes.Town) ? { town: str(attributes.Town) } : {}),
      ...(str(attributes.Last_Year_Sampled)
        ? { lastYearSampled: str(attributes.Last_Year_Sampled) }
        : {}),
    },
  };
}

/** The `features` array of an ArcGIS query response, or a named error. */
export function cslapFeatures(body: string): { attributes: Record<string, unknown> }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      'CSLAP: the service did not return JSON. ArcGIS answers an error with an HTML page and a 200, ' +
        'so a parse failure here is the service refusing the query rather than a network fault.',
    );
  }
  const asError = parsed as { error?: { message?: string; details?: string[] } };
  if (asError.error) {
    throw new Error(
      `CSLAP: the service returned an error — ${asError.error.message ?? 'no message'}` +
        `${asError.error.details?.length ? ` (${asError.error.details.join('; ')})` : ''}`,
    );
  }
  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features)) {
    throw new Error(
      'CSLAP: the response carried no `features` array. A layer that returns zero rows still ' +
        'returns an empty array, so its absence means the shape changed.',
    );
  }
  return features as { attributes: Record<string, unknown> }[];
}
