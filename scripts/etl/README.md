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

## Pinning the OSM snapshot

> **This ETL's provenance discipline failed once already, and the failure is recorded below in its
> own run table: five states, all reading `_(not captured)_`.** Geofabrik rebuilds `-latest` daily,
> so the exact snapshot behind our 116,070 bodies is gone and cannot be recovered. The instruction to
> capture it existed since Phase 1; it just wasn't a command anybody ran.

```bash
pnpm --filter @skating/etl archive              # all five states
pnpm --filter @skating/etl archive VT           # one
pnpm --filter @skating/etl archive --refresh    # re-pull, overwriting
```

Extracts land in a gitignored **`.raw/<state>/`** that is **never deleted** — the same split
[`scripts/bathymetry`](../bathymetry/README.md) uses, and for the same reason: `.scratch/` holds
things that rebuild locally, `.raw/` holds the things that cannot be rebuilt at all.

**The pin is the *resolved* URL, not the requested one.** `vermont-latest.osm.pbf` is a redirect;
following it lands on `vermont-260731.osm.pbf`, a dated build that stays retrievable for months.
Recording what we asked for pins nothing; recording what we got pins everything — and that is exactly
the distinction a hand-written run note loses.

Each `manifest.json` records the requested URL, the resolved dated URL, the build date, our sha256,
Geofabrik's published md5, and **whether the two matched**. "Unverified" and "mismatched" stay
distinct on purpose: collapsing them is how a truncated download gets loaded on a technicality.

**Two things this does not do.** It does not recover the current corpus's provenance — nothing can.
And it does not re-import anything: archiving is a fetch, and the corpus on dev is untouched until
someone runs the transform and loader against a new extract.

---

## Running the pipeline

Work in a scratch dir (gitignored); nothing here is committed except the final DB rows.

```bash
cd scripts/etl
mkdir -p .scratch && cd .scratch
```

### 1. Fetch

```bash
# NOTE: the `-latest` URLs now 302-redirect to a dated build, so `curl -L` (follow redirects) is
# required — a plain `curl -O` saves the redirect HTML, not the extract.
curl -L -o vermont-latest.osm.pbf     https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf
curl -L -o vermont-latest.osm.pbf.md5 https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf.md5
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
pnpm --filter @skating/etl transform .scratch/water.geojsonseq .scratch/bodies.ndjson \
  --depths=.scratch/depths.ndjson       # optional second stream, see step 5
```

Classifies each feature, simplifies to ~5 m (D48), computes `bbox` / on-water `centroid` /
`surfaceAreaSqM`, and writes one canonical body per line. A degenerate/bad feature is logged
and skipped (never aborts the batch); the run summary prints imported / dropped / skipped
counts and the **densest ring** (so any adaptive coarsening is visible). *(Reference: the
2026-07-12 Vermont extract yields ~9,970 bodies from ~12,700 polygon features — the remainder
are deferred rivers/wetland. Total NDJSON ≈ 6 MB.)*

**`--depths` — OSM depth tags (N6a rung 7).** A second, much smaller NDJSON: the bodies carrying a
`depth` / `maxdepth` / `depth:mean` tag we can read. The parse is deliberately strict — a bare value is
metres, an explicit `m`/`ft`/`'` converts, and a range (`2-3`), an approximation (`~5`) or anything else
is refused rather than guessed at, because this is the bottom rung of the D68 ladder and a wrong number
here feeds a safety signal. **A bare `depth` becomes a `max`, never a mean**: OSM documents the tag
loosely enough that mappers use it for all three, and the mean is the field that *wins* the shallow
classification, so reading it as a max routes it through the generous 7 m fallback instead. Expect very
few — inland coverage is near-nil and the real ones are usually nautical. The count is printed either
way, because "no lake in five states tags its depth" is a finding and a silent absence isn't.

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
from `packages/convex/.env.local`). It **refuses a non-dev target unless you pass `--prod`** —
so the normal command can't upsert into production by accident — and prints the resolved
deployment before loading. Confirm the data renders on the read-only web map before touching
prod. The import is **idempotent** (upsert on `source + externalId`) and **preserves removed
state**, so re-running (or resuming after a failed batch, which the loader reports) is safe.
`importCanonical` also **cell-indexes each body** (N1) — one `waterBodyCells` row per grid cell its
bbox covers, at a rung no finer than the zoom it first draws at — which is what `listInViewport`
reads. Cells are reconciled, not appended, so a re-import of a redrawn lake moves its rows rather
than leaving stale ones behind, and re-running the loader is a safe way to repair a body's index.
To repair the *whole* corpus without re-running the ETL, use the paginated
`waterBodies:backfillCells` migration instead (see below).

