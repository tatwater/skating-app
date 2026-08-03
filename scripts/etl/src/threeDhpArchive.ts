/**
 * 3DHP acquisition and provenance — the third canonical-water catalogue, and the only one with a
 * future (N7).
 *
 * ## Why this exists at all, when NHD is already archived
 *
 * **NHD is terminal.** USGS retired it on 2023-10-01 and the state geodatabases are frozen at
 * 2023-12-27; there will never be another one. The 3D Hydrography Program is its successor —
 * elevation-derived hydrography where LiDAR exists, NHD elsewhere — and it publishes an annual
 * staged release plus quarterly service updates.
 *
 * So the refresh cadence this repo can actually run is **OSM + 3DHP** (founder, 2026-08-03, asking
 * that both be re-importable yearly). That has a consequence D92's bake-off has to weigh: every year
 * that passes, NHD's outlines age by a year and 3DHP's do not.
 *
 * ## Why we archive a clip, and not the bytes we downloaded
 *
 * This is the one source in the repo that breaks the byte-faithful rule, deliberately and with the
 * reason recorded here rather than discovered later.
 *
 * 3DHP has **no per-state or per-HU4 staging**. It ships CONUS-wide as a single 11.9 GB geodatabase
 * (FY26) — flowlines, catchments and hydrolocations for the entire country — from which we want the
 * Waterbody feature class for five states, on the order of 300 MB. Mirroring the whole thing would
 * grow R2 by ~12 GB *per annual release* in data we never read, which for a yearly cadence is not a
 * storage question but a design error.
 *
 * **What preserves reproducibility instead:** the source URL, its byte count, its publisher
 * `Last-Modified`, and **our sha256 of the full download** all go in the source manifest, and the
 * exact clip is a recorded command rather than a hand step. Re-deriving the clip needs the 11.9 GB
 * again; re-deriving anything *downstream* of the clip does not, which is the property the archive
 * discipline actually exists to protect.
 *
 * ## What 3DHP can and cannot be
 *
 * **It cannot be the identity spine.** Its Waterbody layer carries `id3dhp`, `mainstemid` and
 * `gnisid` — and **no `Permanent_Identifier`, no `ReachCode`** (checked 2026-08-03). Every
 * reconciliation measurement in the N7 plan keys on `Permanent_Identifier`, including the five OSM
 * duplicate pairs and the whole Maine MIDAS linkage. If 3DHP wins D92 on geometry, it wins as a
 * `geometrySource` value on a record whose identity is still OSM ↔ NHD.
 *
 * **And a 3DHP polygon identical to its NHD counterpart is the expected case, not a bug** — 3DHP
 * falls back to NHD wherever elevation-derived hydrography does not yet exist. The bake-off has to
 * report how often that happens or it will claim a three-way comparison it did not make.
 *
 * Pure logic here and tested; the download and `ogr2ogr` glue is `fetch3dhp.ts`.
 */

/** One annual staged release. Adding next year's is an entry here, nothing else. */
export interface ThreeDhpRelease {
  /** Federal fiscal year label, as USGS names the directory. */
  fiscalYear: string;
  /** The publication date embedded in the artifact name. */
  published: string;
  url: string;
  filename: string;
  /** From the bucket listing — the integrity check, as for NHD. See `nhdArchive.ts`. */
  expectedBytes: number;
  /** The publisher's `Last-Modified`, to `YYYY-MM-DD`. */
  publishedAt: string;
}

export const THREE_DHP_BASE =
  'https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/3DHP/Annual/GDB';

/**
 * Releases, newest first. `CURRENT_3DHP_RELEASE` is the head of this list.
 *
 * FileGDB rather than GeoPackage for the same reason as NHD: same data, same `ogr2ogr`, and the
 * GeoPackage build is ~22 GB against 11.9.
 */
