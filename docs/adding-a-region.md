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

The map is built from **three data sets that must agree on the same bounding box**:

1. **Water bodies** — the lake/pond polygons we render as our own layer and attach reports to.
   Sourced from OpenStreetMap via the ETL pipeline (`scripts/etl`), loaded into Convex.
2. **Admin boundaries** — state/county/town polygons that turn a report's coordinate into its
   "Burlington, VT" label in the newsfeed. Same Geofabrik extracts, different pipeline
   (`scripts/admin-areas`). **Easy to forget**, and the symptom is quiet: reports in the new region
   simply have no place label.
3. **Basemap tiles** — the underlying land/roads/labels, a Protomaps `.pmtiles` file we build
   and host on Cloudflare R2 (`scripts/basemap`). The app reads its URL from an env var.

**And one that deliberately does not fit that model:** *bathymetry contours* (`scripts/bathymetry`,
Step 4b) are keyed to **state agencies**, not to a bounding box. Widening the envelope gets you no
contours; a state that publishes them does. It is optional, it is per-agency, and it is the one step
that can honestly answer "this state has none."*

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
- **Each body is D49-scored and cell-indexed on insert** — `displayScore` + `minVisibleZoom` for
  zoom-based prominence, plus the `waterBodyCells` rows the map reads (N1). Import cost per body is
  flat regardless of how big the corpus already is, so the loader's batching has plenty of headroom;
  its binding constraint is `ARG_MAX` on the `convex run` argument string, not reads. Dev holds
  **116,070** bodies across five states.
- **Record the md5 + Geofabrik replication timestamp per extract** in your PR — Geofabrik
  rebuilds `-latest` daily, so the date alone doesn't pin the source, and it catches a truncated
  download before tens of thousands of bad bodies load. Log them in the ETL README's run table.

**Verify before moving on:** open the read-only web map and confirm the new lakes render.

---

## Step 1b — Import the admin boundaries (per state)

The step it's easiest to skip, because nothing breaks visibly when you do — reports in the new
region just quietly have no "Burlington, VT" label. Full detail:
[`scripts/admin-areas/README.md`](../scripts/admin-areas/README.md). It reuses the **same extract**
you already downloaded in Step 1:

```bash
cd scripts/admin-areas && mkdir -p .scratch && cd .scratch

# 1. Filter to administrative boundary relations, export polygons
osmium tags-filter ../../etl/.scratch/<state>-latest.osm.pbf r/boundary=administrative \
  -o boundaries.osm.pbf --overwrite
osmium export boundaries.osm.pbf --geometry-types=polygon -a type,id \
  -f geojsonseq -x print_record_separator=false -o boundaries.geojsonseq --overwrite

# 2. Transform (keeps admin_level 4 / 6 / 7–8 → state / county / town)
cd .. && pnpm --filter @skating/admin-areas transform .scratch/boundaries.geojsonseq .scratch/areas.ndjson

# 3. Load into Convex dev
pnpm --filter @skating/admin-areas load .scratch/areas.ndjson --state=<XX>
```

- **Use the clipped extract for a clipped state.** If Step 1 clipped NY downstate, boundaries must
  use the same clipped `.osm.pbf`, or you import downstate towns you deliberately excluded.
- **`--state=XX` is required here too** — unlike lakes, boundaries don't span states, so each
  extract is exactly one state's worth.
- **Town size doesn't matter.** Containment runs off the same bbox-coverage cell index as water
  bodies (N1), so an enormous rural town resolves as exactly as a small one. It didn't used to: the
  previous centroid-margin lookup silently fell back to a county-only label for towns wider than
  ~0.4°, which the Adirondacks are full of.

**Verify before moving on:** file a test report on a lake in the new region and confirm the feed
card shows a town/county line, not just the lake name.

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

## Step 4b — Bathymetry contours (per **agency**, not per bbox)

> **Status: the ETL half is built and runnable; the clients do not render it yet (N6b).** Follow this
> to produce and host the tiles; the last step (repointing an app env var) has nothing to point at
> until the client work lands.

**This step breaks the mental model above, and that is the most important thing to know about it.**
The other three data sets agree on one bounding box. Bathymetry agrees on nothing geographic: it is
published **per state agency**, on that agency's own schedule, in that agency's own format, covering
whichever lakes that agency happened to survey. Widening the region envelope does not get you more
contours. **Asking whether the new state publishes bathymetry at all** does.