Batches are bounded by two limits (see `src/load.ts`):

- **Reads/mutation:** Convex caps a mutation at 4,096 document reads. This *used* to be the binding
  constraint — each body's geospatial index insert read ~15–20 S2-cell docs, a cost that grew with
  the index size, so a batch fine against an empty index blew the cap once tens of thousands of
  bodies were loaded. **Since N1 a body costs one `by_body` lookup plus ≤ 4 cell writes, flat
  regardless of corpus size**, so the ~150-body count cap now has enormous headroom here.
- **ARG_MAX (now the binding one):** `convex run` takes args only as an inline JSON string, so each
  batch's serialized args are kept under a byte budget (Champlain, ~0.3 MiB, is the only near-solo
  batch).

### 5. Load the OSM depth tags (optional, N6a)

```bash
pnpm --filter @skating/etl load-depths .scratch/depths.ndjson
```

Sends them to `waterBodies.importDepths`, which keys on `source` + `externalId` — no spatial join needed,
since these depths came off the very features the bodies were built from. (The *global* depth sources
need a geometric join and live in [`scripts/lake-depth`](../lake-depth/README.md).) The D68 ladder runs
inside the mutation and `osm_tag` is its bottom rung, so a re-run can only fill a measurement nothing
better has claimed, and it can never overwrite a moderator's reading or rejection.

### Repairing the spatial index without a re-import

`waterBodies:backfillCells` re-derives a body's D49 prominence and rebuilds its cell rows, paginated
so it's safe at any corpus size (dev's 116,070 bodies took 233 batches). Loop it until `isDone`:

```bash
# one batch; feed the returned `cursor` back in until `isDone` is true
pnpm exec convex run waterBodies:backfillCells '{"batchSize": 500}'
pnpm exec convex run waterBodies:backfillCells '{"batchSize": 500, "cursor": "<cursor>"}'
```

`adminAreas:backfillCells` is the same shape for boundaries. You need these only after a schema or
scoring change that invalidates existing rows — a normal import maintains them itself.

### Fixture (no extract needed)

`fixtures/vermont-sample.geojsonseq` is a committed handful of **real** Vermont features
(Lake Morey, Occom Pond, Sugar Hill Reservoir, Walker Swamp, …) plus the deferral cases
(a river, a subtag-less wetland). It's what the transform tests run against, and it exercises
the transform → load path without downloading the full extract:

```bash
pnpm --filter @skating/etl transform fixtures/vermont-sample.geojsonseq .scratch/sample.ndjson
```

---

## Regional expansion (Phase 2.5)

To widen the corpus beyond Vermont, run the same pipeline **once per state** — no code change; the
transform/load already handle multiple states. Full runbook + rationale:
[`plans/phase-2.5-regional-expansion.md`](../../plans/phase-2.5-regional-expansion.md).

- **States (per-state Geofabrik extracts, not `us/northeast`):** `new-york`, `vermont`,
  `new-hampshire`, `maine`, `massachusetts`.
- **NY only — clip the NYC/Long Island metro** *before* the tags-filter, so downstate never imports:
  ```bash
  osmium extract --bbox=-79.9,41.3,-71.8,45.1 new-york-latest.osm.pbf \
    -o new-york-upstate.osm.pbf --overwrite --strategy=complete_ways
  ```
  Then run the normal filter → export → transform → load on `new-york-upstate.osm.pbf`. The 41.3°N
  cut was chosen to sit well south of every skated NY lake (Lake George ~43.4, Saranac/Placid ~44.3).
