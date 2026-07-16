# Adding a new region to the map

A practical, end-to-end runbook for expanding map coverage to a new geographic area — new
states, a new part of the country, or eventually a new country. This is the generalized version
of what we did in **Phase 2.5** when we grew the pilot from Vermont-only to the five-state
Northeast (NY/VT/NH/ME/MA). If you follow it top to bottom you'll end up with real lake data and
a matching basemap live on the map, with no app-code surprises.

> **Who this is for.** A contributor with shell access, the Convex dev deployment credentials,
> and a Cloudflare R2 bucket. You do **not** need to touch app code beyond four small constants
> (bounds + framing). Everything else is data + infra you run by hand.

---

## The mental model (read this first)

The map is built from **two independent data sets that must agree on the same bounding box**:

1. **Water bodies** — the lake/pond polygons we render as our own layer and attach reports to.
   Sourced from OpenStreetMap via the ETL pipeline (`scripts/etl`), loaded into Convex.
2. **Basemap tiles** — the underlying land/roads/labels, a Protomaps `.pmtiles` file we build
   and host on Cloudflare R2 (`scripts/basemap`). The app reads its URL from an env var.

On top of those, **three places hard-code the region's bounding box**, and they must stay in
sync or you get blank tiles at a corner or a map that pans past the data:

- the ETL clip bbox (only if you clip an extract, like we do for downstate NY),
- the `pmtiles extract --bbox` (basemap coverage),
- `NORTHEAST_MAX_BOUNDS` in **both** `apps/web/src/lib/waterMap.ts` and
  `apps/mobile/src/lib/waterMap.ts` (how far the user can pan).

**Hard ordering rule:** land the water **data first**, then build/host tiles, then — *last* —
widen the map bounds. Never widen bounds before the data lands, or a user can pan into an empty
area. (Data and tiles are independent of each other; the strict dependency is *bounds come
last*.)

---

## Prerequisites (one-time setup)

**CLI tools** (see [`scripts/etl/README.md`](../scripts/etl/README.md) and
[`scripts/basemap/README.md`](../scripts/basemap/README.md) for details):

```bash
brew install osmium-tool gdal pmtiles rclone   # macOS; apt equivalents on Linux
pnpm install                                    # workspace Node deps, from the repo root
```

- `osmium` + `ogr2ogr` (GDAL) — OSM filtering + geometry conversion.
- `pmtiles` — extract a regional basemap from a Protomaps planet build.
- `rclone` — resumable multipart upload to Cloudflare R2 (the R2 dashboard / `wrangler` caps
  out around 300 MiB; a multi-state `.pmtiles` blows past that).

**Cloudflare R2** — a bucket named `skating-basemap` and an rclone remote named `r2`. Full
walkthrough (API token, `rclone config`, public access) is in
[`scripts/basemap/README.md`](../scripts/basemap/README.md) §2b and
[`scripts/basemap/RCLONE_SETUP.md`](../scripts/basemap/RCLONE_SETUP.md).

**Convex target — dev first, always.** The ETL loader and the tile upload both refuse a
non-dev deployment unless you pass `--prod`, so you can't accidentally touch production. Confirm
the new region renders on dev before you even think about prod. (As of this writing prod is not
yet initialized — everything targets dev.)

---

## Step 0 — Decide the region and its bounding box

Pick the area and write down a single bounding box (`west,south,east,north` in lon/lat) that:

- covers every lake you want to import,
- excludes areas you *don't* want (in Phase 2.5 we cut the NYC/Long Island metro so downstate
  clutter never imported — a straight lat cut at ~41.3°N, chosen to sit well south of every
  skated lake so it can't bisect a destination),
- is the same box you'll use for the tile extract and the pan bounds.

Sanity-check the box against a few known destination lakes before you commit — confirm none fall
outside it or on the wrong side of a clip line.

> **Geofabrik gotcha:** prefer **per-state** (or per-region) extracts over a bundled dump like
> `us/northeast` — the bundle drags in states you don't want (NJ/PA/CT/RI) which is clutter +
> storage cost. Pull each state's extract individually.

---

## Step 1 — Import the water data (per state/extract)

Run the Phase 1 ETL pipeline **once per extract**. Full detail:
[`scripts/etl/README.md`](../scripts/etl/README.md). The short version, per state:

```bash
cd scripts/etl && mkdir -p .scratch && cd .scratch

# 1. Fetch (the -latest URLs 302-redirect to a dated build — curl -L is REQUIRED)
curl -L -o <state>-latest.osm.pbf     https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf
curl -L -o <state>-latest.osm.pbf.md5 https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf.md5
md5sum -c <state>-latest.osm.pbf.md5   # macOS: `md5 <state>-latest.osm.pbf` and eyeball

# 1a. (Optional) clip before filtering, if this extract needs a sub-region cut.
#     Example — NY downstate cut. --strategy=complete_ways keeps border lakes whole.
osmium extract --bbox=-79.9,41.3,-71.8,45.1 <state>-latest.osm.pbf \
  -o <state>-clipped.osm.pbf --overwrite --strategy=complete_ways

# 2. Filter to water features + export polygon GeoJSON
osmium tags-filter -t <state>-latest.osm.pbf \
  natural=water landuse=reservoir natural=bay natural=wetland water \
  -o water.osm.pbf --overwrite
osmium export water.osm.pbf --geometry-types=polygon -a type,id \
  -f geojsonseq -x print_record_separator=false -o water.geojsonseq --overwrite

# 3. Transform (tested TS: classify tags, simplify to ~5m, compute bbox/centroid/area)
cd ..   # back to scripts/etl
pnpm --filter @skating/etl transform .scratch/water.geojsonseq .scratch/bodies.ndjson

# 4. Load into Convex dev, tagged with the 2-letter state code
pnpm --filter @skating/etl load .scratch/bodies.ndjson --state=<XX>
```

Key facts that make this safe to repeat:

- **`--state=XX` matters.** It unions the 2-letter code into each body's `states` array, which
  powers the search-box location label and `curatedBoost` disambiguation. Always pass it.
- **Border-spanning bodies dedupe automatically.** `importCanonical` upserts on
  `source + externalId`, so a lake in two extracts (e.g. Lake Champlain in both VT and NY) lands
  as one row and its `states` unions to both. **Run order doesn't matter**, and re-running is
  idempotent (it also preserves any `removed` state).
- **Each body is D49-scored on insert** (`displayScore` + `minVisibleZoom` for zoom-based
  prominence), and the loader paginates under Convex's 4,096-read-per-mutation cap. A big corpus
  is fine — Phase 2.5 loaded ~116k bodies with zero read-cap errors.
- **Record the md5 + Geofabrik replication timestamp per extract** in your PR — Geofabrik
  rebuilds `-latest` daily, so the date alone doesn't pin the source, and it catches a truncated
  download before tens of thousands of bad bodies load. Log them in the ETL README's run table.

**Verify before moving on:** open the read-only web map and confirm the new lakes render.

---

## Step 2 — Build the basemap tiles

One `pmtiles` extract over the **same bounding box** you'll use for the pan bounds. Full detail:
[`scripts/basemap/README.md`](../scripts/basemap/README.md).

```bash
mkdir -p scripts/basemap/.scratch
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  scripts/basemap/.scratch/<region>-basemap.pmtiles \
  --bbox=<west,south,east,north> \
  --maxzoom=14
pmtiles verify scripts/basemap/.scratch/<region>-basemap.pmtiles
```

- **Source = a live `build.protomaps.com/<date>.pmtiles`.** The old demo `v4.pmtiles` bucket is
  dead (they prune dated builds) — pick a current dated build.
- **`--maxzoom=14`** is the size/fidelity sweet spot: MapLibre overzooms past 14, and our water
  polygons are a separate layer that stays crisp regardless. z15 roughly doubles the file for
  detail a lake map doesn't need.
- **`--bbox` must match `NORTHEAST_MAX_BOUNDS`** (Step 4). The basemap has to cover everywhere
  the map lets you pan. Ocean/empty land in the box costs almost nothing.
- **Size:** expect it to scale with area. The 5-state Northeast box came out ~948 MB (z0–14).
  Anything past a few hundred MB overflows Convex free storage → host on R2 (next step).
- Record the actual size + source in the README's "Last build" table.

---

## Step 3 — Host the tiles on Cloudflare R2

```bash
scripts/basemap/upload-r2.sh scripts/basemap/.scratch/<region>-basemap.pmtiles \
  dev/<region>-YYYYMMDD.pmtiles
```

- One bucket serves both environments via a `dev/` or `prod/` **key prefix**. Dating the key
  makes a rebuild a fresh object + a one-line env swap, with the old object as instant rollback.
- The script `rclone copyto`s the file (multipart + progress) and prints the **public serving
  URL** to wire in Step 4.
- **CORS (web only):** the browser `pmtiles://` protocol needs a CORS rule allowing `GET`/`HEAD`
  + the `Range` header from your web origin(s). Mobile native doesn't use CORS. Apply the rule
  once in the R2 dashboard — the exact JSON is in
  [`scripts/basemap/README.md`](../scripts/basemap/README.md) §CORS.
- **r2.dev to start; custom domain before real traffic.** The zero-config `pub-<hash>.r2.dev`
  URL is fine for an alpha (tile reads are KBs/view). A custom domain + Cloudflare edge caching
  is the prod-hardening step (README §"Custom domain + caching").

