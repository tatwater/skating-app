# N6b — The bathymetry layer: real isobaths inside the lake

*An underwater-contour layer inside an open lake's drawer, drawn from state-agency surveys.*

> **Status: 🔨 IN BUILD (2026-08-01). The ETL is complete end to end; neither client renders it yet.**
>
> | | |
> | --- | --- |
> | **Archived** | ✅ five sources, 298 MB, mirrored to a private R2 bucket, `PROVENANCE.md` committed |
> | **Normalized** | ✅ two lanes — the agency's isobaths, or our surface fitted through its soundings |
> | **Joined** | ✅ **2,437 of 2,491 lakes (98%)**, including Vermont for the first time |
> | **Gated** | ✅ coverage gap + data support. **No output-side gate** — five were tried and falsified (below) |
> | **Interpolated + contoured** | ✅ **2,044 lakes → 49,767 lines**, all five agencies, Champlain included |
> | **Tiled** | ✅ **15 MB** `.pmtiles`, z9–z14, 10,753 tiles, on the Phase 2.5 upload lane |
> | **Web client** | ⬜ **not built** — shared layer logic and palette exist, `MapView` is unwired |
> | **Mobile client** | ⬜ **not built** |
> | **Drawer credit row** | ⬜ **not built** — the copy is written and tested, nothing renders it |
> | **Rung-1 depth write** | ⏸ correctly gated behind [N6a](./phase-N6a-lake-depth.md)'s ordering gate |
>
> **What is genuinely left is the render half**, and it is a real chunk rather than cleanup: adding a
> lazily-mounted source to two `MapView`s, filtering it to the open body, fading it in, keeping it
> under hazards, and rendering one credit line at the bottom of the drawer. Everything it needs is
> built and tested — `@skating/core/contourLayer`, the per-app palettes, the env vars, the tiles.
>
> **We ship with no output-side quality gate**, deliberately — five were tried and every one was
> falsified by a render. See *§The gate that measured the wrong thing*. That is only tolerable because
> D82 means a contour makes no claim a skater can act on wrongly.
>
> 📖 **The narrative version, written for a reader with no mapping background, is
> [`docs/bathymetry-challenges.md`](../docs/bathymetry-challenges.md)** — every interpolator and every
> gate we tried, what each one drew, and why it was abandoned. Read that before changing a threshold.
>
> **Originally: 📋 Designed at N6a's kickoff (2026-07-29), deliberately not built.** Split out of the
> register's single **N6** entry when the founder asked whether we could draw topographic lines inside
> the lake bodies. The answer is **yes, from measured state-agency data, and emphatically not from the
> global modelled sources** — the finding that made this its own phase rather than a bullet in
> [N6a](./phase-N6a-lake-depth.md). Storage/serving settled at kickoff: **PMTiles on R2**.
> **All six open questions were answered 2026-07-31** — see *§Settled by the founder*. The largest
> consequence: **there is no contour toggle.** Contours are a property of the detail view, and the map's
> only layer switch is satellite, which now has its own phase — [N6e](./phase-N6e-satellite-imagery.md).
> Decisions: **D81** (one toggle), **D82** (context, not counsel), **D83** (native intervals),
> **D89** (the fixed 5 ft ladder).

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

> ⚠️ **This section was written from portal descriptions and is wrong in four places.** Every source
> below was checked against the live service on 2026-07-31 and the corrected table is in
> *§What the build found in the plan*, with the machine-readable version in
> `scripts/bathymetry/src/sources.ts`. The original is kept because the *reasoning* it supports —
> survey-not-model, the datum trap, the coverage caveat — survives the corrections intact, and because
> the shape of the error is itself worth not repeating: **every one of these rows was plausible.**

All five states have digitised bathymetry, at varying maturity. Every one of them is a **survey** —
GPS/depth-sounder transects or digitised chart soundings — not a model.

