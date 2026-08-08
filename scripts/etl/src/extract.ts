/**
 * The commands that turn an archive into something we can read — **stated once** (N7 audit).
 *
 * ## Why this file exists
 *
 * Five modules under `scripts/etl` shell out to `osmium` or `ogr2ogr` against the same three
 * archives, and each carried its own copy of the invocation. That is five places a tag has to be
 * added to the OSM filter, five spellings of the `-select` list, and five chances for one of them to
 * drift — and a drift here is exactly the silent kind this phase keeps finding, because a narrower
 * `-select` does not error, it just produces a column of `undefined` that classifies as silence.
 *
 * The specific near-miss that motivated it: `merge.ts` extracts NHD **at the one-acre floor** while
 * the standalone reconciler exported at five acres, so every corpus body between one and five acres
 * was scored against an empty candidate set — 2,060 of them, measured, and indistinguishable in the
 * output from a lake NHD has never heard of.
 *
 * ## What is here and what is not
 *
 * Only the argv. Running the command, choosing where the output goes and deciding whether to
 * re-extract stay with the caller, because those differ legitimately: the dry run writes to
 * `.scratch/classify`, the merge to `.scratch/merge`, and the audit reads attributes with no
 * geometry at all. What must not differ is *which features come out*, and that is what this pins.
 */

/**
 * The OSM tags a water extract keeps — **a superset of what we import**, deliberately.
 *
 * The classifier makes the final call (`classifyOsmTags`), so this only has to be wide enough not to
 * lose anything: `natural=water` and `natural=wetland` are the two big buckets, `water` on its own
 * catches a feature tagged `water=lake` without the `natural` key, and `landuse=reservoir` /
 * `natural=bay` are the two that neither of those reaches.
 */
export const OSM_WATER_TAGS = [
  'natural=water',
  'landuse=reservoir',
  'natural=bay',
  'natural=wetland',
  'water',
] as const;

/**
 * `osmium tags-filter` argv — the water subset of a state extract.
 *
 * `-t` is `--remove-tags` (strip tags from non-matching objects), **not** `--omit-referenced`, which
 * is `-R`. Worth stating because getting them confused would drop the nodes the ways are built from
 * and produce an export with no geometry — silently, since `osmium export` would simply emit fewer
 * features rather than failing.
 */
export function osmFilterArgs(pbf: string, out: string): string[] {
  return ['tags-filter', '-t', pbf, ...OSM_WATER_TAGS, '-o', out, '--overwrite'];
}

/**
 * `osmium export` argv — polygons only, carrying the OSM type and id.
 *
 * `-a type,id` is what produces `@type` / `@id`, which is the **stable** OSM identifier
 * (`way/123`) rather than osmium's internal area id (`osm_id * 2 (+1 for relations)`). Without it
 * every feature parses as `no-id` and the whole extract is refused.
 */
export function osmExportArgs(filtered: string, out: string): string[] {
  return [
    'export',
    filtered,
    '--geometry-types=polygon',
    '-a',
    'type,id',
    '-f',
    'geojsonseq',
    '-x',
    'print_record_separator=false',
    '-o',
    out,
    '--overwrite',
  ];
}

/**
 * One acre in km², the unit NHD and 3DHP both publish `areasqkm` in.
 *
 * Expressed exactly rather than rounded, because it is compared with `>=` against a float the
 * publisher computed: rounding it up would silently exclude a band of bodies at the boundary, and
 * this is a pre-filter whose exclusions nothing downstream can see.
 */
export const ONE_ACRE_SQ_KM = 0.0040468564224;

/**
 * The NHD attributes every pass reads. **Add here, never at a call site.**
 *
 * `fcode` is on the list because the Reservoir FTYPE spans 23 of them and roughly 43% of in-region
 * reservoirs above an acre are infrastructure — sewage treatment, settling, cooling. Dropping it from
 * one caller's `-select` would make every one of those a plain reservoir, with no error anywhere.
 */
export const NHD_SELECT = [
  'permanent_identifier',
  'gnis_id',
  'gnis_name',
  'ftype',
  'fcode',
  'areasqkm',
] as const;

/**
 * `ogr2ogr` argv for NHD's `NHDWaterbody` layer, at the one-acre floor.
 *
 * Three things that are not obvious and each of which fails silently if changed:
 *
 * - **`-t_srs EPSG:4326`** — the geodatabase is NAD83 (EPSG:4269). Close enough to look right on a
 *   map and wrong enough to move a shoreline.
 * - **`-dim XY`** — the CRS is a compound 3D `NAD83 + NAVD88 height` with 3D multipolygons, and a
 *   third ordinate reaches `surfaceAreaSqM` as noise.
 * - **the `-where` clause** — this is the publisher's own `areasqkm`, not our geodesic measure, so it
 *   is a *pre-filter* only. Every lane re-checks the area itself; see `parseNhdFeature`.
 */
export function nhdExtractArgs(gdb: string, out: string): string[] {
  return [
    '-f',
    'GeoJSONSeq',
    out,
    gdb,
    'NHDWaterbody',
    '-select',
    NHD_SELECT.join(','),
    '-where',
    `areasqkm >= ${ONE_ACRE_SQ_KM}`,
    '-t_srs',
    'EPSG:4326',
    '-dim',
    'XY',
    '-overwrite',
  ];
}

/** The 3DHP attributes every pass reads. `gnisidlabel` is the name; `gnisid` is a bare integer. */
export const THREE_DHP_SELECT = [
  'id3dhp',
  'gnisid',
  'gnisidlabel',
  'featuretype',
  'areasqkm',
] as const;

/**
 * `ogr2ogr` argv for the 3DHP waterbody clip, at the one-acre floor.
 *
 * The staged product is **NAD83(2011) / Conus Albers (EPSG:5070)**, a metre grid — which is why any
 * `-spat` box here has to be in metres too. A degrees box against Albers selects ocean, and the clip
 * "succeeds" empty. We do not pass one (the clip was taken at acquisition), and the note stays
 * because the next person to add a bbox is the one it will bite.
 */
export function threeDhpExtractArgs(gpkg: string, out: string): string[] {
  return [
    '-f',
    'GeoJSONSeq',
    out,
    gpkg,
    'waterbody',
    '-select',
    THREE_DHP_SELECT.join(','),
    '-where',
    `areasqkm >= ${ONE_ACRE_SQ_KM}`,
    '-t_srs',
    'EPSG:4326',
    '-dim',
    'XY',
    '-overwrite',
  ];
}
