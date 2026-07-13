# @skating/etl — OSM water-body ETL (Phase 1)

A manual, run-on-demand pipeline that turns a regional **OpenStreetMap** extract into the
canonical water bodies stored in Convex (`waterBodies`, `source: 'osm'`). This is **not**
built or deployed with the apps — you run it by hand when seeding or refreshing a region
(D5 / D14 / D48; see [`plans/phase-1-water-bodies.md`](../../plans/phase-1-water-bodies.md)).

Pipeline stages:

1. **Fetch** — download a [Geofabrik](https://download.geofabrik.de/) regional extract.
2. **Filter + convert** — `osmium` + `GDAL`: keep water features, export clean GeoJSON.
3. **Transform** — TypeScript: classify OSM tags → our `type`, simplify to ~5 m, compute
   `bbox` / on-water `centroid` / `surfaceAreaSqM`, emit **NDJSON**.
4. **Load** — chunk the NDJSON into the internal `importCanonical` Convex mutation.

The **transform** is first-class, tested TypeScript built on `@skating/core`. The **fetch /
convert / load** stages are thin glue around external CLIs and the Convex CLI.

---

## Prerequisites

Two non-npm command-line tools do the heavy OSM parsing. They are **local developer
prerequisites** — installed on your machine, *not* workspace (`node_modules`) dependencies:

| Tool                        | Binary(ies)          | Role                                                        |
| --------------------------- | -------------------- | ---------------------------------------------------------- |
| [osmium-tool](https://osmcode.org/osmium-tool/) | `osmium`  | Filter an OSM extract + export GeoJSON with flat, clean tags. |
| [GDAL](https://gdal.org/)   | `ogr2ogr`, `ogrinfo` | Geometry/format wrangling + validation.                    |

### macOS (Homebrew)

```bash
brew install osmium-tool gdal
```

> `gdal` is a large formula (many geospatial dependencies) — the first install can take
> several minutes. `osmium-tool` installs the `osmium` binary; `gdal` installs `ogr2ogr`.

### Linux (Debian / Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y osmium-tool gdal-bin
```

### Verify the install

```bash
osmium --version     # expect osmium-tool >= 1.16 (libosmium >= 2.20)
ogr2ogr --version    # expect GDAL >= 3.6
```

Then install the workspace's Node dependencies the usual way (from the repo root):

```bash
pnpm install
```

---

## Data source

The Phase 1 pilot region is **Vermont**, from a single Geofabrik extract (rebuilt daily):

- **Extract:** `https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf`
- **Checksum:** `https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf.md5`
  — verify the download against it before processing.
- **License:** the data is **© OpenStreetMap contributors**, licensed **ODbL**. Attribution
  is a launch-gate acceptance criterion wherever the data appears
  (see [`plans/04-integrations.md`](../../plans/04-integrations.md)).

The `.pbf` is large (tens of MB) and changes daily, so **it is not committed** — it's
gitignored. When you run a real import, record the **download date** and the **md5** in your
run notes / the PR description so the import is reproducible. A small committed fixture
(`fixtures/`) exercises the transform + load path without needing the full extract.

---

## Running the pipeline

Work in a scratch dir (gitignored); nothing here is committed except the final DB rows.

```bash
cd scripts/etl
mkdir -p .scratch && cd .scratch
```

### 1. Fetch

```bash
curl -O https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf
curl -O https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf.md5
md5sum -c vermont-latest.osm.pbf.md5   # macOS: `md5 vermont-latest.osm.pbf` and eyeball
```

> **Last verified run (record yours in the PR):** downloaded 2026-07-12; Geofabrik
> replication `2026-07-11T20:21:30Z` (seq 4846); md5 `2c4113aeec6e732d0233d6cf62437fc0`;
> 431k ways / 8,186 relations.

### 2. Filter + convert (osmium)

Keep the water features (referenced member nodes/ways come along automatically so areas can be
assembled; `-t` strips tags off those members to shrink the file), then export **polygon**
geometries as newline-delimited GeoJSON with the OSM `@type`/`@id` attributes:

```bash
osmium tags-filter -t vermont-latest.osm.pbf \
  natural=water landuse=reservoir natural=bay natural=wetland water \
  -o water.osm.pbf --overwrite

osmium export water.osm.pbf \
  --geometry-types=polygon \
  -a type,id \
  -f geojsonseq -x print_record_separator=false \
  -o water.geojsonseq --overwrite
```

- The filter is a **superset** of what we import — the transform's classifier
  (`@skating/core` `waterBodyTypeFromOsmTags`) makes the final call and drops the rest
  (rivers, streams, generic/non-marsh wetland, …).
- `-a type,id` writes `@type` (`way`/`relation`) + `@id` (the OSM object id). The transform
  keys `externalId` on these as **`way/<id>`** / **`relation/<id>`** — the standard OSM
  identifier. (Do **not** use the top-level GeoJSON `id`: that's osmium's internal *area* id,
  `osm_id * 2 (+1)`, not the OSM object id.)
- osmium normalizes every area to a `MultiPolygon`.

### 3. Transform (tested TS)

```bash
cd ..                                   # back to scripts/etl
pnpm --filter @skating/etl transform .scratch/water.geojsonseq .scratch/bodies.ndjson
```

Classifies each feature, simplifies to ~5 m (D48), computes `bbox` / on-water `centroid` /
`surfaceAreaSqM`, and writes one canonical body per line. A degenerate/bad feature is logged
and skipped (never aborts the batch); the run summary prints imported / dropped / skipped
counts and the **densest ring** (so any adaptive coarsening is visible). *(Reference: the
2026-07-12 Vermont extract yields ~9,970 bodies from ~12,700 polygon features — the remainder
are deferred rivers/wetland. Total NDJSON ≈ 6 MB.)*

**Adaptive coarsening (D48 hard-limit escape hatch).** Every body gets the uniform ~5 m pass.
Convex additionally rejects any **array over 8,192 elements**, which includes a polygon ring's
coordinates — Lake Champlain's outer ring is ~8,900 at 5 m. So the transform nudges the
tolerance up ~1 m at a time *for that body only* until every ring fits under a safety cap
(8,000); Champlain settles at ~7 m / ~7,600 verts. Realistically it's the sole Vermont body
affected; everything else keeps full 5 m fidelity.

### 4. Load into Convex (dev first)

```bash
pnpm --filter @skating/etl load .scratch/bodies.ndjson
```

Chunks the NDJSON and calls the internal `waterBodies.importCanonical` mutation via
`pnpm exec convex run` (which invokes internal functions with the deployment's admin creds
from `packages/convex/.env.local`). It targets the **dev** deployment — confirm the data
renders on the read-only web map before anything touches prod. The import is **idempotent**
(upsert on `source + externalId`) and **preserves removed state**, so re-running is safe.

Batches are bounded by two limits (see `src/load.ts`):

- **Reads/mutation (the binding one):** Convex caps a mutation at 4,096 document reads, and
  each body's geospatial index insert reads several S2-cell docs — a cost that *grows with the
  index size*. So batches are capped by **count** (~150 bodies), not just bytes, to stay under
  4,096 even at full-corpus index size.
- **ARG_MAX:** `convex run` takes args only as an inline JSON string, so each batch's serialized
  args are also kept under a byte budget (Champlain, ~0.3 MiB, is the only near-solo batch).

### Fixture (no extract needed)

`fixtures/vermont-sample.geojsonseq` is a committed handful of **real** Vermont features
(Lake Morey, Occom Pond, Sugar Hill Reservoir, Walker Swamp, …) plus the deferral cases
(a river, a subtag-less wetland). It's what the transform tests run against, and it exercises
the transform → load path without downloading the full extract:

```bash
pnpm --filter @skating/etl transform fixtures/vermont-sample.geojsonseq .scratch/sample.ndjson
```
