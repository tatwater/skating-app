# Phase N6e — Satellite imagery in the app: the one map-layer toggle

*The base map a skater can switch to a photograph. Two imagery tiers with different jobs, one switch, and
everything we draw on top stays drawn.*

> **Status:** 📋 Scoped, not built (2026-07-31). Founder ask, same day — *"Can you please spec out the
> phase that will bring satellite imagery into the app while we're thinking about it? I don't want to lose
> track of this, because I want to do it ASAP."*
> **Split out of** [N6c](./phase-N6c-expanded-lake-profiles.md)'s Workstream B3, which ships the
> Copernicus Browser **deep link** and defers imagery *in* the app. This is that deferral, specced.
> **Sibling of** [N6b](./phase-N6b-bathymetry-layer.md) — the two share **D81**, the map's one-toggle
> rule, from opposite sides: contours follow the detail view, satellite is the switch.
> **N6 is now a five-way split:** N6a depth → N6b contours → N6c profiles → N6d access points → **N6e
> imagery**.
> **Decisions:** **D81** (second half — satellite is the map's only layer toggle and it replaces the base
> map), **D84** (two imagery tiers). D75 stays true and is now the *first* half of a two-step.

---

## Why this is its own phase, and not a bullet in N6c

The honest answer to *"does it fit in B3?"* is no, and the reason is worth stating because "it's just a
raster layer" is a very reasonable thing to think.

B3 ships a **URL**. This ships a **base-map swap**: a second style branch on two clients, a toggle whose
state persists, an attribution that changes with it, an offline story, an interaction with every layer
already on the map, and — for one of the two tiers — a caching service with a quota to respect. Bundling
that into a phase whose other four workstreams are strings and numbers would put a map-engine change
inside a metadata review.

It is also **more valuable than its size suggests**, which is why it earns a phase rather than a backlog
line. Every other N6 workstream tells a skater something *about* a lake. This one shows them the lake.

---

## The finding that shapes everything below

**The founder's ask contains two different features wearing one word.** Pulling them apart is what makes
this buildable now instead of gated on a quota.

> **D84 — Satellite imagery is two tiers with different jobs, different sources, and different
> constraints. They ship in that order.**

| | **Tier 1 — Aerial base map** | **Tier 2 — Recent ice imagery** |
|---|---|---|
| **Answers** | *Where's the point? Which dirt road is the pull-off? Is that island or shoal?* | *Is there ice on it right now, and is it snow-covered?* |
| **Source** | **USGS/NAIP** aerial orthoimagery — public domain | **Sentinel-2 L2A** via Copernicus Data Space |
| **Resolution** | ~0.6 m | 10 m |
| **Currency** | Refreshed every ~2–3 years, **leaf-on summer** | ~5-day revisit, cloud permitting |
| **Quota** | **None.** Public domain, no key | 10,000 requests + 10,000 PU/month, 300/min |
| **Cost** | €0 | €0 on the free tier, *if* caching keeps us inside it |
| **Ships** | **v1 — this phase** | **v2 — gated on evidence, in this phase's Workstream C** |

**Why this split is the whole insight.** The quota problem that deferred in-app imagery is a
**Sentinel-2** problem. It says nothing about NAIP, which is public-domain federal imagery with no key,
no quota and no licence question. And the thing a skater does most often with a satellite view — read the
landscape, find the access, understand the shoreline — is served **better** by 0.6 m summer aerial than
by 10 m winter Sentinel-2. The high-value, high-frequency use case is the *unconstrained* one.

