# N6b — The bathymetry layer: real isobaths inside the lake

*A toggleable underwater-contour layer, drawn from state-agency surveys. Designed, not built.*

> **Status: 📋 Designed at N6a's kickoff (2026-07-29), deliberately not built.** Split out of the
> register's single **N6** entry when the founder asked whether we could draw topographic lines inside
> the lake bodies. The answer is **yes, from measured state-agency data, and emphatically not from the
> global modelled sources** — which is the finding that made this its own phase rather than a bullet in
> [N6a](./phase-N6a-lake-depth.md). Storage/serving settled at kickoff: **PMTiles on R2**. Coverage:
> **VT + NH first.** Maine's path is written up in *§Maine* per the founder's explicit ask.

## The ask, and why it isn't a small addition to N6a

> *"Are we going to get enough data to be able to draw topographic lines within the lake bodies? Or is it
> not that granular?"* — founder, 2026-07-29

N6a's depth work is one number per lake. This is a geometry dataset per lake, a new tile pipeline, a new
map layer on two clients, a drawer toggle, tile hosting, and an offline story. It shares exactly one thing
with N6a — the spatial join that resolves an external lake record to our OSM body — and nothing else.
Bundling them would have put an ETL, a safety-math change and a new map layer in one review.

It is also, plausibly, the more valuable of the two. A depth scalar sharpens a decay multiplier a skater
never sees; a bathymetry layer tells them where the ice went out first, where a spring is likely, and why
the reef hole is exactly there. Research §3 notes reef holes form over shallows and
`spring_current` hazards cluster at inlets — a contour layer is the context that makes those hazards
legible instead of arbitrary.

---

## The load-bearing negative finding: not from GLOBathy

**GLOBathy distributes 1,427,688 per-lake bathymetry rasters, and we must not draw contours from them.**
Its raster method is three steps: rasterize the lake polygon; compute each cell's closest Euclidean
distance to the shoreline (and the maximum such distance); convert distance to depth with a linear
equation. Depth is therefore **a linear function of distance-from-shore**.

Contours derived from that are inward offsets of the outline we already draw. They would be smooth,
concentric, plausible, and carry **zero** information beyond `Dmax` and a polygon already in our
database. Every basin asymmetry a skater would actually use the layer for — the deep side, the shallow
arm, the shelf off the point — is precisely what a distance transform cannot represent.

This is worth recording at length because the mistake is so available: the data is free, global,
already keyed to the lakes we're joining for N6a, and the output *looks like bathymetry*. Drawing it
would be the D3 trap in map form — an authoritative-looking rendering of a guess, on a safety product.
GLOBathy's `Dmax` stays useful as N6a's rung 4. Its rasters are out of scope permanently, not deferred.

*(The same reasoning applies to deriving contours from HydroLAKES `Depth_avg`, which is a single number
per lake and cannot describe a shape at all.)*

---

## Where the real data is

All five states have digitised bathymetry, at varying maturity. Every one of them is a **survey** —
GPS/depth-sounder transects or digitised chart soundings — not a model.