- **Tag each load with its state:** pass `--state=XX` (2-letter code) to the loader so each body
  records the region(s) it's in — `importCanonical` **unions** it into the body's `states`:
  ```bash
  pnpm --filter @skating/etl load .scratch/new-york/bodies.ndjson --state=NY
  ```
  This powers the map search-result location label + `curatedBoost` disambiguation (Phase 2.5).
- **Border-spanning bodies dedupe automatically** *and* accumulate states. `importCanonical` upserts
  on `source+externalId`, so a lake in two extracts (Lake Champlain in VT *and* NY; Connecticut River
  bays in VT *and* NH) lands as one row and its `states` unions to e.g. `["NY","VT"]` — run order
  doesn't matter. VT can be skipped if already loaded (but re-run it with `--state=VT` to backfill
  the state tag).
- **Record each extract's md5 (per state)** — now automatic, see §*Pinning the OSM snapshot* below.
  `pnpm --filter @skating/etl archive` captures the resolved dated URL, Geofabrik's md5, our sha256
  and the byte count, and prints the run-table rows already filled in. The manual version of this
  instruction was followed zero times out of five (below), which is why it is now code.
- **Executed 2026-07-15 (dev):** NH 15,458 · ME 25,541 · MA 30,219 · NY 34,885 inserted (+ VT ~9,970)
  ≈ 116k bodies, zero read-cap errors. *(Exact count confirmed 2026-07-26 by N1's cell backfill:
  **116,070** bodies.)* Extract builds dated 2026-07-14. **md5s not captured this run**
  — record them per state on the next re-run (dated build no longer retrievable to hash retroactively):

  | State | Extract | md5 | Geofabrik replication |
  | ----- | ------- | --- | --------------------- |
  | NY (clipped) | `new-york-latest.osm.pbf` | _(not captured)_ | _(not captured)_ |
  | VT | `vermont-latest.osm.pbf` | _(not captured)_ | _(not captured)_ |
  | NH | `new-hampshire-latest.osm.pbf` | _(not captured)_ | _(not captured)_ |
  | ME | `maine-latest.osm.pbf` | _(not captured)_ | _(not captured)_ |
  | MA | `massachusetts-latest.osm.pbf` | _(not captured)_ | _(not captured)_ |

  **The row above is kept as the record of the failure, not tidied away.** The five `_(not
  captured)_` cells are why `pnpm --filter @skating/etl archive` exists — the instruction was there
  from Phase 1 and the capture was manual, so it didn't happen. The corpus currently on dev came from
  these extracts and its exact snapshot is unrecoverable.

**Archived extracts (2026-08-01)** — captured mechanically, all five md5-verified against Geofabrik's
own published checksums. **These are not yet loaded**; the dev corpus is still the 2026-07-14 import
above. This is the pin for the *next* re-import.

| State | Extract | Geofabrik build | sha256 | md5 | Captured |
| --- | --- | --- | --- | --- | --- |
| VT | `vermont-260731.osm.pbf` | 260731 | `66f53cacb79470b2…` | ✓ | 2026-08-01 |
| NH | `new-hampshire-260731.osm.pbf` | 260731 | `c33c9bb30fc52a55…` | ✓ | 2026-08-01 |
| ME | `maine-260731.osm.pbf` | 260731 | `f41005da3a37a289…` | ✓ | 2026-08-01 |
| MA | `massachusetts-260731.osm.pbf` | 260731 | `6d14690559f4761a…` | ✓ | 2026-08-01 |
| NY | `new-york-260731.osm.pbf` | 260731 | `d167cb4b9a4035a0…` | ✓ | 2026-08-01 |

Mirrored to the private R2 bucket `skating-raw-lake-osm` (`scripts/etl/mirror-r2.sh push`).
