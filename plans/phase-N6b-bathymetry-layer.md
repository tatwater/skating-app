# N6b — The bathymetry layer: real isobaths inside the lake

*A toggleable underwater-contour layer, drawn from state-agency surveys. Designed, not built.*

> **Status: 📋 Designed at N6a's kickoff (2026-07-29), deliberately not built.** Split out of the
> register's single **N6** entry when the founder asked whether we could draw topographic lines inside
> the lake bodies. The answer is **yes, from measured state-agency data, and emphatically not from the
> global modelled sources** — which is the finding that made this its own phase rather than a bullet in
> [N6a](./phase-N6a-lake-depth.md). Storage/serving settled at kickoff: **PMTiles on R2**. Coverage:
> **VT + NH first.** Maine's path is written up in *§Maine* per the founder's explicit ask.
> **All six open questions were answered 2026-07-31** — see *§Settled by the founder*. The largest
> consequence: **there is no contour toggle.** Contours are a property of the detail view, and the map's
> only layer switch is satellite, which now has its own phase — [N6e](./phase-N6e-satellite-imagery.md).
> New decisions **D81** (one toggle), **D82** (context, not counsel), **D83** (native intervals).

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
| **VT** | VT ANR (compiled Aug 2020) + Lake Champlain from NOAA charts (1:40,000, VCGI updates 2003/2010) | isobaths, published via VCGI / ANR | prior art worth reading before building: [`cboone/vermont-lakes-and-ponds-bathymetry`](https://github.com/cboone/vermont-lakes-and-ponds-bathymetry) (CC0) |
| **NH** | NH GRANIT *NH Bathymetry — Lakes (Lines)*; NHDES surveys since 2000 + NH Fish & Game; updated Feb 2024 | contour lines, depth in feet | also a Polygons layer (contour-interval areas) |
| **MA** | MassGIS *MassWildlife Inland Water Bathymetry*, 1:10,000, GPS/depth-sounder | contour lines + depth raster | shapefile + TIFF in one zip |
| **NY** | NYSDEC Lake Contours, NYS GIS Clearinghouse | contours | maturity/format needs a look; much of DEC's fishing-map corpus is PDF |
| **ME** | Maine GeoLibrary *Lake Depths* | **sounding points, not contours** | IFW lake survey maps are PDFs — see *§Maine* |

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

**NY's actual maturity.** *(Was Q6, unchanged and not a founder question.)* DEC lake contours exist on the
NYS GIS Clearinghouse, but much of DEC's contour-map corpus is PDF fishing maps. Whether NY behaves like
NH (clean vector download) or like ME (a digitisation project) needs one afternoon of looking before it's
sequenced. It doesn't block VT + NH, which is the pilot pair.