| State | Source | Form | Notes |
| --- | --- | --- | --- |
| **VT** | VT ANR (compiled Aug 2020) + Lake Champlain from NOAA charts (1:40,000, VCGI updates 2003/2010) | ~~isobaths, published via VCGI / ANR~~ **→ sounding points** | prior art worth reading before building: [`cboone/vermont-lakes-and-ponds-bathymetry`](https://github.com/cboone/vermont-lakes-and-ponds-bathymetry) (CC0) |
| **NH** | NH GRANIT *NH Bathymetry — Lakes (Lines)*; NHDES surveys since 2000 + NH Fish & Game; updated Feb 2024 | contour lines, depth in feet ✅ | also a Polygons layer (contour-interval areas) |
| **MA** | MassGIS *MassWildlife Inland Water Bathymetry*, 1:10,000, GPS/depth-sounder | contour lines ✅ (+ a depth raster we don't need) | ~~shapefile + TIFF in one zip~~ **→ a live FeatureServer** |
| **NY** | NYSDEC Lake Contours, NYS GIS Clearinghouse | ~~contours~~ **→ no statewide dataset exists** | maturity/format needs a look; much of DEC's fishing-map corpus is PDF |
| **ME** | Maine GeoLibrary *Lake Depths* | **sounding points, not contours** ✅ | ~~IFW lake survey maps are PDFs~~ **→ the state already digitised them** |

**Vermont has usable prior art, and we build our own anyway.** An open-source project
([`cboone/vermont-lakes-and-ponds-bathymetry`](https://github.com/cboone/vermont-lakes-and-ponds-bathymetry),
CC0) has already run this exact chain on VT ANR's data — isobaths for every Vermont lake with available
bathymetry, published as GeoJSON *and* PMTiles. It is worth reading before we start: it proves the source
data is tractable, and its README is where two of this doc's findings come from (the datum trap below, and
the honest framing of coverage).

**But we run VT through our own pipeline like every other state** (decided 2026-07-30). Taking the
prebuilt tiles would save exactly one lane of a pipeline we are building anyway for NH, MA and NY — and it
would cost more than it saves:

- **One state's overlay would carry someone else's tiling parameters** — simplification, zoom ranges,
  layer naming — while the other four carry ours. That is a rendering seam at a state border, and the kind
  whose cause nobody remembers a year later.
- **It is a standing dependency on a third-party repo** staying up and staying current with ANR's
  republications, for a safety-adjacent layer.
- **The saving is small.** VT's source is a clean download; the marginal cost over reusing the artifact is
  one run of a lane the runbook already describes.

So VT is *cheap*, not *free* — and it is cheap for the same reason NH is: the state publishes clean
contour data.

Coverage everywhere is "lakes that have been surveyed", which the VT prior-art repo is careful to call
*"a small fraction"* of the state's lakes and ponds. That is the same bias N6a documents and the same
consolation: the surveyed lakes are overwhelmingly the ones people use.

**One real trap, and we owe it to that repo's README for flagging it:** Champlain's depths are referenced to **NGVD 1929** while VT
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
multi-state. Both are clean contour-line downloads from portals that publish GeoJSON, which is what makes
them the right pair to prove the chain on: **the pipeline gets exercised end-to-end on the easy data
first**, before MA's shapefile-plus-TIFF zip and NY's uneven formats test it. *(Reusing VT's prebuilt
third-party tiles would have skipped that proof on one of the two pilot states — a second reason the
build-it-ourselves call above is the right one.)*

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

## New York

*Written up at the founder's request (2026-07-31), on the same principle as §Maine: the work should be
**known** rather than rediscovered. Unlike Maine, this one is not a lane we are deferring — it is a lane
that does not exist, and the write-up is a costing so that a future decision to fund it is made with
open eyes.*

### What we established, and how

New York is the only state in our set with **no digital lake bathymetry of any kind**. That is a
checked finding rather than an assumption, and the search is recorded so nobody repeats it:

| Where we looked | What is there |
| --- | --- |
| **NYSDEC's public ArcGIS server** — every folder, every service, every layer, enumerated programmatically | Exactly two depth layers, both **Hudson River estuary** |
| **NYS GIS Clearinghouse** (`data.gis.ny.gov`), full DCAT catalogue — 385 datasets | A *topographic* contour download app (land), one Seneca Lake document. No lake bathymetry |
| **ArcGIS Online**, org- and keyword-scoped searches | Nothing from NYSDEC or any NY state agency |
| **`data.ny.gov`** open-data portal | Nothing |
| Regional candidates (Adirondack Park Agency, Finger Lakes, Lake George) | One item: *"Bathymetry of the Finger Lakes"* — **50 unattributed depth-band polygons** for eleven lakes, no published copyright, no traceable agency |

**That last one is a trap, not a source.** Fifty polygons across eleven lakes is four or five depth
bands each, of unknown provenance, unknown vintage and unknown method. Drawing it would be rendering an
authoritative-looking artifact whose accuracy we cannot speak to — the same thing this document's
opening section refuses GLOBathy's rasters for, arriving by a different road. **Declined on the same
grounds.**

### New York is not blank

Worth stating plainly, because it is easy to lose and easy for someone to "fix" later: **the VCGI/NOAA
Champlain source covers the lake, not the state.** Its 104,910 soundings span the entire New York shore.
So New York's most prominent skating water is covered — by a source filed under Vermont. That is an
accident of filing that happens to be correct, and it means the pipeline does run end-to-end for NY.

### The digitisation path, costed

NYSDEC has historically published lake contour maps as **PDFs** — the fishing-map corpus this doc's
source table gestured at. They are the only NY bathymetry that exists, and turning them into a layer is
a project rather than an ETL lane.

**Step 0 is establishing the inventory, and it is not free.** DEC restructured its website (the old
`dec.ny.gov/outdoor/…` paths now 404 and the maps are not surfaced at any stable path we could find), so
*"how many maps are there, and where do they live"* is itself unanswered. Historically this corpus has
been in the low hundreds of waters. **Nobody should plan against that number until it has been
counted** — and the counting is a scrape plus a manual pass, not a query.

**Then, per map, in order of increasing pain:**

1. **Georeference.** A scanned contour map has no coordinate system. Each one needs control points tied
   to identifiable shoreline features, then a warp. This is the step that does not automate: the maps
   are hand-drawn at inconsistent scales, often without a graticule, and often with the shoreline itself
   as the only registration feature available.
2. **Vectorise.** Raster-to-vector on the contour strokes. Tolerable when the linework is clean; the
   labels, depth soundings, hachures and boat-launch symbols printed *on top of* the contours are what
   makes it not tolerable, since they break lines and add false ones.
3. **Attribute.** Every extracted line needs its depth, which is read off a printed label. This is
   manual, and it is the step where an error is invisible downstream — a contour attributed 20 ft
   instead of 30 ft is geometrically perfect and simply wrong.
4. **Join + QA.** Match each map to our `waterBodies` row, then check the result against the map by eye.

**The honest estimate is that this is larger than the rest of N6b combined**, and its output would carry
a **third** provenance tier, weaker than either lane we have:

| Tier | Claim | States |
| --- | --- | --- |
| **State-surveyed** | The agency surveyed the lake and published isobaths. We reproject and tile. | NH, MA |
| **Interpolated from state soundings** | The agency measured depths; **we** fit the surface. | VT, ME |
| **Traced from a scanned agency map** | The agency drew a map; **we** georeferenced, vectorised and attributed it. Every step is ours and each is lossy. | *(NY, hypothetically)* |

### The recommendation

**Don't.** Not now, and probably not as a project of its own — the cost is concentrated in manual work
that produces our weakest claim, on the state where we already cover the marquee water.

**Two cheaper things to do first, in this order:**

1. **Re-check periodically.** New York is the largest state in our region without a bathymetry program,
   which makes it a plausible thing for NYSDEC to eventually publish. `verify` already establishes the
   habit of checking sources; NY costs one probe.
2. **Let the operator override carry the specific lakes.** N6a's rung-1 `operator` depth and the D68
   amendment's public source note already let a moderator enter *"NYSDEC contour map, 1994"* for a
   named lake. For the handful of NY waters people actually skate, that is a few minutes each and it
   produces a **stronger** claim than tracing would — a human reading a number off an official map and
   citing it, rather than an algorithm inferring geometry from a scan.

**If it is ever funded**, do it as a bounded pilot: georeference and vectorise **five** lakes, measure
the real per-map hours, and check the output against a known depth before committing to the corpus. The
pilot is what turns "low hundreds of maps" from a guess into a schedule.

---

## Settled by the founder (2026-07-31)

All six questions answered in one pass. Three became decisions; the other three became build constraints.

### 1 — Native intervals and native units, labelled (D83)

> *"The ideal would be common units, but I agree that we shouldn't invent lines that we don't have true
> data for. Let's use the units we're given and we can come back to this in the future."*

**Carry each source's native interval and unit; never resample.** NH and MA publish in **feet**, VT in
metres, and retiling to a common interval would mean interpolating isobaths that nobody surveyed — a line
drawn where no depth-sounder went, rendered identically to one that was measured. That is the GLOBathy
mistake at a smaller scale, and this document exists because we refused it once already.

**What that costs, stated so it isn't a surprise:** a skater crossing a state line sees the contour
spacing change. That is honest — the surveys *are* different — but it needs the label to be legible, not
a footnote. The interval and unit belong in the same drawer line as the source agency: *"NH GRANIT, 10 ft
contours."*

**One thing we do normalize, and it is not the interval:** the **vertical datum problem** from *§Where the
real data is* stands regardless. Champlain (NGVD 1929) and VT ANR (pool elevation at collection) do not
share a reference, so the styling reads **depth-below-surface** and never an absolute elevation, and
depths from different sources are never silently unioned into one styled-by-depth ramp. Native intervals
make that rule easier to hold, not harder: each set already renders as its own labelled thing.

**The revisit is real, and it has a trigger:** if we ever ship a cross-state comparison surface — "the
deepest lakes within 90 minutes" — that surface needs common units, and it should convert *at read time*
from stored native values rather than by retiling. The tiles stay native permanently.

### 2 + 3 — Contours live in the detail view, and there is no contour toggle (D81)

> *"I actually think we should only show contours in the detail view, when the drawer is open for a given
> water body. Otherwise it should just be a flat shape."*
> *"I actually don't want the contour lines to be manually toggleable! I want them always visible when the
> water body detail is open, unless the satellite imagery is turned on."*

These two answers combine into one rule, and it is a better rule than the toggle this doc proposed:

> **D81 — Contours are a property of the detail view, not a layer the user manages.**
> When a body's drawer is open, its contours are drawn. When it isn't, they aren't. The map has exactly
> **one** layer switch, and it is satellite.

**Why this is a simplification and not just a preference.** Question 2 as written asked about zoom cutoffs
and D49 prominence — how do we keep contours from cluttering the browse map and fighting `displayScore`?
Under D81 that question **stops existing**. Contours are never on the browse map, so there is nothing to
clutter and nothing to fight. A hard minimum zoom is still worth keeping as a floor (a drawer can be open
while the camera is zoomed out), but it is a guard rail rather than the mechanism.

**And it removes a state we would have had to persist.** No per-session-vs-persisted preference question
(the old Q3), no settings row, no divergence between web and mobile about what's remembered. The layer's
visibility is derived from something the app already knows: which body is selected.

**Interaction with satellite.** Satellite replaces the base map wholesale — see D81's second half in
[N6e](./phase-N6e-satellite-imagery.md) — so with imagery on there is no cartographic base for contours to
annotate, and drawing them over a photograph would fight it for legibility. Hazards and skate paths stay
in both modes; contours are base-map furniture and go with the base map.

| Detail view | Satellite off | Satellite on |
|---|---|---|
| Base map | vector basemap | Sentinel-2 / aerial imagery |
| **Contours** | **drawn** | **not drawn** |
| Hazards | drawn | drawn |
| Skate paths | drawn | drawn |

**Two build consequences worth naming now:**
- **Contours must load lazily.** They're only ever needed for one body at a time, so the PMTiles source
  can be added to the style on drawer-open rather than at map init. That keeps the browse map's tile
  budget exactly where it is today.
- **The drawer-open/drawer-closed transition is the whole UX.** Fading in on open reads as a detail
  revealing itself; popping in reads as a bug. This is a small thing that is entirely the feature.

### 4 — Bathymetry is context, not counsel (D82)

> *"I think it's okay to show the hazard areas over the topographic lines, the lines are more for the
> aesthetic. We'll use depth info for our own seasonal calculations, but we don't have to tell the users
> anything about the safety or lack thereof with any copy."*

This is the sharpest answer of the six, and it dissolves what this doc called *"the hardest part."*

The old Q4 framed the copy as a problem to solve: bathymetry isn't ice thickness, "shallow = safer"
reverses across the season, so what do we *say*? The founder's answer is **we say nothing**, and that is
strictly safer than any careful phrasing:

> **D82 — Depth's safety role stays inside the math. The contour layer makes no safety claim, because it
> makes no claim at all.**
> Depth feeds the D56/D69 decay multiplier, where it adjusts how fast a hazard's confidence fades. That
> is a computation the skater never reads. The rendered contours are **context** — the shape of the
> basin, why the reef hole is where it is, where the deep side is — and carry no interpretive copy.

**Why saying nothing beats saying it carefully.** Any sentence we write about depth and ice is a sentence
a skater can act on, and D3 says prediction isn't ours to make. There is no phrasing of *"shallow water
takes first ice and rots out first"* that doesn't function as advice in the moment someone is deciding
whether to drive. The line we can hold absolutely is the one with no copy behind it.

**Z-order follows directly:** hazards render **above** contours. Contours are decoration; hazards are the
product. If they ever compete for legibility, the contour loses — reduced opacity, thinner stroke, muted
against the hazard palette rather than sharing it. **The contour palette must not resemble the hazard
palette**, which is the one styling rule that carries real weight here: a blue-to-navy depth ramp that a
skater could mistake for a severity scale would reintroduce, through colour, exactly the claim we just
declined to make in words.

*(The single line of copy that does remain is provenance, not interpretation: which agency surveyed this
and at what interval — Q1 above and Q5 below.)*

### 5 — Attribution: the minimum is smaller than it looks, and it belongs in the drawer

> *"We should figure out what the minimum viable credit is needed, and how far away we can put it."*

The useful finding is that **two different obligations were being conflated**, and only one of them has
anything to say about placement:

| | Requirement | Where it must render |
|---|---|---|
| **Basemap (OSM / ODbL)** | Attribution required, and OSM's own guidance expects it **on or adjacent to the map** | The MapLibre attribution control — **already built, unchanged** |
| **State-agency contours** | A credit line under each agency's open-data terms | **No placement rule.** Nothing requires it on the map surface |
| **VT prior-art repo (CC0)** | **None.** CC0 waives attribution | Nowhere — though we'd credit it anyway if we used it, and per *§Where the real data is* we don't |

So the answer to *"how far away can we put it"* is: **the bottom of the lake drawer, and that is not a
compromise** — it is where the credit is most useful anyway, sitting with the depth provenance caption
N6a already renders and the Open-Meteo credit the weather strip already carries. A skater looking for
where a number came from looks in one place.

**The minimum viable credit** is one line naming the agencies whose data is actually drawn for *this*
body — not a standing list of all five states — plus a link to the source page. Because contours are
detail-view-only (D81), we always know which state's tiles are on screen, so the credit is naturally
scoped rather than a permanent lowest-common-denominator string.

**Confirm at build:** each state portal's exact required wording (VCGI/VT ANR, NH GRANIT, MassGIS,
NYSDEC, NOAA for Champlain). These are ordinary open-data terms and none of them is expected to be
onerous, but the wording is theirs to specify, not ours to paraphrase. NOAA chart-derived data in
particular usually carries a *"not for navigation"* class of notice, which is worth reading properly
before it renders next to anything on a safety product.

### 6 — Accuracy: do all we can, and let the gates do the work

> *"All right, hoping for the best here! Let's do all we can to be as accurate as possible."*

Taken as a mandate for the checks rather than a wish. Concretely, three already-specified gates get
treated as **requirements rather than nice-to-haves**:

1. **The vertical-datum rule** (*§Where the real data is*) — never union sources into one depth ramp.
2. **Maine's density gate** (*§Maine*, step 2) — a lake with too few soundings gets **no contours**, and
   every dropped lake is logged. Under D82 this is easier to hold than it looks: since contours make no
   claim, a blank lake costs the skater nothing, so the gate can be set conservatively without a
   product argument against it.
3. **Provenance labelling** (Q1, Q5) — state-surveyed vs interpolated-from-soundings never render as the
   same thing.

**And one honest limit that no amount of care removes:** coverage is *"lakes that have been surveyed,"*
which the VT prior-art repo calls a small fraction of the state's water bodies. Most bodies will have no
contours. Under D81 that is nearly invisible — the drawer simply shows a flat shape, exactly as it does
today — which is the third time this page's simplifications have paid off. A layer that is off by default
and unlabelled when absent has no coverage embarrassment to manage.

### Still genuinely open

~~**NY's actual maturity.**~~ → **Answered 2026-07-31, and the answer is "neither."** See
*§What the build found in the plan* §5. NY behaves like neither NH nor ME: there is no statewide lake
bathymetry dataset in any form, vector or digitised-point. The afternoon of looking happened.

---

## The interpolation — where it ended up, and what's still open

*Written 2026-08-01, at the point the founder called a pause. The sounding lanes (VT, ME) need us to
fit a surface, and that surface turned out to be the hardest thing in this phase by a wide margin —
five distinct mechanisms, four of which failed visibly. This section is the record, because every
failure here was **invisible in code review and obvious on a render**, and the next person will
otherwise re-derive them in the same order.*

### The chain as it now stands

| Stage | Tool | Why |
| --- | --- | --- |
| Decimate | `gmt blockmedian` | One value per grid cell. The median resists a bad reading; a sonar log has thousands of points per cell. |
| Constrain | shoreline at depth 0 | §Maine step 3. **The load-bearing step** — without it contours never close and nothing nests. Sampled against a budget tied to the *sounding* count (`shoreSpacingFor`), so the outline cannot outvote the survey — see §*Rebuilt against the charts*. |
| Solve | `gmt surface`, `-T0.25`, `-Ll0 -Lu<max>` | Tensioned spline. The clamps stop it inventing a hole deeper than anything sounded. |
| Anisotropy | compress along-axis for the solve, `grdedit` back to real metres | Connects a trough the isotropic fit was splitting. Capped by each lake's own elongation. |
| Smooth | `gmt grdfilter -Fg`, 3 cells | Removes the raster tracing stair-step. Narrower than the sounding spacing, so it cannot erase a surveyed feature. |
| Mask | `surface -M`, at the density gate's ratio | Refuses to draw water further from a reading than the gate allows. |
| Contour | `gdal_contour` on the fixed 5 ft ladder | **D89.** Steps coarser (10, 25, 50 ft) for depth or thin data, never finer, so ring count reads as depth. |
| Clip | `ogr2ogr -clipsrc` against our polygon | A mask is circular; a lake is not. |

**The tunable knobs**, as exported constants — read them from the source, which carries the reasoning
for each: `THALWEG_ANISOTROPY` (4, capped per lake) · `MAX_GAP_RATIO` (0.22) · `MIN_SOUNDINGS` (12) ·
`TENSION` (0.25) · `SMOOTH_CELLS` (3) · `TARGET_CELL_M` (25, clamped 300–1200 cells) ·
`MIN_SHORE_POINTS` (120) · `BASE_INTERVAL_FT` (5) · `MIN_SAMPLES_PER_BAND` (5) · `MAX_BANDS` (20).
**Exactly one takes an env override** — `THALWEG_RATIO`, for the anisotropy sweep that produced the
table below. The rest are edit-and-rerun, which is the honest interface for a chain whose every
setting was chosen by looking at a render.

*(`MAX_GAP_RATIO` reads **0.22**, not the 0.12 this section first recorded. Both numbers gate the same
lakes: the fairness fix renormalised the gap by `sqrt(area)` instead of the bbox diagonal, which runs
1.82× smaller, so the old threshold silently tightened from 271 dropped lakes to 1,224. Re-deriving
it against the new denominator restored the keep-rate. The lesson is in `density.ts` and worth
lifting: **a threshold is calibrated against its denominator, and changing one without re-deriving
the other is a silent retune wearing the clothes of a bug fix.**)*

*(**`MAX_SHORE_SHARE` is not in this list because it does not exist.** It was added and removed on the
same day; shore share is computed and printed on every sample card but gates nothing — §*The gate that
measured the wrong thing*. `TARGET_CONTOUR_COUNT` (12) was retired outright by D89. `GRID_CELLS` (500)
survives as a fallback default in `grid.ts` for callers that don't know a lake's extent, but the
pipeline itself uses `gridCellsFor`: a constant cell count and a constant band count were the same
mistake twice, a per-lake normalisation that ignored how big the lake was and how much of it had been
measured.)*

### What was tried and rejected, in order

Recorded because each looked correct in advance:

1. **Inverse-distance weighting.** An *exact* interpolator: it passes through every sounding, so each
   becomes a local extremum ringed by bullseyes. It also has no edge, so contours ran across dry land
   to the raster corners.
2. **Delaunay TIN (`gdal_grid -a linear`).** Killed the bullseyes and gave a free correct mask, but
   drew the triangulation itself — angular facets and sliver triangles between parallel transects.
3. **Moving average.** GDAL's only smoothing option. It renders its own search radius as overlapping
   circular arcs around every cluster.
4. **GMT `surface` isotropic.** The first thing that looked like bathymetry. Its failure was subtler
   and the founder found it: deep readings sit ~300 m apart *along* the axis while shallow shore
   readings sit ~100 m *across* it, so an isotropic fit lets the lateral pull win and a continuous
   trough breaks into isolated pits. The long-axis profile of MIDAS 1100 runs 44–64 ft continuously
   across half the lake, so the trough is in the data and the fit was splitting it.
5. **Anisotropy by coordinate compression, left compressed.** Connected the troughs and smeared every
   lake into an axis-aligned lens — because the compression warped everything measured in grid units
   downstream (cell size, filter width, mask radius), so a circular smoothing kernel became a 4–8×
   elongated one.
6. **GMT `surface -A`, the documented anisotropy flag.** Removed the smearing and did nothing else:
   measured contour elongation held at ~2.2 across ratios from 0.25 to 4, and the fragment count went
   *up*. Worth recording that the obvious flag is inert here.

What works is **compress for the solve, then `grdedit -R` back to real metres** before anything else
touches the grid. `grdedit` rewrites the coordinate range without altering a value, so the solver sees
a squashed lake while the filter, mask and contour tracer all see real distances.

### The limitation that remains: the axis is straight, and lakes bend

The anisotropy uses **one principal axis per lake**. A lake that curves through its length — Pleasant
Lake does — gets its contours pulled toward a single direction that fits only part of it, which reads
as rigid and over-stretched.

The current mitigation is to **cap the anisotropy at each lake's own measured elongation**, on the
rule *never assume more directionality than the shape exhibits*. It works because a bend makes a point
cloud rounder, so a curved lake asks for less on its own:

| Lake | elongation → anisotropy applied |
| --- | --- |
| Pleasant Lake (curved) | 1.95 |
| Big Reed Pond | 2.01 |
| Quantabacook (long, straight) | 3.32 |
| Varnum Pond (round-ish) | 1.73 |
| a round pond | 1.00 — isotropic |

Configured at 4, no sampled lake receives 4. This is a real improvement and it is **still a straight
axis, just a gentler one.**

### Options for the curving axis, costed

**A — Curvilinear (medial-axis) frame.** *The proper fix.* Compute the lake's centreline, parameterise
every point as (distance along the centreline, signed distance across it), grid in that space, map
back. The anisotropy then follows the lake wherever it goes, and the same transform would make
near-shore behaviour more natural as a side effect.

> **Cost: the largest of these, and the risk is in the branches.** A centreline for a simple
> elongated basin is tractable; for a lake with three arms it is a *skeleton*, and the inverse map is
> ambiguous where branches meet. That ambiguity is not a detail — it is where the contours of two
> arms would have to agree, and getting it wrong shows up as a seam exactly at the junction a skater
> is most likely to be looking at. Would want its own render-first pass like this one had.

**B — Local direction field, applied as steered smoothing.** Grid isotropically, then filter with an
anisotropic kernel whose direction follows a field computed from the shoreline (the gradient of the
distance transform points across the lake; its perpendicular points along). Curves naturally, no
centreline needed.

> **Cost: moderate — a custom filter, since `grdfilter` is isotropic.** The real limit is what
> smoothing can do: it shapes features that already exist and **cannot reconnect a trough the fit
> already split**. So it would address "stretchy and rigid" without addressing "isolated pits", which
> is the problem we started from.

**C — Piecewise axes.** Segment the lake along its length, grid each segment on its own local axis,
blend the overlaps.

> **Cost: moderate, and it buys a seam problem.** Cheaper than a true skeleton and gets most of the
> curvature benefit; the blending between segments is where it would go wrong, and it fails on
> exactly the same branched lakes as A.

**D — Accept the elongation-capped straight axis.** Where we are now.

> **Cost: none.** The honest argument for it: the remaining artifact is a *rendering* imperfection on
> a layer that D82 says makes no claim, on lakes where we have ~48 soundings. Chasing curvilinear
> fidelity on data this sparse may be precision the survey does not support. Revisit if a specific
> lake looks wrong to a real user.

**E — Set the ratio to 1.** Isotropic, i.e. before any of this.

> **Cost: it reinstates the isolated-pit failure** the founder identified, which the long-axis profile
> shows is contrary to the data. Defensible only as "we draw exactly what an isotropic fit gives",
> which is not a neutral position either — isotropy is also a morphological claim, just an unexamined
> one.

**Recommendation: D now, A when a real user complains about a named lake.** The pipeline is already
several iterations past where a paper decision would have landed, and every one of those iterations
was forced by a render rather than by an argument. A is worth doing on evidence from a real map, not
from the sample grid.

### Two other things left open

**Contour crowding.** Where the bed drops off steeply, contour levels bunch into a narrow band and
read as hatching. The obvious fix — dropping levels that render too close together — was **rejected
by the founder and correctly**: a deep lake with a steep bed would then show *fewer* rings than a
shallow one with a gentle bed, understating depth by omission, which is the misleading-by-rendering
D82 exists to prevent. No accepted fix yet. Most likely candidates are a zoom-dependent client-side
thinning (which moves cartographic judgement into two clients) or simply accepting it.

**Near-shore detail is unearned.** The shoreline is pinned at 0 ft and the nearest sounding is often
30–40 ft, with nothing measured in between, so a band of contours crowds into the one place we have no
data. This is inherent to the boundary condition and is not resolved. Worth remembering when reading a
rendered lake: **the most detailed-looking part of the picture is the part we know least about.**

---

## What the wide render found (2026-08-01)

*The chain had only ever been looked at on Maine. The founder asked for it across all five sources —
Lake Morey, Lake Sunapee, Mascoma, Newfound and Champlain by name, plus five each from VT, NH, MA and
ME spanning shapes and sizes, each framed to the whole lake. **Twenty-five lakes, and the widening is
what found all five of the following.** Four were invisible on Maine alone. One is a real ETL bug.*

**Lake George was asked for and cannot be drawn.** No agency publishes bathymetry for it, or for any
other New York lake — §5 below. New York appears in the grid only as Champlain, filed under Vermont
where its source lives, per the founder's call.

### 1 — A source lake key is not always one lake, and the join cannot survive that

**The load-bearing find, and it produced a blank card rather than an error.** NH GRANIT's `au_id`
groups 69 contours under *"Horseshoe Pond"* that span **51 km** with a principal elongation of **56**.
It is two different ponds sharing one assessment-unit id. Since one key resolves to one polygon, the
join picks one pond's shoreline and the clip then deletes the other pond's contours entirely.

Measured across the whole archive, with a scale-free test — *a gap larger than 8% of the lake's own
extent is not a lake* — the damage is small and real:

| Source | Keys holding 2+ water bodies |
| --- | --- |
| NH GRANIT | **4** of 617 |
| ME DEP/IF&W | **12** of 1,522 |
| MassGIS | **1** of 265 |
| VT ANR | 0 of 66 |

**17 keys, not the 15 this table first recorded** — NH has a fourth (*Great East Lake*) and MassGIS
has one (*Stockbridge Bowl*, two basins 3.1 km apart) where this said none. The first count was taken
before the shoreline rebalance moved every lake's extent, and the gap test is *relative to extent*, so
re-measuring moved the borderline keys across it. Corrected from what `samples` prints on every run,
which is the authority: it enumerates all 17 by name and state before it renders anything.

Maine's worst is MIDAS `870`, whose soundings are scattered over **379 km** — most of the state.

**The gate had to be scale-free, and that is the whole difficulty.** An absolute threshold generous
enough to keep Champlain whole (174 km, and genuinely one lake) also keeps MIDAS 870; one tight enough
to catch 870 splits Champlain. A lake is *continuous at its own scale*, and a key holding two ponds is
not, at any scale. Implemented as grid-based connected components rather than pairwise distances —
single-link clustering over the corpus is ~400 million haversines.

**First mitigation: sampling excluded these keys and named every one on every run.** That was never
the fix — 15 keys is small, but each one is a confidently mis-drawn basin, which is precisely what D82
cannot afford.

**✅ Fixed the same day.** `splitByBody` (`lakes.ts`) divides a collided key into one lake per cluster
and each is joined separately. **It runs before the join, and that ordering is the whole of it:** one
key resolves to one polygon, so an unsplit key sends the second pond's geometry to be clipped against
a shoreline miles away, where it vanishes without an error. Both callers split — `join.ts` and
`build.ts` — and both report how many extra lakes the split produced.

Two details worth keeping, because each was a decision:

- **Sub-keys are `#1`, `#2`… ordered by size, largest first**, so a collided key's principal body
  keeps a stable name across runs even if a satellite pond gains or loses readings. A key holding one
  body is returned untouched with its original key: the common case must not pay a rename for the
  rare one.
- **Contour lanes label per *vertex*, so a line is assigned by its first one.** A contour straddling
  two clusters cannot exist — that is what "separate bodies" means — and assuming otherwise would
  have needed a merge step that could only ever produce a wrong answer.

### 2 — The join blows the Convex read cap, and `join.ts` had the same bug

A batch of 20 lakes exceeded Convex's **16 MB per-execution read limit**: each lake pulls every listed
body near its point, polygons attached. It surfaces as an opaque server 500, not a validation error.

**Lowering the constant does not fix it**, because the cost per lake ranges over three orders of
magnitude — a farm pond near nothing against a point in the middle of Champlain. So batching is now
**adaptive**: optimistic, and split-and-retry on a read-limit failure, with a lake that fails alone
recorded as a named reject. `join.ts` shipped with `BATCH = 40` and would have hit exactly this on its
first real run over 1,500 Maine lakes; both callers now share one implementation.

### 3 — Three arithmetic traps that only a second lake reveals

All three were silent on the Maine samples and fatal elsewhere. All three are now pure functions with
tests, in `grid.ts` and `render.ts`:

- **GMT requires the region to be a whole number of cells** (*"(x_max-x_min) must equal (NX + eps) *
  x_inc"*). A padded bbox almost never is, because the pad is a fraction of the *long* side and the
  short axis lands mid-cell. Two of twenty-five lakes failed; twenty-three drew correctly first.
- **`blockmedian` writes to stdout, and node captures 1 MB by default.** Vermont's densest lakes
  reduce to megabytes of cell medians, so the process was killed — with an empty stderr and a null
  status, presenting as *"GMT failed for no reason."* It cost Morey and Groton.
- **The sample renderer ignored latitude.** A degree of longitude at 44°N is ~0.72 of a degree of
  latitude, so every lake was drawn **28% too wide**. On a phase whose entire output is the *shape* of
  a basin, a round pond rendering as an east–west oval reads as a morphology finding.

### 4 — Framing to the data is not framing to the lake

The cards were bounded by the soundings, so on any lake whose survey stopped short of the bank — most
of them — the shoreline ran off the card and the contours appeared to float. The frame is now the
union of polygon, soundings and drawn contours, and the card is sized to the lake's own aspect rather
than letterboxed into a square. Champlain still needs a clamp at 174 km by a few km wide, and **says
so on the card** rather than presenting a false shape silently.

### 5 — What the surveyed lanes are actually for

NH and MA contribute nothing to the interpolation — the agency drew those isobaths. They earn their
place in the grid anyway: **a state-surveyed lake beside a fitted one is the only honest calibration
we have for how good the fitted ones look**, and side by side the fitted lakes hold up.

Two smaller things the wide grid surfaced:

- **The clip against our own shoreline removes real contours** — 46 features on Quinsigamond, 17 on
  Clyde, 8 on several others. That is OSM's water mask disagreeing with the state's survey shoreline,
  not a bug, but it is a number worth watching rather than discovering later.
- **NH GRANIT carries river reaches, not only lakes** (*Piscataquog River*, *Baker River Site 2*).
  Harmless here, but a lane that assumes "lake" will meet them.

---

## The gate that measured the wrong thing (2026-08-01)

> **Settled: we ship with neither.** Shore share was falsified by a render, and the fragmentation gate
> that replaced it was falsified within the hour by Lake Champlain. Both are still *computed and
> reported* on every sample card, so the next attempt costs nothing to evaluate — but nothing gates on
> the output today. Full narrative: [`docs/bathymetry-challenges.md`](../docs/bathymetry-challenges.md).

**`MAX_SHORE_SHARE` was added and removed on the same day, and the reason is the most transferable
thing this phase has produced.**

It gated on the fraction of the solved grid constrained by our own depth-0 shoreline rather than the
state's measurements — the idea being that a fit mostly anchored to distance-from-the-bank is
approximately a distance transform, which is the GLOBathy failure this document opens by refusing.
Set at 0.75 from a 12-lake sample, it dropped **672 lakes on the full corpus, every one of them in
Maine** — 27% of everything we hold.

**Rendered across twenty Maine lakes either side of the threshold, it predicted nothing.**

| Lake | frag/level | shore share | old verdict | reads as |
| --- | --- | --- | --- | --- |
| Beddington Lake | **7.7** | 74% | ✅ kept | the worst map in the grid |
| Ebeemee Lake | **7.3** | 81% | ❌ dropped | noisy |
| Stevens Pond | **5.9** | 90% | ❌ dropped | noisy |
| Silver Lake | 2.0 | 83% | ❌ dropped | clean |
| Bowlin Pond | 1.5 | 76% | ❌ dropped | clean |
| Bowles Lake | 1.0 | 85% | ❌ dropped | clean |
| Deer Lake | 1.2 | 65% | ✅ kept | clean |

The gate kept the single worst map in the sample and dropped four of the cleanest.

### Why it failed, and it is not that the concern was wrong

The concern is real: a surface fitted mostly to its own outline *is* closer to a distance transform.
The metric just doesn't measure it. **The shoreline point budget has a floor** (`MIN_SHORE_POINTS`,
120) because below that an outline stops being a boundary condition and the rings stop closing — so
for any lake with fewer than ~120 independent soundings the shoreline side contributes a roughly
*constant* number of cells while the sounding side varies. The ratio ends up reporting **how few
soundings a lake has**, which we already gate on twice, in `MIN_SOUNDINGS` and in the ladder's
data-support ceiling.

### What replaced it: fragmentation, measured on the output

`MAX_FRAGMENTS_PER_LEVEL` = 4. A depth level that traces as one or two closed rings is describing a
basin; the same level traced as eight disconnected pieces is describing the fit wobbling either side
of that depth, drawn as though it were bathymetry.

**The transferable point is where it is measured.** Every other check in this pipeline asks something
about the *inputs* and tries to predict whether the output will be honest. This one waits for the
output and looks at it. That is the third time an input ratio has failed to predict quality here —
nearest-neighbour spacing (rejected while building the density gate), the coverage gap ratio itself
(*"visual quality does not track this ratio"*), and now shore share. Three for three.

### And one fairness bug the founder found by asking the right question

> *"Should our metric really be # of soundings proportional to total surface area, so as to set a
> density floor, not pure count?"*

The answer is that the density floor already exists and is better than soundings-per-area — the
coverage gap measures the **worst-covered** water, so it catches clustering that an average density
cannot. But the question exposed a real bias in it: **the gap was normalised by the bounding-box
diagonal**, and measured across all 2,437 joined bodies, diagonal ÷ sqrt(area) runs **1.76× at the 5th
percentile, 3.36× at the 95th, 6.9× at the extreme.** A long thin lake was being handed a denominator
nearly twice as large as a round lake of the same area, and therefore nearly twice as easy a pass. Now
normalised by `sqrt(area)`, which is a *stricter* gate and strictest on exactly the elongated lakes
that were getting the easy ride.

---

## Two failure paths the review found (2026-08-01)

*Both from the PR review, and both the same shape as everything else on this page: a fallback that
does the wrong thing quietly, in a branch that had never been taken.*

**A failed clip published contours on land.** When `ogr2ogr` could not clip a lake to our polygon,
`clipped ?? raw` treated the *unclipped* geometry as the answer — the lines the clip step exists to
remove, drawn over the bank, with no dropped-lake record. Now a failed clip returns no lines and a
reason, so the lake lands in `dropped.json` and shows as a flat shape. **A missing map is
recoverable; a wrong one in the tiles is not.** Both lanes refuse, not just the sounding lane: OSM's
water mask and the agencies' survey shorelines genuinely disagree — the clip removes 46 real features
on Quinsigamond alone — so an unclipped *agency* set draws outside our polygon too.

**The shipped artifact is unaffected**, checked rather than assumed: 0 of the 447 drops in the
2,044-lake run were clip failures. The fix is preventive and no rebuild is owed.

**An interrupted snapshot could not be resumed, ever again.** A run killed mid-write left a truncated
`page-NNN.json.gz`; `hasRawPage` reported it present and `gunzipSync` threw, aborting not just that
run but every later one, until somebody deleted the file by hand or reached for `--refresh` on a
whole state — **precisely the outcome the resume exists to prevent.** Fixed at both ends: pages are
now written to a temp name and renamed, so this run cannot create a truncated one, and the resume
read treats *any* unusable page as absent and re-fetches it, naming what it replaced. The second half
is not redundant — a partial `mirror-r2.sh pull` or a bad sector produces the same file, and neither
is something an atomic write upstream can prevent.

*(Worth keeping: **gzip carries a CRC over its uncompressed data**, so a successful decompress is
already an integrity check. That is what makes a damaged page detectable at all, given that the
manifest — the only checksum record — is written at the *end* of a successful fetch and so never
exists for the pages an interrupted run left behind.)*

---

## The NOAA notice, resolved (2026-08-01)

*§5 left one thing open: "NOAA chart-derived data in particular usually carries a 'not for
navigation' class of notice, which is worth reading properly before it renders next to anything on a
safety product." Read properly, it changed the credit line in three ways.*

**Our licence relationship runs to VCGI, not to NOAA.** We take the data from VCGI's service; VCGI's
archived metadata says the layer is *"bathymetric data derived NOAA nautical charts… digitized from
the RF 40,000 scale NOAA charts."* NOAA's terms govern the character of the underlying survey, not
our redistribution chain.

**Three corrections to the placeholder credit** (`NOAA · VCGI · VT ANR · VT DEC`):

1. **It omitted the actual copyright holder.** VCGI's own `copyrightText` reads *"University of
   Vermont (JEFF LAIBLE), VCGI"* — so the placeholder left out UVM and added VT ANR and VT DEC, who
   are not in it at all.
2. **NOAA asks that attribution not imply endorsement or affiliation**, and that modified data not be
   presented as unaltered NOAA data. Champlain's contours are *doubly* derived — NOAA chart, digitised
   by UVM/VCGI, then interpolated by us — so the credit has to say where the soundings came from and
   stop short of implying NOAA drew any of this.
3. **The notice is a separate obligation from the credit**, and is stored and rendered as its own
   field rather than folded into the attribution string.

The credit is now *"Soundings digitised from NOAA nautical charts by University of Vermont and
VCGI"*, with the notice *"Not for navigation."*

**This does not breach D82.** D82 refuses copy telling a skater what a depth *means* for ice; a
licence notice makes no claim about ice at all. If anything it points the same way — it says do not
navigate by this. Worth stating because the first reader of the drawer copy will ask.

---

## Rebuilt against the charts (2026-08-01)

*The four fixes the chart comparison below argued for, built the same day. **D89**: the contour
interval is a fixed ladder, not a per-lake target.*

> **D89 — Every lake is drawn on the same 5 ft ladder, and the ladder only ever steps coarser.**
> Ring *count* is therefore a readout of depth — three rings on a 17 ft pond, eleven on a 59 ft one —
> rather than every lake being normalised to a dozen bands. The interval may step up (10, 25, 50 ft)
> for depth or for thin data, never down. Contour lanes reach the same ladder by **subtraction only**:
> the agency's published levels are thinned toward it, and no level is ever moved or added.

> *"I'd rather see contours every 5 ft and therefore only get 3 contours in one lake and 10 in
> another. But I don't want to just make it up and end up with a very inaccurate depiction."*
> — founder, 2026-08-01

**Why this does not reopen the question D82 already closed.** The earlier proposal — dropping levels
*where lines crowd together on the map* — was rejected because ring count would then depend on how
steep the bed is, *"understating depth by omission."* A fixed **depth** ladder is the opposite: spacing
is uniform in depth and never in map distance, so a deeper lake always shows more rings. It settles
that open question rather than reviving it. *(Spatial crowding on a steep bed is untouched and remains
open — it is a rendering problem, not a level-selection one.)*

**And D83 survives intact.** Its rule was never *"don't choose which surveyed lines to show"* — it was
*"don't draw a line where no depth-sounder went."* Thinning is subtraction. NH publishes at 10 ft,
coarser than the ladder, and comes back untouched; MassGIS's 2/3/4/5 ft shallows collapse toward 5 ft.
67 of 265 MassGIS lakes and 40 of 617 NH lakes thin; the rest are already on the ladder.

**One bug the corpus found and the unit tests had not.** Thinning a lake published at 2/4/6/8/10/12 ft
gave 4/10 — *dropping its 12 ft ring*, the innermost one, the only line that says where the deep water
is. That is D82's understating-by-omission arriving by a different road. **The deepest published level
is now always kept**, whichever rung it lands near.

### What the four fixes did

| | before | after |
| --- | --- | --- |
| Washington Pond (ME) — lines drawn | 69 | **28** |
| Middle Branch Pond (ME) | 18 | **5** |
| Horserace Ponds (ME) | 13 | **5**, and coarsened to 10 ft on data support |
| Burr Pond (VT) | 26 | **5** |
| Lake Groton (VT) | 80 | **13** |
| **Maine shore share** | 84–96% | **58–85%** |
| **Vermont shore share** | 2–8% | **2–6%** |
| Champlain cell size | 349 m | **145 m** |

**The shoreline rebalance is the one that matters most**, because it is the one that was quietly
turning the Maine lane into a distance transform. The shore is now sampled against a budget tied to
the *sounding* count rather than to lake size — and the original objection is preserved as a hard
clamp: never coarser than half the mask radius, because a shore the mask cannot bridge cuts its own
contours in water the fit knows.

~~**`MAX_SHORE_SHARE` = 0.75**~~ — **added here, and removed again before the day was out.** It was
set from the distribution *after* the rebalance rather than from the numbers that prompted it, on the
reasoning that rebalancing moved every lake and a threshold chosen against the old figures would be
measuring a problem that no longer existed. It caught exactly one lake in the sample grid and
apparently the right one: **Horserace Ponds, 24 soundings on a 1.4 km lake, 85%.** Rendered across
twenty Maine lakes either side of the line, it predicted nothing — §*The gate that measured the wrong
thing* is that render, and the constant is gone. **Shore share is still computed and printed on every
sample card**, so the next attempt costs nothing to evaluate.

`samples --ungated` draws what a gate refuses, for the same reason the density gate was chosen by
looking — and it is the reason this one lasted hours instead of shipping.

---

## Checked against the agencies' own maps (2026-08-01)

*The founder's question was the right one: **we had no ideal to compare against.** We do now. Both
Maine IF&W and VT DEC publish finished depth charts as PDFs, including for lakes in our sample grid —
and for Maine those charts are the **originals our digitised points came from**, which makes the
comparison as close to apples-to-apples as this phase will ever get.*

| Lake | Official chart | Their max | **Our max** | Their interval | **Our interval** |
| --- | --- | --- | --- | --- | --- |
| Washington Pond (MIDAS 4894) | [Maine IF&W](https://www.maine.gov/ifw/docs/lake-survey-maps/Washington-Pond-4894.pdf) | 36 ft | **36 ft** ✅ | 5 ft / 10 ft | **2 ft** |
| Lake Morey | [VT DEC](https://dec.vermont.gov/sites/dec/files/wsm/lakes/docs/Depth/lp_morey.pdf) | 42 ft | **42 ft** ✅ | 2 ft | **5 ft** |

**What validates.** Depth extremes match *exactly* on both, which independently confirms the unit
handling end to end — Maine's 3.3-vs-3.28084 constant, Vermont's negative-depth flip, the shoreline
drops. Basin shape validates too: Washington Pond's dogleg with two deep holes, Morey's fat southern
basin narrowing to a north-east arm, and on both the tight-near-shore / flat-in-the-middle gradient.
Morey's north-east arm is left blank by the mask where the state's chart has contours, and **that is
correct** — no sonar ran up there, so we decline to draw it.

### 1 — The contour interval is chosen from depth alone, and it should not be

**We give the sparse lake the fine interval and the dense lake the coarse one — exactly backwards.**

`chooseInterval` targets ~12 bands from `maxDepth` and nothing else, so the cut falls at 40 ft:

| max depth | interval | levels |
| --- | --- | --- |
| 17–36 ft | **2 ft** | 8–17 |
| 42–59 ft | 5 ft | 8–11 |

Washington Pond is 36 ft with **105 soundings**, so it lands on 2 ft and we draw **17 levels through
105 measurements** — 69 fragmented line features where the state drew a handful of clean closed rings.
Morey is 42 ft with **68,139 soundings** and lands on 5 ft, where the state — with the same data —
drew 2 ft. Depth decided both, and depth is the one input that says nothing about how much structure
the survey can support.

**`interval.ts` already states the principle it is violating:** *"too fine and we are drawing our
interpolator's noise."* The fix is to make the interval a function of **data support** as well as
depth — sounding count and coverage gap are both already computed per lake by `assessDensity`.

### 2 — On the Maine lane, most of what the spline sees is our own shoreline

The measurement that should govern this phase's next decision. `blockmedian` reduces to one value per
grid cell before the spline sees anything, so the honest ratio is **cells occupied**, not points:

| Lake | sounding cells | shoreline cells | **shoreline share** |
| --- | --- | --- | --- |
| Horserace Ponds (ME) | 24 | 515 | **96%** |
| Washington Pond (ME) | 105 | 1,409 | **93%** |
| Long Pond (ME) | 78 | 918 | **92%** |
| Long Lake (ME) | 183 | 1,206 | **87%** |
| Middle Branch Pond (ME) | 68 | 361 | **84%** |
| Lake Champlain | 13,873 | 5,145 | 27% |
| Clyde Pond (VT) | 13,604 | 1,113 | 8% |
| Great Hosmer (VT) | 26,738 | 1,381 | 5% |
| Burr Pond (VT) | 13,926 | 461 | 3% |
| Lake Morey (VT) | 68,139 | 1,389 | **2%** |

**On Maine lakes, 84–96% of the constraint is a depth-0 ring we drew ourselves.** A surface fitted
mostly to distance-from-shoreline is, to a first approximation, a distance transform — which is the
**GLOBathy failure this document opens by refusing**, arriving through the back door. Vermont is the
opposite and is genuinely measurement-driven.

**`shoreline.ts`'s stated reasoning is half right and the measurement corrects it.** It argues the
shore needs no thinning because *"`blockmedian` already prevents that — it reduces the input to one
value per grid cell, so a dense shore fills cells rather than stacking them."* True, and beside the
point: `blockmedian` stops the shore **stacking** within a cell, not the shore **occupying fourteen
times more cells** than the data does. The shore is resampled at one grid cell (extent ÷ 500)
regardless of how many soundings exist, so its cell count is set by lake size while the soundings' is
set by survey effort, and on a sparse lake those two numbers are three orders of magnitude apart.

**The candidate fix is small:** scale shoreline resampling to the *sounding* spacing rather than to
the grid. It does not make Maine's data denser — nothing can — but it stops the shore outvoting it,
and it would move the visible near-shore contour band, which is where this shows up on a render.

**And it sharpens the density gate's job.** MAX_GAP_RATIO asks *"how far is the nearest measurement"*;
this asks *"how much of the fit is measurement at all"*, and the second question is the one that
decides whether Maine's lane is honest. Worth considering as a second gate before Maine ships.

### 3 — Anisotropy stretches Morey's deep basin into a finger

Against the VT DEC chart, Morey's deepest region is a **broad rounded basin**; ours is a narrow
elongated finger running along the axis. Morey measures elongation 2.80 and therefore receives the
full 2.80 anisotropy. This is the first *evidence from ground truth* for the complaint recorded in
§*The limitation that remains* — and it argues the straight-axis compression is over-applied on a lake
whose basin is rounder than its outline. It does not settle option A vs D; it does mean the choice can
now be judged against a real map rather than an argument.

### What did NOT turn out to be wrong

**Burr Pond's bowl-like concentric rings looked like the distance-transform signature and are not.**
It is 3% shoreline-constrained with 13,926 soundings across a 935 m basin — a shallow 17 ft pond
genuinely is close to a bowl. Recorded because it was the first thing that looked suspicious in the
grid, and checking it is what produced the table above.

---

## What the build found in the plan

*Written 2026-07-31, at the start of the build, from checking every source against its live service
rather than against a portal description. Same discipline N1/N2/N3/N6a applied to their register
entries — and it found more here than in any of them, because this doc's source table was assembled
from dataset landing pages and **a landing page describes a dataset the way its author thinks of it,
not the way it is serialised.***

The machine-readable version of all of this lives in `scripts/bathymetry/src/sources.ts`, as `notes`
on each registry entry. It is duplicated there deliberately: the person who next re-runs this ETL will
be standing in that file, not in this one.

### 1 — Vermont publishes soundings, not isobaths, and that inverts this phase's sequencing

The single load-bearing error. *§Where the real data is* recorded VT as *"isobaths, published via VCGI
/ ANR."* Both Vermont datasets are **point clouds**:

| VT source | What it actually is |
| --- | --- |
| VCGI *VT Lake Champlain Bathymetry* | **104,910 points**, one attribute: `DEPTH_FT` |
| VT ANR *Bathymetric Data* | a 22 MB zip holding a 134 MB CSV — **2,442,512 sounding points**, `Longitude,Latitude,DepthInFeet,LakeName`, over **66 lakes**, from BioBase sonar logs |

**The consequence is not "one row of a table is wrong."** *§Settled at kickoff* chose VT + NH as the
pilot pair *because* both were believed to be clean contour downloads — *"the pipeline gets exercised
end-to-end on the easy data first, before MA's shapefile-plus-TIFF zip and NY's uneven formats test
it."* In fact Vermont is the **hardest** lane in the set: it is *§Maine*'s interpolation problem, at
2.4 million points. The chosen pilot front-loaded the risk it was chosen to defer.

**And it re-reads the prior art.** `cboone/vermont-lakes-and-ponds-bathymetry` is not, as this doc
assumed, a project that ran a tiling chain over published isobaths — it is a project that **generated**
the isobaths by interpolating those points (QGIS plus a forked contour plugin). So the *§Where the real
data is* argument for building our own still stands, but for a different reason than it gives: the
thing that repo solved is the interpolation, which is the expensive part, and the thing we were
declining to reuse was its tiles, which are the cheap part.

**What rescues Vermont is density.** The sparsest VT lake carries **5,034** soundings and the densest
**136,856** — these are sonar transect logs, not scattered spot readings. Every Vermont lake clears any
defensible density gate by an order of magnitude, which makes the interpolation genuinely defensible
there in a way *§Maine* correctly doubts for Maine. Same shape of data, opposite problem.

### 2 — Maine's PDFs have already been digitised, by Maine

*§Maine* opens: *"Maine IF&W's ~1,900 lake survey maps exist as **PDFs**, which is a digitisation
project, not an ETL."* The state did the digitisation. Maine DEP's *Depth Points* layer carries
**147,755 points** whose provenance columns read `FMSRC=depthmap`, `FMSRCORG=meifw`, `FMPROCSS=dig` —
those *are* the IF&W depth maps, digitised, published, and queryable.

So the §Maine process stands as written, minus its step 0. What it gains instead is a wrinkle it didn't
anticipate: **the layer is two datasets wearing one schema**, and `FMSRC` is the discriminator —
`depthmap` rows are digitised IF&W map soundings, `gpscarrier`/`gpsrec` rows are Maine DEP
depth-sounder tracks. Two provenances, two collection methods, one table.

Maine also keeps its density problem, and it is exactly the one §Maine step 2 was written for:
**~29 points per lake on average** across 5,000+ lakes, against Vermont's ~37,000. The gate is not
theoretical here; it is the whole integrity of the Maine lane.

### 3 — Maine's depth columns are both wrong, by a constant

`DEPTHM` was computed with a **3.3 ft/m** constant rather than 3.28084. `DEPTHM × 3.3` lands on a whole
foot for the digitised rows; `DEPTHM × 3.28084` does not:

| `DEPTHM` | `× 3.3` | published `DEPTHF` |
| --- | --- | --- |
| 3.0303 | **10.0** | 9.94192913 |
| 10.90909 | **36.0** | 35.79097769 |
| 23.63636 | **78.0** | 77.54711286 |

Since `DEPTHF` was then derived from the bad metres with the *good* constant, **every published Maine
depth in feet is systematically 0.58% shallow.** Small, and on the safe side, and precisely the class
of thing that becomes permanent if nobody writes it down. Native feet are recoverable exactly as
`DEPTHM × 3.3` for the `depthmap` rows; the GPS rows are genuine metre readings and convert normally.

### 4 — Contour interval is a per-lake property, and every source is in feet

Two corrections to **D83**, one of which makes it easier to hold and one of which makes its example
label unwritable.

**The unit seam does not exist.** D83 says *"NH and MA publish in **feet**, VT in **metres**"* and
builds its cost argument on a skater crossing a state line and seeing the spacing change. Every source
in the set is feet — VT's columns are literally named `DepthInFeet` and `DEPTH_FT`. D83's *rule*
(carry native intervals, never resample) is untouched and still right; its worked example was
describing a seam that isn't there.

**The interval is not a state-level fact.** D83's model label is *"NH GRANIT, 10 ft contours."* NH's
depth values run 0–180 ft at 1 ft granularity; MassGIS runs 2/3/4/5 ft in the shallows and 5 ft steps
below. Each *lake* has an interval; a *state* does not. The label has to be derived per lake from the
values actually present for that lake, or dropped — and since D82 already says the layer makes no
claim, dropping it is a live option rather than a failure.

*(A small trap inside this one: NH's `depth` column has been round-tripped through metres, so it holds
`1.00000003` alongside `1`. A naive `DISTINCT` returns 116 values where about 60 exist. Round before
grouping, labelling, or deriving an interval.)*

### 5 — New York has no lake bathymetry, and Champlain covers for it anyway

The open question is answered, and the answer is worse than either branch it offered. Checked
exhaustively:

- **NYSDEC's public ArcGIS server** — every folder, every service, every layer — carries exactly **two**
  depth layers, and both are the Hudson River *estuary*.
- **The NYS GIS Clearinghouse's full DCAT catalogue** (385 datasets) holds no statewide lake
  bathymetry: a topographic contour *download app* for land contours, and one Seneca Lake document.
- The only candidate that surfaced anywhere, *"Bathymetry of the Finger Lakes"*, is **50 unattributed
  depth-band polygons** for eleven lakes, with no published copyright and no traceable agency. That is
  an authoritative-looking artifact of unknown provenance — the same thing this document's opening
  section refuses GLOBathy for, arriving by a different road.

**But New York is not blank.** The VCGI/NOAA Champlain source covers *the lake*, not *the state* — its
104,910 soundings include the entire New York shore. So NY's most prominent skating water is covered by
a source filed under Vermont, which is a good outcome reached by an accident of filing and is worth
stating plainly so nobody "fixes" it later.

### 6 — MassGIS needs no download-and-unpack lane, and lies about its page size

*§Settled at kickoff* worried about *"MA's shapefile-plus-TIFF zip."* MassGIS publishes the contours as
a live **FeatureServer** (27,989 lines, keyed per lake by `NAME` + `PALIS_ID`), so the vector half needs
no unpacking at all, and the TIFF is the raster we don't want.

It does have its own quirk, found by running it: the service advertises `maxRecordCount: 2000` and
returns **500** on anything above ~500 rows. Stranger, `resultRecordCount=250` is ignored outright and
begins streaming the entire layer. So the page size is a measured value, not a conservative one, and
"smaller is safer" is false here.

*(Also worth recording because it cost fourteen minutes: `pnpm fetch` is a **built-in pnpm command**
that populates the package store. A package script named `fetch` is silently shadowed and runs an
install instead of your code. The script is called `snapshot`.)*
