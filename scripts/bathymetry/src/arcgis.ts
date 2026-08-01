/**
 * Pure ArcGIS REST helpers — URL construction and response parsing (N6b).
 *
 * Five state agencies publish through four different ArcGIS generations, so the only thing we can
 * assume is the REST shape. Everything variable — page size, whether `f=geojson` exists, whether
 * `resultOffset` paging is supported, what the OID column is called — is read from the service's own
 * descriptor rather than assumed, and the parts that can't be read are surfaced as an explicit
 * `undefined` for the caller to handle loudly.
 *
 * Kept pure (strings in, strings out) so the paging arithmetic — the part with an off-by-one that
 * silently drops or duplicates a page — is tested without a network.
 */

/** Trim a layer endpoint to its canonical form: no trailing slash, no query string. */
export function normalizeLayerUrl(url: string): string {
  return url.split('?')[0]?.replace(/\/+$/, '') ?? '';
}

/** The `?f=json` descriptor URL for a layer. */
export function descriptorUrl(layerUrl: string): string {
  return `${normalizeLayerUrl(layerUrl)}?f=json`;
}

/** A `returnCountOnly` query — one cheap request that answers "how many rows are there right now". */
export function countUrl(layerUrl: string, where = '1=1'): string {
  const params = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  return `${normalizeLayerUrl(layerUrl)}/query?${params.toString()}`;
}

export interface PageParams {
  offset: number;
  pageSize: number;
  /** Stable ordering. Omitting it makes paging non-deterministic, so the caller must supply one. */
  orderByFields: string;
  format: 'geojson' | 'json';
  where?: string;
}

/**
 * One page of features.
 *
 * `outSR=4326` is requested unconditionally, including for `f=geojson`. The GeoJSON spec mandates
 * WGS84 and most services honour that implicitly — but MassGIS and Maine publish in State Plane and
 * older ArcGIS builds have been known to emit GeoJSON with projected coordinates anyway. Asking
 * explicitly costs nothing and turns a silent 200 000-metre-offset bug into a non-event.
 */
export function pageUrl(layerUrl: string, params: PageParams): string {
  const search = new URLSearchParams({
    where: params.where ?? '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultOffset: String(params.offset),
    resultRecordCount: String(params.pageSize),
    orderByFields: params.orderByFields,
    f: params.format,
  });
  return `${normalizeLayerUrl(layerUrl)}/query?${search.toString()}`;
}

/**
 * Which `f=` to request, from the service's advertised formats.
 *
 * Prefer `geojson`: it needs no coordinate-ring translation and is what every downstream GDAL step
 * already reads. Fall back to Esri `json` rather than failing, because Maine's MapServer is a
 * generation behind and a MapServer that predates `f=geojson` still serves perfectly good rings.
 */
export function preferredFormat(supportedQueryFormats: string | undefined): 'geojson' | 'json' {
  const formats = (supportedQueryFormats ?? '').toLowerCase();
  return formats.includes('geojson') ? 'geojson' : 'json';
}

/**
 * How many pages a count needs. Zero rows means zero pages — worth stating, because the natural
 * `Math.ceil(0 / n) === 0` is right here and the equally natural "always fetch one page" is not: an
 * empty layer should produce an empty snapshot, not a page of nothing that later reads as data.
 */
export function pageCount(recordCount: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error(`pageSize must be positive, got ${pageSize}`);
  if (recordCount <= 0) return 0;
  return Math.ceil(recordCount / pageSize);
}

/** Zero-padded page filename, so a directory listing sorts into fetch order. */
export function pageFilename(index: number): string {
  return `page-${String(index).padStart(5, '0')}.json.gz`;
}

export interface ParsedPage {
  /** Feature count in this page, whichever format it arrived in. */
  count: number;
  /**
   * True when the service says there is more beyond this page. A page that comes back *short* of
   * `pageSize` without this flag is the natural end; a page that is short *with* it is a service
   * capping us below what it advertised, which the fetcher has to treat as an error rather than an end.
   */
  exceededTransferLimit: boolean;
  /** Present when the service returned an error object with a 200, which ArcGIS does routinely. */
  error?: string;
}

/**
 * Parse a page response far enough to page correctly and to notice a failure.
 *
 * We deliberately do **not** parse the features themselves here — the archive stores bytes as served
 * and the transform parses them later. This only reads the envelope, because paging and error
 * detection are fetch-time concerns and everything else is not.
 *
 * The error case earns its own branch: ArcGIS answers a malformed query with **HTTP 200** and a JSON
 * body `{"error": {...}}`. Without this check a token expiry or a bad `orderByFields` writes a
 * directory full of valid-looking gzipped error objects and reports a successful fetch.
 */
export function parsePage(body: string): ParsedPage {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { count: 0, exceededTransferLimit: false, error: 'response was not JSON' };
  }

  const err = json.error as Record<string, unknown> | undefined;
  if (err) {
    const details = Array.isArray(err.details) ? (err.details as unknown[]).join('; ') : '';
    const message = String(err.message ?? 'unknown ArcGIS error');
    return {
      count: 0,
      exceededTransferLimit: false,
      error: details ? `${message} (${details})` : message,
    };
  }

  const features = json.features;
  if (!Array.isArray(features)) {
    return { count: 0, exceededTransferLimit: false, error: 'response had no `features` array' };
  }

  // `exceededTransferLimit` sits at the top level on Esri JSON and under `properties` on GeoJSON.
  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const exceeded = json.exceededTransferLimit === true || properties.exceededTransferLimit === true;

  return { count: features.length, exceededTransferLimit: exceeded };
}

/** Parse a `returnCountOnly` response. Throws on an error body rather than reporting zero rows. */
export function parseCount(body: string): number {
  const json = JSON.parse(body) as Record<string, unknown>;
  const err = json.error as Record<string, unknown> | undefined;
  if (err) throw new Error(`ArcGIS count failed: ${String(err.message ?? 'unknown')}`);
  const count = json.count;
  if (typeof count !== 'number') throw new Error('ArcGIS count response had no numeric `count`');
  return count;
}
