# Next-gen — A terrain-and-canopy wind shelter index, and the "where will I be sheltered tomorrow" map

> **Scoped 2026-09-16 (N9 kickoff), post-alpha, unbuilt.** First doc in the `next-gen-*` series:
> plans the founder wants bundled for after the alpha, not sequenced into the N-phases. This one
> grew out of N9's §Wind in a cove, where the honest conclusion was that a bay's wind rose is the 2 km
> cell's and *fetch* is the only bay-specific wind signal we can compute. This is the part fetch
> cannot answer.
>
> **Depends on:** N9 (bays carry their own `fetchProfileM`); the wind pass (N7 step 11) for the
> loader shape; [`next-gen-weather-stations.md`](./next-gen-weather-stations.md) for the validation
> data. **Blocks nothing.**

---

## Why

A cove ringed by 25 m pines with 300 m of fetch does not feel the open lake's wind, and nothing in a
2 km reanalysis cell (WTK), a 3 km forecast (HRRR) or a 25 km archive (ERA5) can see the pines. The
corpus median body is **12 acres** — a 220 m square — so the over-claim is corpus-wide, not a bay
problem. `fetchProfileM` already answers *how far the wind runs over water before it reaches you*;
this answers *what stands between the wind and the water*, per sector, from two free public-domain
rasters. It is a **modeled** signal and ships labeled as one; it never becomes counsel (D82).

Founder, 2026-09-16: *"I really like the idea of building a terrain-and-canopy shelter index!"* — and,
in the same breath, the consumer that makes it worth building (§The heatmap, below).

---

## The metric — a per-sector exposure factor

For every body **and** every sub-area, **16 sectors** (the same wind-*from* sectors as `windRose`
and `fetchProfileM`, so the three multiply elementwise), an **exposure factor in `[0, 1]`** — 1 is
open plain, 0 is a walled cove. Two terms, measured along the **same upwind ray the fetch profile
already casts** from `fetchOrigin`, so everything is about one point and one direction:

1. **Terrain — the upwind horizon angle (TOPEX).** From the fetch origin, walk upwind along the
   sector bearing: across the water to the shore (the fetch distance, already known), then inland to
   ~5 km, sampling the DEM every ~30 m. The terrain term is the **maximum elevation angle** seen
   from the origin, `θ = max atan((z_i − z_origin) / d_i)`. Willoughby's ridges, which block its
   E/NE quadrant in the measured rose, are exactly what this sees. TOPEX (topographic exposure) is a
   standard forestry / wind-throw metric with decades of literature; the only novelty is casting it
   from a point on the water.
2. **Canopy — an effective windbreak.** Mean NLCD tree-canopy cover (%) over the first ~300 m
   inland along the ray (±50 m lateral kernel), turned into an effective obstacle height `h = 20 m ×
   cover`. Classic windbreak behavior: wind speed is reduced ~30–50% out to ~10 h downwind, tapering
   to nothing by ~25 h. So the canopy shelter felt *at the origin* depends on the fetch distance in
   tree-heights — a 300 m cove whose origin sits ~150 m (≈7 h) off its pines is strongly sheltered,
   and Champlain's broad lake, 7 km from any shore, is not. **No special-casing: fetch and canopy
   interact through the geometry.**

`exposure = (1 − f_terrain(θ)) × (1 − f_canopy(fetch / h))`, both monotone, both documented in the
core module with the source of each curve. First-cut shapes: `f_terrain = clamp(θ / 15°, 0, 1)`
(a 15° horizon is substantial lee for a body within ~10× the obstacle height);
`f_canopy = 0.45 × max(0, 1 − (fetch / h) / 25)`. **Both are priors to be tuned against
observations**, not constants to be trusted — see §Validation.

Stored per row: `shelterExposure: number[16]`, `shelterSource: 'topex_3dep_nlcd'`,
`shelterDemResolutionM`, `shelterCanopyVintage` (e.g. `2021`), `shelterDerivedAt`. Nothing else;
sixteen numbers and provenance, the `windRose` posture.

---

## Data — both free, un-metered, and neither needs downloading whole

| raster | source | resolution | how we read it |
| --- | --- | --- | --- |
| elevation | USGS 3DEP 1/3 arc-second, the same product D104 read through EPQS | **10 m** | range-reads from the USGS COGs on AWS (`s3://prd-tnm/StagedProducts/Elevation/13/TIFF/current/<tile>/USGS_13_<tile>.tif`, public) via GDAL `/vsicurl/` — one window per body, **no 4 GB download**, which retires D104's reason for choosing the point service |
| tree canopy | USFS NLCD Tree Canopy Cover (CONUS), 2021 vintage | 30 m | one clip of the five-state region (~60 MB), kept in `.raw/` with a manifest, the bathymetry archive's discipline |

The N9 scoping said "30 m DEM"; the 10 m product exists for all of CONUS and range-reads make it the
same cost to touch, so the terrain term should use it. The canopy term is 30 m by the source's
nature, and the provenance fields say so.

---

## Cost, priced against a sample rather than estimated

A per-body window of DEM covering the origin ± 5 km at 10 m is ~1M pixels; across 25,000 bodies
that is ~25 GB of raster traffic, which is too much for a single laptop run. So: **10 m for every
sub-area and the top ~2,000 bodies by `displayScore`; 30 m (1 arc-second, `.../Elevation/1/TIFF/`)
for the long tail**, recorded in `shelterDemResolutionM` per row exactly as `elevationResolutionM`
records the D104 split. Compute is minutes to a few hours locally, once, in a new
`scripts/wind-shelter` ETL beside `scripts/wind-climate`, writing through the same `importRuns`
provenance path and a `waterBodies.setWindShelter` / `subAreas.setWindShelter` internal mutation.

