# @skating/admin-areas — OSM administrative-boundary ETL (Phase 5)

A manual, run-on-demand pipeline that turns a regional **OpenStreetMap** extract into the
administrative boundaries stored in Convex (`adminAreas`), used to resolve a report's point
(put-in pin / GPS start) → `{ town?, county?, state? }` for the newsfeed location label. This is
**not** built or deployed with the apps — you run it by hand when seeding or refreshing a region
(Phase 5; see [`plans/phase-5-newsfeed.md`](../../plans/phase-5-newsfeed.md)).

It reuses the **same per-state Geofabrik extracts** the water ETL (`scripts/etl`) already uses — no
new dataset, same **© OpenStreetMap contributors / ODbL** attribution. Pipeline stages mirror the
water ETL:

1. **Fetch** — the per-state Geofabrik extract (you likely already have it from the water run).
2. **Filter + convert** — `osmium` + `GDAL`: keep `boundary=administrative` relations, export GeoJSON.
3. **Transform** — TypeScript: classify `admin_level` → our `level` (state/county/town), simplify to
   ~5 m, compute `bbox` / on-boundary `centroid`, emit **NDJSON**.
4. **Load** — chunk the NDJSON into the internal `adminAreas.importCanonical` mutation, stamping
   `--state=XX` onto every row.

Prerequisites (`osmium-tool`, `GDAL`) are the same as the water ETL — see
[`scripts/etl/README.md`](../etl/README.md#prerequisites).

---

## Running the pipeline (per state)

Admin boundaries **don't span states** (unlike water bodies), so each per-state extract is a single
state and the loader stamps `--state=XX` onto every row. Run once per state (VT, NH, ME, MA, and the
clipped NY-upstate extract — same set as Phase 2.5).

```bash
cd scripts/admin-areas
mkdir -p .scratch && cd .scratch
```

### 1. Fetch

Reuse the state's `.osm.pbf` from the water ETL run, or download it (see the water README for the
`curl -L` redirect note + md5 verification):

```bash
curl -L -o vermont-latest.osm.pbf https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf
```

### 2. Filter + convert (osmium)

Keep the administrative-boundary relations (member ways come along so areas assemble), then export
**polygon** geometries as newline-delimited GeoJSON with the OSM `@type`/`@id` attributes:

```bash
osmium tags-filter vermont-latest.osm.pbf \
  r/boundary=administrative \
  -o boundaries.osm.pbf --overwrite

osmium export boundaries.osm.pbf \
  --geometry-types=polygon \
  -a type,id \
  -f geojsonseq -x print_record_separator=false \
  -o boundaries.geojsonseq --overwrite
```

The transform keeps only `admin_level` **4** (state) / **6** (county) / **7–8** (town/city) and drops
the rest (nation, neighborhoods, wards, …). New England towns tile at level 8; some states use 7.

> **NY:** use the same **upstate-clipped** `.osm.pbf` as the water ETL (`--bbox` drop of the NYC/Long
> Island metro), so downstate boundaries never import. See the water README's Phase 2.5 section.

### 3. Transform (tested TS)

```bash
cd ..                                   # back to scripts/admin-areas
pnpm --filter @skating/admin-areas transform .scratch/boundaries.geojsonseq .scratch/areas.ndjson
```

Classifies each boundary, simplifies to ~5 m, computes `bbox` / on-boundary `centroid`, and writes
one record per line. A degenerate/bad feature is logged and skipped (never aborts the batch); the run
summary prints imported (by level) / dropped / skipped counts and the **densest ring** (so any
adaptive coarsening — state outlines are the dense ones — is visible). Adaptive coarsening is the same
D48 hard-limit escape hatch as the water ETL (Convex's 8192-element array cap).

### 4. Load into Convex (dev first)

```bash
pnpm --filter @skating/admin-areas load .scratch/areas.ndjson --state=VT
```

`--state=XX` is **required** — it's the 2-letter code stamped onto every row (each extract is one
state). Chunks the NDJSON and calls the internal `adminAreas.importCanonical` mutation via
`pnpm exec convex run`. It **refuses a non-dev target unless you pass `--prod`**, and prints the
resolved deployment before loading. The import is **idempotent** (upsert on `externalId`), so
re-running (or resuming after a failed batch) is safe.

The import also **cell-indexes each boundary** (N1): one `adminAreaCells` row per grid cell the
boundary's bbox covers, which is what `resolvePlaceForCoord` reads. Cells are reconciled rather than
appended, so re-importing a redrawn boundary moves its rows instead of leaving stale ones. To rebuild
the index for every boundary without re-importing, loop the paginated migration until `isDone`:

```bash
pnpm exec convex run adminAreas:backfillCells '{"batchSize": 200}'
pnpm exec convex run adminAreas:backfillCells '{"batchSize": 200, "cursor": "<cursor>"}'
```

> **Size no longer matters here.** Containment used to run off a *centroid* prefilter with a ±0.2°
> town margin, which silently degraded to a county-only label for any town wider than ~0.4° (the
> Adirondacks have several). A boundary is now indexed in every cell it covers, so a point resolves
> exactly regardless of how big the town is.

### 5. Backfill `reports.place` (one-time, after the import)

Existing reports predate the point-derived label, so once the boundaries are loaded, run the Phase-5
report migration to stamp `place` (and complete the `skateTime` → `skateEndTime` rename) — see
[`plans/phase-5-newsfeed.md`](../../plans/phase-5-newsfeed.md) → schema-migration dance and
`reports.renameSkateTimeToSkateEndTime`. It's paginated (N1), so loop it on its returned `cursor`
until `isDone`.

---

## Record each extract's md5 (per state)

Same reproducibility discipline as the water ETL — Geofabrik rebuilds the `-latest` extracts daily.
For each state, verify the download against its `.osm.pbf.md5` and record the md5 + Geofabrik
replication timestamp in your run notes / the PR description.