| State | Source | Form | Notes |
| --- | --- | --- | --- |
| **VT** | VT ANR (compiled Aug 2020) + Lake Champlain from NOAA charts (1:40,000, VCGI updates 2003/2010) | **isobaths, already GeoJSON + PMTiles, CC0** | [`cboone/vermont-lakes-and-ponds-bathymetry`](https://github.com/cboone/vermont-lakes-and-ponds-bathymetry) |
| **NH** | NH GRANIT *NH Bathymetry — Lakes (Lines)*; NHDES surveys since 2000 + NH Fish & Game; updated Feb 2024 | contour lines, depth in feet | also a Polygons layer (contour-interval areas) |
| **MA** | MassGIS *MassWildlife Inland Water Bathymetry*, 1:10,000, GPS/depth-sounder | contour lines + depth raster | shapefile + TIFF in one zip |
| **NY** | NYSDEC Lake Contours, NYS GIS Clearinghouse | contours | maturity/format needs a look; much of DEC's fishing-map corpus is PDF |
| **ME** | Maine GeoLibrary *Lake Depths* | **sounding points, not contours** | IFW lake survey maps are PDFs — see *§Maine* |

**The Vermont find is the striking one.** Someone has already run this exact pipeline — isobaths for
every Vermont lake with available bathymetric data, published as GeoJSON *and* PMTiles under CC0 — and
the repo says it was built for the **"Catamount Hardware Ice Atlas."** A skating map, in our pilot state,
in the public domain, in the tile format we already serve our basemap in. VT is therefore very nearly a
configuration change rather than a pipeline.

Coverage everywhere is "lakes that have been surveyed", which the VT repo is careful to call *"a small
fraction"* of the state's lakes and ponds. That is the same bias N6a documents and the same consolation:
the surveyed lakes are overwhelmingly the ones people use.

**One real trap, flagged by the VT repo:** Champlain's depths are referenced to **NGVD 1929** while VT
ANR's are referenced to **pool elevation at time of collection**. They do not share a vertical datum, so
depths from different sources are not directly comparable and must not be silently unioned into one
styled-by-depth layer. Each state's set carries its own datum, and the styling reads depth-below-surface,
never an absolute elevation.

---

## Settled at kickoff

**PMTiles on R2** (founder call). A vector-tile overlay alongside the basemap `.pmtiles` that Phase 2.5
already builds, uploads (`scripts/basemap/upload-r2.sh`) and both clients already read. Statewide contour
sets are large and dense — a per-body Convex copy would be shopping for the D48 8192-element array cap and
paying viewport read cost for geometry that is pure decoration until someone opens a lake.

The consequences to accept with that choice, rather than discover later:

- **Not queryable per body.** The layer is styled and filtered client-side by zoom and by the selected
  body's bbox; nothing joins contours to a `waterBodyId` in a query. Acceptable — there is no feature that
  needs to *read* a contour, only to draw it.
- **Offline rides on the deferred Layer-3 tile-pack.** The `file://` pmtiles path was built flag-off in
  Phase 9.5 and needs exactly one on-device confirmation; a bathymetry overlay is a second consumer of
  that same unblocking, not a new problem. Online-only in v1, stated in the UI.
- **A second tile artifact to rebuild** when a state republishes. The basemap runbook
  (`plans/phase-2.5-regional-expansion.md`) is the template; this adds one more `tippecanoe` → R2 lane.

**VT + NH first**, then MA and NY, with ME deferred (below). Two states prove the whole chain — fetch,
reproject, join, tile, upload, render, toggle — and mirrors how Phase 1 piloted Vermont before 2.5 went
multi-state. VT is nearly free; NH is a clean contour-lines download from a portal that publishes
GeoJSON.

---

## Maine

*Written up here at the founder's request, so the work is known rather than rediscovered.*

Maine is the one state in our set that publishes **soundings, not contours**. Maine GeoLibrary's *Lake
Depths* layer is a point dataset — each point a measured depth at a location, with surface elevation —
consolidated from several sources; Maine IF&W's ~1,900 lake survey maps exist as **PDFs**, which is a
digitisation project, not an ETL.

So contours for Maine mean **we** would be interpolating, and that changes what we'd be drawing: not
"the state surveyed this lake and here are its isobaths" but "here is our surface fitted through the
state's soundings." That is a weaker claim than every other state's, and it is the reason Maine is
deferred rather than included — but it is a *much* stronger claim than GLOBathy's distance transform,
because it is constrained by real measurements inside the basin instead of only by the outline.

**The proposed process, when we come back to it:**

1. **Fetch** the Maine GeoLibrary *Lake Depths* point layer; inspect the vertical reference (surface
   elevation is carried per point, so depth-below-surface has to be derived consistently) and the
   per-lake point density.
2. **Gate on density, per lake, before interpolating anything.** A lake with a dozen scattered soundings
   cannot support isobaths and must be left blank; a lake with dense transects can. The gate is the whole
   integrity of this path — it is what stops the layer from silently degrading into "smooth surface
   through three points" on the lakes with the least data. Pick the threshold from the real distribution
   (candidate: minimum point count *and* a maximum nearest-neighbour gap relative to lake extent), and
   **log every lake dropped**, per the register's own no-silent-caps rule.
3. **Interpolate** per lake, clipped to our polygon, with the shoreline as a depth-0 boundary
   constraint — that constraint is what keeps the fit from running deep at the shore, and it is the one
   place the distance-transform intuition is legitimately useful. Natural-neighbour or TIN-based
   interpolation over kriging: fewer knobs, no variogram to defend.
4. **Contour** the fitted surface (`gdal_contour`) at the same interval as the other states, and tile it
   into the same PMTiles set.
5. **Label the provenance differently in the UI.** Maine contours are *interpolated from state
   soundings*; every other state's are *state-surveyed*. Same layer, different caption. If that
   distinction can't be made honestly in the UI, the interpolation shouldn't ship — which is the check
   worth applying before any of steps 1–4.

**Alternative worth pricing first:** render Maine's **soundings as points** and skip contours entirely.
Far less work, nothing invented, and arguably as useful — a scatter of "18 ft here, 40 ft there" is
directly readable and makes no claim about the shape between the points. This may simply be the right
answer for Maine rather than a fallback.

---

## Open questions

1. **Contour interval and simplification.** The states publish at different intervals and different
   units (NH and MA in **feet**). Do we retile to a common interval, or carry each source's native
   interval and label it? Leaning native-with-labels — resampling a survey's contours is inventing
   intermediate lines.
2. **Zoom cutoffs and how the layer interacts with D49.** Contours are meaningless above a certain zoom
   out and would fight `minVisibleZoom`/`displayScore` prominence. Likely a hard minimum zoom plus
   on-only-for-the-selected-body, which also answers "does this clutter the browse map" (it doesn't,
   because it isn't on).
3. **Whether the toggle is per-session or a persisted preference**, and whether it lives with the
   deferred **satellite imagery layer** toggle — these are siblings, and the register lists satellite
   imagery as *"needs design before it's buildable."* One layer-toggle affordance for both is probably the
   right shape, and would mean designing them together.
4. **The copy, which is a D3 problem and the hardest part.** Bathymetry is not ice thickness, and the
   naïve reading ("shallow = safer") is **season-dependent and reverses**: shallow water takes first ice,
   and shallow water rots out first. A layer that shows depth next to hazards must not let a skater
   conclude anything about skateability from depth alone. Needs the same care D52's decay copy got, and it
   is the reason this phase is not "just" a map layer.
5. **Attribution.** Four or five state agencies plus NOAA plus (for VT) a CC0 derivative work. Where it
   renders and how it stays visible at the same standard as OSM/ODbL and Open-Meteo.
6. **NY's actual maturity.** DEC lake contours exist on the NYS GIS Clearinghouse, but much of DEC's
   contour-map corpus is PDF fishing maps. Whether NY behaves like NH (clean vector download) or like ME
   (a digitisation project) needs one afternoon of looking before it's sequenced.
