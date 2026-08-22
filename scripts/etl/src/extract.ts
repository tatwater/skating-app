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
 * The OSM tags the **access** pass keeps (N6d B1) — a second filter over the same state extract.
 *
 * A superset again, and for the same reason: `parseAccessFeature` makes the final call, so this only
 * has to be wide enough not to lose anything. What it must *not* do is overlap the water pass — these
 * are the features beside the water, not the water.
 *
 * - `leisure=slipway` / `waterway=slipway` — a boat ramp. The single highest-value tag here, and the
 *   one that most often carries a `name` worth showing.
 * - `amenity=parking` — where the car goes. Usually a way, sometimes a node.
 * - `amenity=toilets` — almost always a node, and it changes whether a trip works with kids.
 * - `natural=beach` / `leisure=fishing` / `man_made=pier` — the other three ways onto a lake.
 *
 * ⚠ **No trail tags.** `highway=path` / `route=hiking` were in the plan and are deliberately absent:
 * ORS `foot-hiking` routes over exactly those ways, so a successful approach route *is* the evidence a
 * trail exists (N6d correction 9). Extracting them would be a second, larger geometry class parsed to
 * answer a question the routing step already answers — and it is the one class that would have forced
 * line handling into this pipeline.
 */
export const OSM_ACCESS_TAGS = [
  'leisure=slipway',
  'waterway=slipway',
  'amenity=parking',
  'amenity=toilets',
  'natural=beach',
  'leisure=fishing',
  'man_made=pier',
] as const;

/** `osmium tags-filter` argv — the access subset of a state extract (N6d B1). */
export function osmAccessFilterArgs(pbf: string, out: string): string[] {
  return ['tags-filter', '-t', pbf, ...OSM_ACCESS_TAGS, '-o', out, '--overwrite'];
}

/**
 * `osmium export` argv for the access pass — **points and polygons**, where the water pass takes
 * polygons alone.
 *
 * This is the difference that made the second pass a second *configuration* rather than a reuse, and
 * it is not cosmetic: a toilet block is a node, a slipway is a node about as often as it is a way, and
 * `--geometry-types=polygon` would silently drop both. Silently is the operative word — `osmium
 * export` emits fewer features rather than failing, so the pass would report success over an extract
 * missing most of its put-in candidates.
 *
 * Lines are still excluded. Nothing here is a line once trails are out (correction 9), and admitting
 * them would mean a centroid rule for a geometry type with no member worth centroiding.
 *
 * `-a type,id` carries the stable OSM identity (`way/123`) exactly as the water pass does — it is the
 * idempotent upsert key for `putIns.externalId` and `parkingAreas.externalId`, so an export without it
 * would make every re-run duplicate every access point it found.
 */
export function osmAccessExportArgs(filtered: string, out: string): string[] {
  return [
    'export',
    filtered,
    '--geometry-types=point,polygon',
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
 * The OSM tags the **trail** pass keeps (N6e Workstream 0).
 *
 * ⚠ **This is the class N6d correction 9 dropped, admitted back for a different question.** That
 * correction was right about what it was answering: ORS `foot-hiking` routes over these ways, so a
 * successful approach route is the evidence a trail exists, and extracting lines to re-derive that
 * would have been work for an answer already paid for.
 *
 * What it could not answer is the case the routing never reaches. `pairAccessFeatures` caps at
 * `PARKING_INFER_RADIUS_M`, so a lot a kilometre up a trail from a launch **never pairs**, and a leg
 * that is never requested is never routed. The mile-in trailhead is invisible to the pipeline by
 * construction — measured over 3,000 unpaired lots, the distance curve to the nearest launch rises
 * monotonically out to 3–8 km with no trailhead population sitting at a characteristic distance, so
 * no radius finds it either. **Connectivity is a signal where proximity is only a guess**, and that
 * is what these lines are for. They are not stored: they build a graph in the transform and are
 * discarded.
 *
 * `route=hiking` is a **relation** tag; its member ways carry the `highway` tags, so the three
 * `highway` values are what actually match. It is kept in the filter anyway for the ways that carry
 * it directly, on the same superset discipline as the other two passes.
 */
export const OSM_TRAIL_TAGS = [
  'highway=path',
  'highway=footway',
  'highway=track',
  'route=hiking',
] as const;

/** `osmium tags-filter` argv — the trail subset of a state extract (N6e Workstream 0). */
export function osmTrailFilterArgs(pbf: string, out: string): string[] {
  return ['tags-filter', '-t', pbf, ...OSM_TRAIL_TAGS, '-o', out, '--overwrite'];
}

/**
 * `osmium export` argv for the trail pass — **linestrings, and nothing else**.
 *
 * The one geometry class the other two passes exclude, and the reason this is a third configuration
 * rather than a flag on the second: a trail is a line, an access point never is, and a pass that
 * admitted both would have to decide what a "parking area that is a line" means.
 *
 * **`-a type,id` is load-bearing here for a reason it is not elsewhere.** In the other passes the id
 * is an upsert key. Here nothing is stored, and the id is what lets a way appear in two state
 * extracts — every one of these files overlaps its neighbours at the border — and be recognised as
 * one edge rather than two parallel ones, which would double a walk that crosses a state line.
 */
export function osmTrailExportArgs(filtered: string, out: string): string[] {
  return [
    'export',
    filtered,
    '--geometry-types=linestring',
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