export const THREE_DHP_RELEASES: ThreeDhpRelease[] = [
  {
    fiscalYear: 'FY26',
    published: '20260112',
    url: `${THREE_DHP_BASE}/3dhp_all_GDB_FY26_CONUS_20260112/3dhp_all_CONUS_20260112_GDB.zip`,
    filename: '3dhp_all_CONUS_20260112_GDB.zip',
    expectedBytes: 11_897_413_835,
    publishedAt: '2026-01-21',
  },
  {
    fiscalYear: 'FY25',
    published: '20250313',
    url: `${THREE_DHP_BASE}/3dhp_all_GDB_FY25_CONUS_20250313/3dhp_all_CONUS_20250313_GDB.zip`,
    filename: '3dhp_all_CONUS_20250313_GDB.zip',
    expectedBytes: 12_043_105_481,
    publishedAt: '2025-03-20',
  },
];

/**
 * The release a fresh run acquires. Narrowed rather than indexed, because `noUncheckedIndexedAccess`
 * is on and every caller would otherwise carry an `undefined` that cannot happen — the registry above
 * is a literal and the yearly runbook says *add*, never replace.
 */
export const CURRENT_3DHP_RELEASE: ThreeDhpRelease = (() => {
  const head = THREE_DHP_RELEASES[0];
  if (!head)
    throw new Error('THREE_DHP_RELEASES is empty — every 3DHP run needs a release to fetch');
  return head;
})();

/**
 * The clip envelope: the five states plus enough margin to keep a border-spanning lake whole.
 *
 * **Wider than the OSM lane's New York clip on purpose.** That one (`archive.ts`, 41.3°N) exists to
 * keep the downstate metro out of a *corpus*; this is an acquisition boundary, and clipping a lake in
 * half at acquisition is unrecoverable without the 11.9 GB. The floor and the classifier do the
 * narrowing later, where it is cheap to redo.
 *
 * North to 47.6° covers Beau Lake and the Québec border lakes that motivated this phase; east to
 * -66.8° clears Maine's coast.
 */
export const NORTHEAST_CLIP: readonly [number, number, number, number] = [-80.0, 40.9, -66.8, 47.6];

/**
 * The one feature class we keep, **as it is named inside the geodatabase**.
 *
 * Not `waterbody`, which is what the REST service calls the equivalent layer and what this constant
 * said until the first real download proved otherwise. The staged product prefixes every feature
 * class (`hydro_3dhp_all_catchment`, `…_flowline`, `…_drainagearea`, and this one). 5,747,966
 * waterbodies nationally; we keep the Northeast.
 */
export const THREE_DHP_SOURCE_LAYER = 'hydro_3dhp_all_waterbody';

/** What we rename it to on the way out, so downstream reads one name regardless of the vintage. */
export const THREE_DHP_WATERBODY_LAYER = 'waterbody';

/**
 * The CRS the staged product is actually in: **NAD83(2011) / Conus Albers**, a projected metre grid,
 * not lat/lon.
 *
 * This matters more than it looks. `ogr2ogr -spat` interprets its coordinates **in the source
 * layer's SRS unless told otherwise** — so passing our degrees envelope without `-spat_srs` would
 * have been read as metres from the Albers origin, selecting a strip of ocean somewhere south of
 * Texas and returning zero features. A clip that silently returns nothing looks exactly like a
 * source with no coverage.
 */
export const THREE_DHP_SOURCE_SRS = 'EPSG:5070';

export const THREE_DHP_LICENCE = 'Public domain (USGS · US Government work, 17 U.S.C. §105)';
export const THREE_DHP_ATTRIBUTION = 'U.S. Geological Survey, 3D Hydrography Program';

/**
 * The `ogr2ogr` invocation that turns 11.9 GB of CONUS into the clip we keep.
 *
 * Returned as data rather than run inline so the exact command lands in the manifest and in the run
 * row. "What did the clip actually do" is the question a derivative archive has to be able to
 * answer, since the bytes no longer answer it themselves.
 *
 * Three flags are explicit because each one is a silent failure if omitted:
 *
 * - **`-spat_srs`** — `-spat` reads its coordinates in the *source* SRS by default, and this source
 *   is Albers metres. Without it, a degrees envelope selects nothing and the clip "succeeds" empty.
 * - **`-t_srs EPSG:4326`** — we store WGS84; the source does not.
 * - **`-dim XY`** — the source geometry is 3D, and nothing downstream expects a Z.
 */