---

## Step 4 — Repoint the tile env (no app change)

The app reads the tile URL from an env var, so this is a swap, not code:

- **Web dev:** `VITE_PMTILES_URL=<R2 url>` in `apps/web/.env` (or `.env.local`).
- **Mobile dev:** `EXPO_PUBLIC_PMTILES_URL=<R2 url>` in `apps/mobile/.env.local`.
- **Prod (later):** set the same vars in the Vercel project env / the EAS build env. A local
  `.env.local` value does **not** ship in a cloud build — it must be set in the cloud env for a
  production build.

Reload the map and confirm the basemap covers the new region.

---

## Step 5 — Re-seed `curatedBoost` (optional but recommended)

`curatedBoost` bumps a lake's display prominence so a small-but-beloved lake shows at a wider
zoom (e.g. Lake Morey draws at regional zoom instead of only when you zoom in). If your new
region has known destinations, boost them:

- The community-derived seed lives in
  `training_data/google_group/curated_boost_seed_vt.csv` (names + mention counts, **no
  coordinates**).
- Apply via the internal `waterBodies.applyCuratedBoostSeed` mutation (matches by name through
  the search index, disambiguates a repeated name by an optional state hint else largest area,
  then sets the boost + rescores + re-indexes). Or set individual bodies via the
  `waterBodies.setCuratedBoost` admin mutation.
- **Expect imperfect matches.** The seed has no coordinates, so a name that repeats across states
  (or a "bay" that isn't its own OSM body) can mis-match or not-find. That's the exact curation
  the **Phase 7 admin water-body UI** is meant to own (set/adjust/remove per-body boost with the
  map in front of you). For now, spot-check the wins and don't over-invest in the seed.

---

## Step 6 — Widen the map bounds and framing (LAST)

Only after Step 1 confirms the wider corpus renders. Edit **both**
`apps/web/src/lib/waterMap.ts` and `apps/mobile/src/lib/waterMap.ts`, kept in sync with each
other **and** the Step 2 `--bbox`:

- **`NORTHEAST_MAX_BOUNDS`** — widen (or rename, if "Northeast" no longer fits) to the region
  envelope. This is how far the user can pan; it must match the tile `--bbox`.
- **`INITIAL_CENTER`** — the no-geolocation fallback center. Move it toward the middle of the new
  envelope if the old center is now off to one side.
- **`INITIAL_ZOOM`** — lower it if the region grew, so the fallback framing shows the whole
  region rather than just one corner. (Framing is device-geolocation-first; this only affects the
  no-fix fallback.)
- **`frameForCoord`** needs no logic change — its in-region gate defaults to the max-bounds
  constant, so widening the constant widens the gate automatically.
- **Update `waterMap.test.ts` in both apps** — the in-region/out-of-region `frameForCoord`
  cases (a coord that's now in-region but used to be out) and any hard-coded bounds assertions.
  ODbL attribution assertions are unchanged (attribution is driven by the water source, not the
  tile host).

---

## Final checklist

- [ ] Bounding box decided; known destination lakes verified inside it / on the right side of
      any clip.
- [ ] Water data loaded per extract with `--state=XX`; md5 + replication timestamp recorded per
      extract in the ETL README run table.
- [ ] Border-spanning lakes render **once**, not doubled (spot-check e.g. a lake shared by two
      states).
- [ ] Basemap built with `--bbox` == the pan bounds; size recorded in the basemap README.
- [ ] Tiles uploaded to R2 under a dated `dev/` key; CORS rule applied for web origins.
- [ ] `VITE_PMTILES_URL` + `EXPO_PUBLIC_PMTILES_URL` repointed; both apps show the new basemap.
- [ ] `curatedBoost` re-seeded (if the region has known destinations); wins spot-checked.
- [ ] Bounds/framing widened in **both** `waterMap.ts` files (== the tile `--bbox`); both
      `waterMap.test.ts` updated; `pnpm test` green.
- [ ] Wide-zoom read counts validated against the new (larger) corpus — the in-query
      `minVisibleZoom` filter should *shrink* wide-zoom reads, not grow them (D49 read-cap
      watch-out).

---

## The three-box drift trap (the thing most likely to bite you)

The region envelope lives in **three** places. If they disagree:

- **ETL clip bbox** too small → wanted lakes never import.
- **`pmtiles --bbox`** smaller than the pan bounds → **blank tiles** at the corners.
- **`NORTHEAST_MAX_BOUNDS`** larger than the tile bbox → the user can **pan past the data** into
  a blank area.

Keep all three identical (the clip bbox may be a subset if you're intentionally trimming, like
downstate NY). Each file calls this out; this guide is the one place they're listed together.