That question is research, not a pipeline run, and it has a real chance of answering "no" — New York
publishes none, which we established by enumerating every layer on NYSDEC's ArcGIS server, the full
385-dataset NYS GIS Clearinghouse catalogue, ArcGIS Online and `data.ny.gov`. Budget an afternoon,
and see `plans/phase-N6b-bathymetry-layer.md` §New York for what a thorough "no" looks like so you
can stop when you reach one.

### If the state does publish

```bash
cd scripts/bathymetry

# 1. Probe the layer before committing to it — lines or points, how many, what credit is required.
pnpm --filter @skating/bathymetry probe <layer-url>

# 2. Add an entry to src/sources.ts (key, state, agency, kind, unit, url, attribution, datum, notes).
#    Adding a state is a DATA entry, never a code path. If you find yourself writing an `if` on the
#    state name, the registry is the thing to extend instead.

# 3. Archive it, mirror it, and record it.
pnpm --filter @skating/bathymetry snapshot --state=XX
scripts/bathymetry/mirror-r2.sh push
pnpm --filter @skating/bathymetry provenance

# 4. Resolve every lake to one of our water bodies (needs the corpus from Step 1 already loaded).
pnpm --filter @skating/bathymetry join --refresh

# 5. Run the chain and tile it.
pnpm --filter @skating/bathymetry build-contours
scripts/bathymetry/tile.sh --upload dev/bathymetry-$(date +%Y%m%d).pmtiles
```

**Two lanes, and which one you are in is a provenance claim rather than a file format.** If the agency
publishes **contour lines**, we reproject and clip and invent nothing. If it publishes **sounding
points**, *we* fit the surface — a weaker claim, gated harder, and labelled differently in the drawer.
Both are legitimate; conflating them is not.

### What will actually go wrong

- **Order matters: `join` needs Step 1's water corpus already loaded.** The join resolves a source
  lake to *our* body, so running it against a corpus that lacks the new state matches nothing and
  reports a clean, wrong 0%.
- **`join` is slow — budget ~25 minutes for a five-state corpus.** It spawns one `convex run` per
  batch, and the Convex 16 MB per-execution read cap forces small batches. It is resumable: the result
  is cached, and only `--refresh` re-runs it.
- **Read the drop tally, do not skim it.** `build-contours` writes `.scratch/build/dropped.json` and
  prints counts by reason. A lake dropped by the density gate and a lake dropped by a bug produce the
  *same* result on the finished map — a flat shape — so the tally is the only place the difference is
  visible.
- **A source key does not always mean one lake.** NH files two ponds 51 km apart under one `au_id`;
  Maine's MIDAS `870` scatters over 379 km of the state. The pipeline splits these automatically and
  names them, but if a new agency's keying is worse you will see it in that log first.
- **`verify` before you re-snapshot.** Two cheap requests per source tell you whether the agency
  republished; a re-snapshot without it is a download you may not need.

### Checklist additions

- [ ] Established whether the state publishes bathymetry **at all**, and recorded the search if the
      answer is no.
- [ ] `src/sources.ts` entry added with the agency's own required credit wording, its vertical datum,
      and any notice its terms require (NOAA chart-derived data carries *"not for navigation"*).
- [ ] Archive snapshotted, mirrored to the **private** raw bucket, and `PROVENANCE.md` regenerated.
- [ ] `join` run **after** the water corpus for that state is loaded; match rate spot-checked.
- [ ] `build-contours` drop tally read, not skimmed.
- [ ] Tiles uploaded to the **public** basemap bucket (the overlay is range-read by browsers, unlike
      `.raw/`).

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
- [ ] Admin boundaries imported per state (`scripts/admin-areas`), and a report in the new region
      shows a town/county label rather than a bare lake name.
- [ ] Read counts spot-checked against the new corpus with `waterBodies:viewportReadStats` — a wide
      zoom, a dense zoom, and a pan into empty space. *(This checklist item existed before N1 and was
      never actually performed, which is how a 256-body clamp sized for a 9,967-body corpus survived
      a jump to 116k and started dropping real lakes. It takes a minute; do it.)*

---

## The three-box drift trap (the thing most likely to bite you)

The region envelope lives in **three** places. If they disagree:

- **ETL clip bbox** too small → wanted lakes never import.
- **`pmtiles --bbox`** smaller than the pan bounds → **blank tiles** at the corners.
- **`NORTHEAST_MAX_BOUNDS`** larger than the tile bbox → the user can **pan past the data** into
  a blank area.

Keep all three identical (the clip bbox may be a subset if you're intentionally trimming, like
downstate NY). Each file calls this out; this guide is the one place they're listed together.