export function clipCommand(
  sourceZip: string,
  outPath: string,
): { bin: string; args: string[]; line: string } {
  const [minLng, minLat, maxLng, maxLat] = NORTHEAST_CLIP;
  const args = [
    '-f',
    'GPKG',
    outPath,
    `/vsizip/${sourceZip}`,
    THREE_DHP_SOURCE_LAYER,
    '-spat',
    String(minLng),
    String(minLat),
    String(maxLng),
    String(maxLat),
    '-spat_srs',
    'EPSG:4326',
    '-t_srs',
    'EPSG:4326',
    '-dim',
    'XY',
    '-nln',
    THREE_DHP_WATERBODY_LAYER,
  ];
  return { bin: 'ogr2ogr', args, line: ['ogr2ogr', ...args].join(' ') };
}

/** What `.raw-3dhp/source/manifest.json` records — the bytes we do NOT keep. */
export interface ThreeDhpSourceManifest {
  fiscalYear: string;
  fetchedAt: string;
  url: string;
  filename: string;
  bytes: number;
  expectedBytes: number;
  bytesVerified: boolean;
  /** Our hash of the full 11.9 GB. This is what makes the clip reproducible without the bytes. */
  sha256: string;
  lastModified?: string;
  licence: string;
  attribution: string;
  /**
   * Stated plainly, because a reader finding a manifest without its payload should not have to infer
   * why.
   */
  retention: string;
}

/** What `.raw-3dhp/waterbody/manifest.json` records — the clip we DO keep and mirror. */
export interface ThreeDhpClipManifest {
  fiscalYear: string;
  derivedAt: string;
  /** The source manifest this clip came out of, by sha256. */
  sourceSha256: string;
  sourceUrl: string;
  layer: string;
  clipBBox: readonly [number, number, number, number];
  /** The literal command, so the derivation is auditable without re-reading this file's code. */
  command: string;
  filename: string;
  bytes: number;
  sha256: string;
  features: number;
  licence: string;
  attribution: string;
}

export interface BuildSourceManifestInput {
  release: ThreeDhpRelease;
  fetchedAt: string;
  bytes: number;
  sha256: string;
  lastModified?: string;
}

export function buildThreeDhpSourceManifest(
  input: BuildSourceManifestInput,
): ThreeDhpSourceManifest {
  return {
    fiscalYear: input.release.fiscalYear,
    fetchedAt: input.fetchedAt,
    url: input.release.url,
    filename: input.release.filename,
    bytes: input.bytes,
    expectedBytes: input.release.expectedBytes,
    bytesVerified: input.bytes === input.release.expectedBytes,
    sha256: input.sha256,
    ...(input.lastModified ? { lastModified: input.lastModified } : {}),
    licence: THREE_DHP_LICENCE,
    attribution: THREE_DHP_ATTRIBUTION,
    retention:
      'The 11.9 GB download is NOT mirrored and may be deleted locally once the clip exists. It is ~12 GB of national flowlines and catchments per annual release, none of which we read. Re-fetch from `url` and re-run `clipCommand` to reproduce; the sha256 above is what proves you got the same bytes.',
  };
}

export interface BuildClipManifestInput {
  release: ThreeDhpRelease;
  derivedAt: string;
  sourceSha256: string;
  filename: string;
  bytes: number;
  sha256: string;
  features: number;
  command: string;
}

export function buildThreeDhpClipManifest(input: BuildClipManifestInput): ThreeDhpClipManifest {
  return {
    fiscalYear: input.release.fiscalYear,
    derivedAt: input.derivedAt,
    sourceSha256: input.sourceSha256,
    sourceUrl: input.release.url,
    layer: THREE_DHP_WATERBODY_LAYER,
    clipBBox: NORTHEAST_CLIP,
    command: input.command,
    filename: input.filename,
    bytes: input.bytes,
    sha256: input.sha256,
    features: input.features,
    licence: THREE_DHP_LICENCE,
    attribution: THREE_DHP_ATTRIBUTION,
  };
}