**Price it on 20 lakes first** (Willoughby, Malletts Bay, a 12-acre Vermont pond, a Winnipesaukee
cove, a Moosehead bay, a flat-country reservoir…) and record the numbers in this doc before running
the corpus — the plan's own rule from N9.

---

## Consumers

- **`mostExposedSector`** (core) becomes `frequency × fetch × exposure`; today's two-term product
  stays as the fallback when no shelter row exists, so an un-run body renders byte-identically.
- **`WindExposure`** (both clients) gains a second, dashed ring, captioned *"Shelter modeled from
  terrain and tree cover (3DEP 10 m, NLCD 2021)."* The caption N9 puts on every rose — *the wind
  climate is the 2 km cell's* — stays; this does not remove that caveat, it narrows it.
- The heatmap, below.

Never a safety claim: no copy ever says a sheltered sector is *safe*, only that it is *sheltered*.

---

## The heatmap — "which of these three lakes will be harshest tomorrow morning?"

Founder, 2026-09-16: *"Could we show a skater, based on today's weather forecast, where they will
be most sheltered from the wind on a given body? Some sort of wind heatmap kind of thing so they
could compare how harsh three different lakes in their area will be tomorrow morning."*

Two products fall out of the index, and they differ in how much new machinery they need:

### 1. A per-lake "harshness" number for a forecast hour — cheap, and comparable across lakes

For a chosen hour (tomorrow 8 am), the forecast gives a wind **from**-direction and speed at the
lake's browse cell (`weatherForecastCache`, already fetched and already bay-resolved since N6h).
Look up the sector, and `harshness = speed × exposure[sector] × g(fetch[sector])` — the same three
numbers `mostExposedSector` multiplies, with today's wind in place of the climatological frequency.
That is a **per-body scalar per forecast hour**, computed at render from data both clients already
hold, so a *"compare three lakes"* view is a sort. It is also the first honest input to the *"is it
worth driving"* question that is about the skater's comfort rather than the ice.

**Copy discipline:** *"likely exposed / sheltered"*, never a wind speed on the ice — the model is a
sector average at one point, and the forecast is a 3 km cell.

### 2. A within-lake sheltered-vs-exposed map for that hour — needs a per-point index

The index above is one point per body (the fetch origin). A heatmap *across* a lake — *the north
shore will be rough, the lee of the point will be glass* — needs the same two terms evaluated at
many points, which is a raster job: sample the water polygon on a grid (say 100 m for a giant, 25 m
for a pond), compute fetch + terrain + canopy per sample per sector, store one sector array per
sample. That is `16 × samples` numbers per body — Champlain at 100 m is ~120k samples — so it is a
**tile, not a row**: build offline like the contour layer, stamp with `waterBodyKey` /
`subAreaKey`, serve as a raster-DEM or vector-tile source per sector, and let the client pick the
sector from the forecast hour and shade. The "compare tomorrow morning" view then reads as a small
multiple: three lakes, each shaded for the same hour.

Sequence **1 before 2**: the scalar version validates the index on real winters for nearly nothing,
and the tile version is a rendering phase in its own right (N6b-shaped: build, tile, R2, coverage
table, reveal gate). Neither is scoped further here.

---

## Validation — before anything ships

1. **Local knowledge**, on the 20-lake pricing sample: does the sheltered quadrant match where
   people actually set up?
2. **The rose itself**: Willoughby's terrain-blocked E/NE should show low exposure there; a
   flat-country reservoir should show ~1 everywhere but its treeline.
3. **The station-bias study** in `next-gen-weather-stations.md`: where a station sits near a bay,
   the model-vs-observed wind bias by sector is the one *measured* quantity that can tune
   `f_terrain` / `f_canopy` rather than leaving them as priors.
4. **A property test**: exposure is monotone in horizon angle and in canopy cover, and a body with no
   shelter row renders exactly as today (the D2 "never a penalty" shape).

---

## Open questions

- Should the canopy term use NLCD's **canopy height** product (LiDAR-derived, 2021, 10 m, partial
  coverage) where it exists, instead of assuming 20 m × cover? Better where available; two sources
  means two provenance values, which the fields already allow.
- Deciduous vs. conifer: a bare hardwood shore shelters less in January than its summer canopy
  cover implies. NLCD land cover distinguishes the two; a winter multiplier on the deciduous
  fraction is a one-line refinement once there is data to set it.
- Whether the per-point tile (heatmap 2) should be a phase of its own or ride the satellite-imagery
  pipeline's Fly granule box, which already knows how to bake and publish per-body rasters.

## Related

[`phase-N9-subareas-as-places.md`](./phase-N9-subareas-as-places.md) ·
[`next-gen-weather-stations.md`](./next-gen-weather-stations.md) ·
[`phase-N6c-expanded-lake-profiles.md`](./phase-N6c-expanded-lake-profiles.md) (fetch, D85/D90) ·
[`phase-N6h-weather-detail.md`](./phase-N6h-weather-detail.md) (D152, the browse-cell forecast) ·
[`01-decisions.md`](./01-decisions.md) (D82, D104)
