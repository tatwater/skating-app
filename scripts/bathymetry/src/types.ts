/**
 * Shared shapes for the N6b bathymetry ETL. Type-only — no logic, so excluded from coverage.
 */

/** Which of the two lanes a source feeds. The distinction is a provenance claim, not a file format. */
export type SourceKind =
  /** The agency surveyed the lake and published isobaths. We reproject and tile; we invent nothing. */
  | 'contours'
  /** The agency published measured depth points. **We** fit the surface, so the label differs (§Maine). */
  | 'soundings';

/** Native depth unit, carried per source and never resampled (D83). */
export type DepthUnit = 'ft' | 'm';

/** How the bytes are obtained. `arcgis` pages a Feature/MapServer layer; `file` is one HTTP download. */
export type FetchKind = 'arcgis' | 'file';

/**
 * One state-agency dataset, declared rather than scripted.
 *
 * Everything a fetch needs is data, so adding a state is a registry entry plus (for a sounding lane)
 * a density threshold — not a new code path. `attribution` is the credit line §5 renders in the lake
 * drawer, and it is deliberately stored here **as well as** captured live in the manifest: the live
 * `copyrightText` is what the agency says today, this is what we agreed to render, and a drift between
 * them is a thing `verify` should surface rather than silently resolve.
 */
export interface BathymetrySource {
  /** Stable directory name under `.raw/`. Never renamed — it is the archive key. */
  key: string;
  /** Two-letter state, matching `waterBodies.states`. */
  state: string;
  /** Human agency name for the drawer credit. */
  agency: string;
  kind: SourceKind;
  unit: DepthUnit;
  fetch: ArcGisFetchSpec | FileFetchSpec;
  /** The credit line we render (§5). Confirmed against the portal's terms at fetch time. */
  attribution: string;
  /**
   * A notice the source's own terms require, rendered under the credit.
   *
   * Only Champlain carries one so far. Its soundings are digitised from NOAA nautical charts, and
   * chart-derived data conventionally carries a **"not for navigation"** notice — see §5 of the phase
   * doc, which flagged reading this properly before the layer renders next to anything on a safety
   * product.
   *
   * **This does not breach D82's no-interpretive-copy rule.** D82 refuses copy that tells a skater
   * what the depth *means* for ice; a licence notice makes no claim about the ice at all. If anything
   * it points the same way D82 does — it says do not navigate by this.
   */
  notice?: string;
  /** Where a human goes to read the terms and the metadata. Rendered as the credit's link. */
  sourceUrl: string;
  /**
   * Vertical reference, recorded because sources do **not** share one and must never be unioned into
   * a single styled-by-depth ramp (§Where the real data is). Free text: it is a caveat, not a key.
   */
  datum: string;
  /** Notes that belong with the data rather than in a plan doc — quirks found while fetching. */
  notes?: string;
}

export interface ArcGisFetchSpec {
  type: 'arcgis';
  /** Layer endpoint, no trailing slash and no `?f=` — e.g. `…/FeatureServer/0`. */
  url: string;
  /**
   * Rows per page. Left unset it uses the service's own `maxRecordCount`, which is the right default;
   * set it only when a service advertises more than it can actually serve.
   */
  pageSize?: number;
}

export interface FileFetchSpec {
  type: 'file';
  url: string;
  /** Filename to store the payload under, extension included. Byte-faithful — we never repack. */
  filename: string;
}

/** An ArcGIS layer descriptor, normalized to the handful of fields we actually depend on. */
export interface ServiceDescriptor {
  name?: string;
  geometryType?: string;
  maxRecordCount?: number;
  /** Where an agency's required credit wording actually lives. Captured every fetch. */
  copyrightText?: string;
  description?: string;
  fields: { name: string; type: string }[];
  /** WKID when the service reports one. */
  spatialReference?: number | string;
  /** True when the service can page with `resultOffset`; false forces OID-window paging. */
  supportsPagination?: boolean;
  supportedQueryFormats?: string;
}

/** One stored file inside a `.raw/<key>/` directory. */
export interface RawFileRecord {
  name: string;
  bytes: number;
  sha256: string;
}

/** HTTP validators, kept so `verify` can detect a republication without pulling the payload again. */
export interface HttpValidators {
  lastModified?: string;
  etag?: string;
  contentLength?: number;
}

/**
 * What a `.raw/<key>/manifest.json` records.
 *
 * The payload says what the data is; this says where it came from, when, and under what terms — the
 * three things that are invisible in a GeoJSON file and that go stale without anyone noticing.
 */
export interface RawManifest {
  key: string;
  /** ISO-8601, injected rather than read from the clock so the writer stays pure. */
  fetchedAt: string;
  source: {
    url: string;
    kind: FetchKind;
    /** Which `f=` the pages were requested as, since it changes how the transform parses them. */
    format?: 'geojson' | 'json';
  };
  files: RawFileRecord[];
  /** Features actually captured. Absent for an opaque file payload we haven't parsed yet. */
  recordCount?: number;
  /** What the service said about itself at fetch time. */
  service?: ServiceDescriptor;
  http?: HttpValidators;
}