**And Tier 2 is honest about being a different thing.** A Sentinel-2 view is a **dated observation**, not
a base map: it is from a specific pass on a specific day, it may be under cloud, and at 10 m a small pond
is a smear (N6c's `SATELLITE_MIN_AREA_SQM` gate exists for exactly this). It wants a date stamp and a
cloud caveat, which a base map does not. Rendering the two in the same affordance without that
distinction would be the D3 trap in raster form — *"the lake looked frozen in the picture"* about an
image from eleven days ago.

---

## Workstream A — The toggle and the style swap *(v1)*

### A1 — What the toggle does (D81, second half)

> **Founder, 2026-07-31:** *"I think topographic lines should always be visible, but we should have a
> toggle switch to turn on/off satellite imagery (which should replace the whole map layer, ditch the
> topographic lines, but still show the hazards and skate paths)."*

Read precisely, that sentence is a complete spec, and it draws the line in exactly the right place:

> **D81 (second half) — Satellite is the map's only layer toggle, and it replaces the *base map*, not the
> *content*.**
> Everything we author or receive stays drawn. Everything cartographic is what gets swapped.

| Layer | Satellite **off** | Satellite **on** | Why |
|---|---|---|---|
| Base map | Protomaps vector | **Aerial raster** | The swap |
| Water-body fills/outlines | drawn | **suppressed** | The photograph *is* the water body. Outlining a lake on a picture of the lake is noise — and worse, our simplified polygon visibly disagrees with the real shoreline at that resolution. |
| **Bathymetric contours** ([N6b](./phase-N6b-bathymetry-layer.md)) | drawn in detail view | **not drawn** | Base-map furniture; goes with the base map. Also unreadable over a photograph. |
| **Hazards** | drawn | **drawn** | Founder call, and non-negotiable — this is a safety product. |
| **Skate paths** ([Phase 8](./phase-8-native-capture.md)) | drawn | **drawn** | Founder call. Also the layer imagery flatters most: a GPS track over an aerial photo is legible in a way it isn't over an abstract fill. |
| **Put-ins / parking** ([N6d](./phase-N6d-lake-access-points.md)) | drawn | **drawn** | The single best pairing in this phase — see A2. |
| **Place labels** | from the vector style | **kept** | See A3. An unlabelled photograph is a puzzle. |
| Attribution | OSM/ODbL | **imagery credit** | See A4. |

### A2 — The pairing that justifies the phase: imagery + N6d access points

Worth naming because it is not obvious from either phase alone. N6d gives a skater a parking coordinate,
an approach distance and a hike-in chip. **Aerial imagery is where those become checkable.** *"Park here,
then 400 m on foot"* is a claim; a 0.6 m photograph showing the pull-off, the gap in the trees and the
path to the shore is the confirmation — before the drive, at home, in daylight.

This is also the argument for **Tier 1 first**. NAIP's leaf-on summer imagery is nearly useless for
reading ice and nearly ideal for reading access: roads, lots, trailheads and shorelines do not change
between July and January.

### A3 — The style branch, concretely

Both clients build their style through a `buildMapStyle(pmtilesUrl, flavor)` function
(`apps/web/src/lib/waterMap.ts:85` and its mobile counterpart), which returns a v8 style with one
`protomaps` vector source and `layers()` from `@protomaps/basemaps`. So the change has a natural shape:

- **A third argument, not a second function.** `buildMapStyle(pmtilesUrl, flavor, { imagery })`. One
  place to change, one place to test, and web/mobile can't drift — the same property that has kept the
  two map styles in agreement so far.
- **Imagery on ⇒ prepend a `raster` source + layer, and filter the vector layers down to labels only.**
  The Protomaps layer list is already partitioned by role, so keeping the symbol/label layers and
  dropping fills and lines is a filter, not a rewrite. This is what makes A3's "keep the labels" cheap.
- **Everything above the base map is untouched.** Hazards, paths, put-ins and bodies are added as our own
  sources after the style loads; they don't care what's underneath. That's why the founder's
  "still show the hazards and skate paths" costs nothing to honour — it is the default, and we'd have had
  to write code to break it.
- **One real gotcha: label legibility over photography.** Dark text on a vector basemap is tuned for a
  pale background and vanishes over a dark lake or a forest. Labels need a halo (or the dark flavor's
  treatment) when imagery is on. Small, and it is the difference between usable and not.

### A4 — Attribution follows the base map

The MapLibre attribution control currently carries `OSM_ATTRIBUTION`, wired to the `protomaps` source
(`waterMap.ts:94`). With imagery on, **OSM is no longer the base map**, so the control should carry the
imagery credit instead — USGS/NAIP for Tier 1, Copernicus Sentinel for Tier 2.

**But not *only* the imagery credit**, and this is the easy mistake: the vector source is still loaded for
labels (A3), so OSM attribution is still owed. The control carries **both** while imagery is on. Attaching
attribution to each *source* rather than composing a string by hand is what makes this correct
automatically — MapLibre unions the attributions of active sources, which is precisely the behaviour we
want and precisely what a hand-written string would get wrong the first time someone changed a layer.

*(N6b's contour credits go in the drawer, not here — different obligation, different placement. The
reasoning is in [N6b §5](./phase-N6b-bathymetry-layer.md#5--attribution-the-minimum-is-smaller-than-it-looks-and-it-belongs-in-the-drawer).)*

### A5 — Toggle state: persisted, per-device

Contours needed no persisted state (D81 makes them derived), which leaves **exactly one** preference to
store — so storing it properly is cheap.

- **Persisted, not per-session.** A skater who prefers imagery prefers it tomorrow too. A toggle that
  resets is a toggle that gets flipped every launch.
- **Per-device, not per-account.** It's a display preference about a screen, and it rides local storage —
  `localStorage` on web, the existing preference store on mobile. No schema change, no sync, and it works
  logged out.
- **Default off.** The vector base map is faster, lighter, works offline, and is what everything else is
  styled against. Imagery is a thing you reach for.

### A6 — Offline: online-only in v1, stated in the UI

Raster imagery is heavy and we do not control the tile server. The Phase 9.5 `file://` PMTiles path (still
awaiting one on-device confirmation) is a **vector** story; an offline raster pack is a separate,
much larger artifact.

**So: imagery requires a connection, and the toggle says so when there isn't one** — disabled with a
reason, not silently blank. This matters more here than usual, because the moment a skater most wants to
check the imagery is at a trailhead with one bar.

---

## Workstream B — Tier 1: the aerial base map *(v1, the bulk of the value)*

### B1 — Source: USGS / The National Map

The **USGS `USGSImageryOnly` tile service** (`basemap.nationalmap.gov`) serves NAIP-derived aerial
orthoimagery for the conterminous US — the same imagery layer editors like iD offer for OSM tracing.

- **Public domain.** NAIP is USDA Farm Service Agency imagery; USGS distributes it as public-domain
  federal work. **No key, no quota, no licence review** — the three things that deferred this feature are
  all absent from Tier 1.
- **~0.6 m** from 2018 onward.
- **XYZ-compatible tiles**, so it drops into a MapLibre `raster` source directly.

> ⚠️ **Confirm at build:** the ArcGIS tile endpoint's axis order (`/tile/{z}/{y}/{x}` — **y before x**,
> which is a classic silent-failure: wrong order returns tiles, just the wrong ones), the service's stated
> usage expectations, and its behaviour at zoom levels past its native maximum. Put the URL template
> behind one function with a test, same discipline N6c applies to the Copernicus link.

**Alternatives considered and why not:** Esri World Imagery is higher quality in places but its terms
restrict use outside Esri's platform; Mapbox/Maxar satellite is excellent and metered per tile; state
orthoimagery programs (VT, NH, MA all have them) are higher-resolution still but are five separate
integrations with five sets of terms, for a marginal gain over 0.6 m. **Revisit state imagery only if
NAIP proves inadequate for the access use case**, which is the one job Tier 1 has.

### B2 — Caching and proxying

USGS's service has no published quota, which is not the same as no limits, and it is not a CDN we control.

**v1: point MapLibre at it directly.** Ship, measure, don't build infrastructure for load we don't have.

**The trigger to revisit is explicit:** if usage becomes material, or the service proves slow or flaky
from our users' networks, put a caching proxy in front of it. Public-domain imagery may be freely cached
and redistributed, so there is no licence obstacle — only the question of whether it's worth the
component. **The same caching layer serves Tier 2**, which is the argument for designing it once, when
Tier 2 needs it, rather than twice.

---

## Workstream C — Tier 2: recent Sentinel-2 ice imagery *(gated, not deferred)*

The half the quota constrains. Kept in this doc rather than a future one, because the design decision that
makes it affordable has to be made *before* Tier 1's caching is built or it gets built twice.

### C1 — What it is, and what it isn't

A **dated observation layer**: the most recent low-cloud Sentinel-2 L2A true-colour pass over this body,
with the date on it. Not a base map. At 10 m the open-water / black-ice / snow-covered-ice distinction is
visually obvious, which is genuinely useful — and a small pond is a handful of pixels, which is what
N6c's `SATELLITE_MIN_AREA_SQM` gate already governs.

**The copy is the hard part, and D3 governs it.** An image is not a condition report, and an eleven-day-old
image of a frozen lake is not evidence the lake is frozen today. The date is not a caption detail; **it is
the content**. Render it prominently, render the cloud caveat, and never let the layer be the most recent
thing on screen without saying how old it is.

### C2 — The quota, and the shape that fits inside it

Copernicus Data Space's Sentinel Hub–compatible APIs: **10,000 requests + 10,000 processing units per
month, 300/min**, free. A full-screen tile view is ~10–20 requests ⇒ ~500–1,000 lake views/month raw.
Not enough for open use.

**Server-side tile caching converts the unit of cost**, and the open Copernicus licence permits it:

- Per-view cost ⇒ **per-lake-per-revisit** cost (~5 days).
- Cache in R2, beside the basemap PMTiles that `scripts/basemap/upload-r2.sh` already publishes.
- **Pre-warm the destination shortlist** rather than fetching reactively — which is exactly what
  `scripts/seed-satellite` was renamed to be able to grow into (N6c B3a). ~40 destination bodies × ~15
  tiles × ~6 refreshes/month ≈ 3,600 requests: comfortably inside the tier, with headroom for reactive
  fetches on everything else.

### C3 — The gate

**Build Tier 2 when we know reads concentrate.** Caching only wins if the same bodies are viewed
repeatedly; right now that is an assumption. Phase 7b's analytics rollups are where the evidence will
come from, and `seed-satellite`'s proving run is what starts producing it.

**This is a gate with a named owner and a named signal**, not a vague "later" — the failure mode N6a
called out (an evidence gate nobody points at is not a gate) applies here, so the check belongs in the
Phase 7b tuning control-room's read-only view alongside the other metrics, where someone will actually
see it.

---

## Out of scope

- **Imagery as the *default* base map.** Slower, heavier, no offline, and every other layer is styled
  against the vector map. Off by default (A5).
- **A second toggle for anything.** D81 is a one-toggle rule and the value is in the constraint. Contours
  follow the detail view; there is no layer menu.
- **Historical imagery browsing / a date slider.** N6c B3's Copernicus Browser deep link already does
  this, better, in a purpose-built tool, at zero cost (**D75** — a link is not an integration). Ship the
  link; revisit only if it's demonstrably not enough.
- **Offline raster packs** (A6).
- **Deriving anything from imagery.** No ice detection, no classification, no automatic condition
  inference. That's a research project and it would be a **prediction**, which D3 says isn't ours to make.
  We show the picture; the skater reads it.

---

## Sequencing

1. **A3 + A4** — the style branch and source-based attribution. Nothing user-visible yet; entirely
   testable, and it's where the design risk lives.
2. **B1** — the USGS raster source. This is the moment the feature exists.
3. **A1 + A5 + A6** — the toggle, its persistence, and the offline disable.
4. **A2** — pair with [N6d](./phase-N6d-lake-access-points.md)'s access points, whenever both have
   landed. No dependency in either direction; they just multiply.
5. **C** — Tier 2, on the C3 evidence gate.

**Steps 1–3 are the shippable unit**, and they have no external dependency beyond a public-domain tile
URL. That's the "ASAP" the founder asked for: the toggle, doing the thing they described, without
touching a quota.

**Relationship to N6b:** the two can ship in either order. If contours land first, A1's table gains a row
that already has an answer; if imagery lands first, N6b's D81 rule is already implemented and contours
just have to respect it. **Neither blocks the other**, which is a consequence of D81 having been decided
for both at once.

---

## Open questions

1. **Does the toggle live on the map or in the drawer?** A persistent map control is discoverable and
   costs permanent screen space on mobile; a drawer control is out of the way and might never be found.
   **Leaning a small map control**, because a base-map switch is a map thing and every mapping app puts it
   there — but mobile screen budget is real and this is worth one look at the actual layout.
2. **Does imagery suppress water-body fills for *all* bodies, or only the selected one?** The table above
   says all, on the grounds that a photograph doesn't need an outline. The counter-argument is that fills
   are how a skater *finds* bodies while panning, and a photo of the Northeast is a lot of green with some
   blue in it. **Possible middle: suppress fills, keep a thin outline.** Worth trying both against real
   imagery rather than deciding on paper.
3. **What happens at zoom levels past NAIP's native maximum?** ArcGIS services typically stop serving
   rather than upsampling. A blank map at high zoom would be a bad surprise at exactly the moment someone
   is inspecting a put-in. Needs a max-zoom clamp on the raster source and possibly a graceful fall back
   to the vector base map.
4. **Tier 2's affordance: the same toggle, or a distinct one?** D81 says one toggle — but Tier 2 is a
   *dated observation*, not a base map, and folding it into the same switch risks the exact conflation C1
   warns about. **Possible resolution: it isn't a layer at all** — a dated Sentinel-2 still in the lake
   drawer, beside the weather strip, where a date stamp reads naturally. That would keep D81 intact and
   arguably present the imagery more honestly than a map layer could.
