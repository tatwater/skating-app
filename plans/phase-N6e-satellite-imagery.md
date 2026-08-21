# Phase N6e — Imagery, scoped to a lake: the aerial reveal and the freeze-up timeline

*Not a base map you switch to. A photograph of **this lake**, clipped to its own shape and the way in,
with a date on it — and behind it, a season of passes you can scrub through and watch the ice arrive.*

> **Status:** 📋 Re-scoped 2026-08-21 after a founder review of the original scoping. **Not built.**
> Gated behind [N6d](./phase-N6d-lake-access-points.md), with **one item that must land inside N6d** —
> see [Prerequisite](#prerequisite--the-one-thing-that-cannot-wait-for-this-phase).
>
> **What changed, and why the rewrite rather than a patch.** The 2026-07-31 scoping specced a
> **base-map toggle**: satellite replaces the vector basemap across the whole map, everywhere, and the
> phase's risk lived in the style branch. Three things falsified that shape:
>
> 1. **The founder wants imagery scoped to a selected lake, not to the map** *(2026-08-21)* — a reveal
>    inside the detail view, bounded to the body and its access, ideally feathered at the edge. That is
>    **content**, not a base map, which contradicts D81's second half. See **D146**.
> 2. **The source the plan named cannot do the job the founder wants.** `USGSImageryOnly` caps at
>    **zoom 16** (~1.7 m/px at our latitude), not the "~0.6 m" the doc and
>    [`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md) both claimed — and NAIP is
>    **summer aerial photography on a 2–3 year cycle**, so no NAIP frame will ever show ice. See
>    **D147**, and §B for the 0.3 m endpoint that does exist.
> 3. **The founder wants a scrubbable timeline of the freeze**, which promotes Workstream C from
>    "gated on evidence" to shipping in the same PR. That brings the phase its own **infrastructure** —
>    the first service we operate ourselves. See **D148**.
>
> **Decisions:** **D146** (imagery is body-scoped content — amends D81's second half), **D147** (free
> sources only; the resolution/cadence trade is physical), **D148** (the timeline is our own archive:
> one masked raster PMTiles per pass), **D149** (ingest is weather-gated; the archive turns over on the
> first frame, not on a date), **D150** (derived ice classification is an observation, never counsel —
> deferred to N6f). Carried in from D138: the Copernicus deep link, `satelliteImagery` and
> `SATELLITE_MIN_AREA_SQM`. Still true: **D84** (two tiers, different jobs), **D75** (the licence
> question was answered by Copernicus).

---

## The finding that reshapes the phase

**"Satellite imagery" was three features wearing one word, and the third one is physically impossible
for free.** Pulling them apart is what makes this buildable.

Every fact in this table was verified against the live services on 2026-08-21, not read off a
datasheet:

| Source | Resolution | Cadence | Winter-usable? | Cost |
|---|---|---|---|---|
| **NAIP** via `USGSNAIPPlus` | **0.3 m** | 2–3 yrs, **summer only** | **Never** | Free, no key |
| NAIP via `USGSImageryOnly` | z16 ≈ 1.7 m/px here | same | Never | Free, no key |
| **Sentinel-2 L2A** | 10 m | **~2–3 days at 44°N** | Yes — extent, snow, open water | Free |
| **Sentinel-1 SAR** | 10–20 m | ~6 days, **cloud- and night-proof** | Yes — with a caveat, see C1 | Free |
| PlanetScope | ~3 m | near-daily | Yes | Commercial quote |
| SkySat / Pléiades Neo | 0.3–0.5 m | **tasked on request** | Yes — would show a ridge | ~$200–400 per lake per capture |

> **D147 — We buy neither end of the trade. Free only, and we say plainly what free cannot do.**
> A pressure ridge is 1–3 m wide: legible at 0.3 m, a smudge at 3 m, **nonexistent at 10 m**. The only
> imagery that would answer *"where can I cross?"* is tasked commercial, at a few hundred dollars per
> lake per pass, against a pilot with no revenue. So the honest scope is: **0.3 m for the landscape,
> 10 m for the ice, and no promise about the surface.** Founder, 2026-08-21: *"Let's see how far we can
> get with free imaging layers, build out a working feature set, and then launch… Even though it's only
> 10 m now, which isn't good enough, it'll at least prove we can do it."* Revisit when there are users
> to spread a paid layer across — and note D75's low-regret detail still holds: **Planet serves from
> Sentinel Hub–compatible endpoints**, so building against Copernicus is not a lock-out.

**The consolation worth remembering:** we already operate a 0.3 m winter sensor, and it is the
skaters. N6d access photos, hazard reports and Phase 8 tracks are the "what does it look like today"
channel. Imagery's job is the part a person standing on the shore cannot photograph — the whole lake
at once, and the landscape around it.

---

## D146 — Imagery is content scoped to a body, not a base-map swap

> **Founder, 2026-08-21:** *"I'm actually tempted to only allow satellite imagery to be turned on for a
> particular lake in the lake detail view… toggling satellite imagery on might somehow bound the image
> to the confines of a single lake body somehow."*

**D81's second half is replaced.** It said satellite *replaces the base map, not the content*. It now
says: **satellite *is* content, revealed for one body at a time, and the base map never changes.**

The one-toggle rule survives — there is still exactly one imagery control and no layer menu — but it
lives in the detail view and it governs a shape, not the screen.

**This deletes most of the original phase's risk, which is why it's the right call and not just a
preference.** Gone with the base-map swap: the style branch through `composeBasemapLayers`, the
label-filtering problem, the decision about whether the region mask survives, the "imagery 404s over
Québec past z10" trap, the attribution swap (both credits simply coexist), and — probably — the
persisted per-device preference, because a per-body reveal is something you *do*, not a mode you live
in.

**What it costs:** you can no longer pan the Northeast in aerial to hunt for access. That was A2's
original pitch in the 07-31 scoping. The founder accepted the trade explicitly.

**Where the control lives** *(founder, 2026-08-21)*: only where a single body is selected **and the map
is visible** — the route carries a body id and the drawer is not expanded to full screen. There is no
imagery control on the browse map.

---

## Workstream A — The reveal: masking, feathering, and what else changes

### A1 — The mask is a union of the lake and the way in

> **Founder, 2026-08-21:** *"the same standard buffer distance (10 m maybe) from the polygon's edges
> AND on both sides of the hiking trail for its whole length AND around the parking lot, all feathering
> outward. So the final shape could be quite weird looking."*

Weird is fine — it is baked offline and it is exactly the effect the inspiration images have. The
algebra is cheap:

```
solid  = union( buffer(lake, r), buffer(trail, r), buffer(parking, r) )
feather = buffer(solid, r₁ … rₙ) at stepped opacity, or a true alpha ramp when we own the raster
```

**Two sizing notes that are easy to get wrong:**

- **The buffer must be per-tier, because a buffer is measured in pixels whether we like it or not.**
  At Sentinel's 10 m, a 10 m buffer is **one pixel** and invisible. Start around **10 m solid + 30 m
  fade for NAIP**, **30 m + 100 m for Sentinel**, and tune by eye.
- **`parkingAreas` stores a `coord`, not a polygon** (`schema.ts:2179`) — so "around the parking lot"
  is a buffered point, not a buffered lot outline. Fine, and worth knowing before someone is surprised
  by a circle.

### A2 — Three ways to clip, and which tier gets which

MapLibre cannot blur a fill or vary `raster-opacity` spatially, so a soft edge has to be constructed:

| Technique | How | Use for |
|---|---|---|
| **Inverse mask** | Draw the raster, then a polygon *with a hole* over it in the basemap colour | **Tier 1 (NAIP)** — hard edge, ships first |
| **Concentric rings** | 6–8 stepped buffers as fills at stepped opacity | **Tier 1**, once the hard edge works |
| **Baked alpha** | Clip and feather server-side; the archive carries its own transparency | **Tier 2 (Sentinel)** |

**We have already shipped the inverse-mask trick.** `maskLayers` in both apps' `waterMap.ts` plus
`REGION_FILTER` in `packages/core/src/basemapLayers.ts` is the "everywhere-but-here is nowhere" pattern,
retargeted from five states to one buffered lake — **including the `fill-opacity: 0.999` gotcha**,
which is documented, load-bearing, and will bite again here if anyone rounds it to 1.

**The split is not arbitrary.** NAIP is a live tile server we don't control, so the mask must be
client-side and stays tunable. Sentinel is *our own archive*, so baking a true alpha ramp in is prettier
and makes the client nearly free — at the cost of needing an ETL re-run to change the buffer.

### A3 — What else changes when imagery is revealed

| Layer | Imagery off | Imagery on | Why |
|---|---|---|---|
| Base map | Protomaps vector | **unchanged** | D146 — this is the whole point |
| Water-body **fill** | drawn | **suppressed** | The photograph is the lake |
| Water-body **outline** | drawn | **kept, and it matters more** | It's what makes the masked patch read as *this lake* instead of a hole in the map. The founder's first inspiration image is precisely a bright outline containing dark imagery. |
| **Bathymetric contours** | drawn in detail view | **not drawn** | D81's surviving half; unreadable over a photograph |
| **Sub-area outlines + labels** | drawn | **not drawn** | Founder call, 2026-08-21 |
| **Hazards** | drawn | **drawn** | Non-negotiable — this is a safety product |
| **Skate paths** | drawn | **drawn** | The layer imagery flatters most |
| **Put-ins / parking / toilets / approach** | drawn | **drawn** | They're inside the mask *by construction* — that's what the union in A1 is for |
| **Place labels** | from the vector style | **kept** | The base map never changed, so this is free |
| Attribution | OSM/ODbL | **OSM + imagery credit** | §A4 |

### A4 — Attribution

Attach credits to **sources**, never compose a string by hand: MapLibre unions the attributions of
active sources, which is correct automatically and is precisely what a hand-written string gets wrong
the first time someone changes a layer. The vector basemap stays loaded, so ODbL is still owed and
still surfaced; the imagery source adds its own.

The USGS string, read off the service rather than paraphrased:
`USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024.`
Copernicus requires attribution under the free/full/open licence (D75).

⚠ **Verify on device:** MapLibre GL JS's `AttributionControl` unions source attributions; MapLibre
**native**'s attribution button behaves differently and has not been checked. Mobile already passes
`attribution` on `MapGL` (`apps/mobile/src/components/MapView.tsx:568`).

---

## Workstream B — Tier 1: the 0.3 m aerial, for reading access

### B1 — The source, corrected

**Not `USGSImageryOnly`.** That service's `maxScale` is 9027.977411 — **ArcGIS level 16** — and z17+
returns a hard 404 rather than upsampling. At 44.5°N, z16 is **~1.7 m/px on the ground**. Enough to see
that a clearing is a parking lot; not enough to count spaces, and a footpath under canopy is invisible.

**Use `USGSNAIPPlus`** on `imagery.nationalmap.gov` — `pixelSizeX: 0.3`, no key,
`access-control-allow-origin: *`. It is an **ImageServer**, not a tile cache, so there is no `/tile/`
endpoint; MapLibre's **`{bbox-epsg-3857}`** token makes `exportImage` a drop-in raster source. Verified
returning a 256×256 JPEG at a z18 extent over Burlington, in which individual cars are countable —
which is the A5 use case exactly.

**The trade:** dynamic rendering, no CDN. Courtesy load matters much more here than against a cached
service, which is why §B3 exists. Keep `USGSImageryOnly` as the low-zoom floor if it proves useful;
`0.3 m` is what the phase is for.

⚠ **Confirm at build:** ArcGIS tile axis order is `/tile/{z}/{y}/{x}` — **y before x**. A swapped pair
404'd in testing, but that is luck of the coordinate; elsewhere it returns tiles, just the wrong ones.
Put the URL behind one function with a test.

### B2 — The date stamp is queryable, per lake

`USGSNAIPPlus/ImageServer/identify?…&returnCatalogItems=true` returns the **source scene** for a point.
For Burlington: `m_4407339_ne_18_030_20230621` — a NAIP quarter-quad, `030` = 0.3 m, acquired
**2023-06-21**, with `acquisition_date` as epoch ms.

So *"aerial: June 2023"* is a fact we can state per body rather than a hedge. One cached call per body,
refreshed when the `Year` field moves. **This filename is also the phase's proof that NAIP cannot show
ice** — it is a photograph taken on the summer solstice.

### B3 — Caching

Public-domain imagery may be freely cached and redistributed, so there is no licence obstacle. **v1
points at the service and measures**, but the trigger to put a proxy in front is much closer than it
was for the cached tier, because every request renders. The Tier 2 pipeline (§C) is the same
infrastructure, so it gets designed once.

---

## Workstream C — Tier 2: the freeze-up timeline

The half the original scoping gated on evidence. **It ships here** — founder, 2026-08-21: *"let's build
the timeline at the same time! We can still wait until we have a proven imaging pipeline, but we
shouldn't push our PR until it's all in."*

### C1 — What the timeline honestly is

**~2–4 usable optical frames per month per lake.** Sentinel-2's revisit at 44°N is ~2–3 days (better
than the advertised 5, because adjacent orbital swaths overlap at latitude), but Burlington averages
60–70% cloud cover December–February. That is a scrubber with real content and it is not an animation.

**Sentinel-1 SAR closes the gap and is in scope** *(founder call, 2026-08-21)*: radar sees through
cloud and darkness, ~5 reliable frames a month. **But it must be described honestly, because its
failure mode is our exact use case** — smooth new black ice is specular and returns dark, and *so does
calm open water*. Rough, deformed or snow-covered ice lights up bright. So SAR is strong on "is this
surface deformed" and weak on "black ice or open water," which is the distinction skaters care most
about. S1 and S2 together resolve most of it; either alone does not.

**The bands are where the real signal is.** Not needed for v1's true-colour frames, but they are why
N6f is worth doing and they should be captured while we're already downloading the granule:

- **SCL (Scene Classification Layer)** — shipped *inside* Sentinel-2 L2A, computed by ESA, with
  per-pixel classes for water, **snow/ice**, cloud (high/medium), and cloud shadow. It is simultaneously
  our ice signal and our cloud filter, for free. **This is the most valuable band in the product.**
- **NDSI** (green vs. SWIR) separates snow/ice from cloud, which true colour cannot — both are white.
- **SWIR generally** is why any of this works: water absorbs it almost totally, ice and snow reflect it.

### C2 — The archive: one masked raster PMTiles per pass

> **D148 — The timeline is our own archive, not a metered API. One region-wide raster PMTiles per
> pass, pre-masked to buffered bodies.**

The founder's call to cover the whole region rather than a destination shortlist is what forces this,
and it turns out to be both cheaper and simpler:

- **Read the open COGs directly** (Copernicus S3 / AWS Earth Search STAC) instead of Sentinel Hub's
  metered Process API. The five states are **~20–25 granules**; at ~6 passes/month that's ~150 granule
  reads a month, and we cut *every body in the corpus* out of them. **The 10,000-request/month quota
  stops being the ceiling at all** — which retires the entire C2/C3 quota argument from the 07-31 doc.
- **Mask first, then store.** Water plus buffers is roughly 5% of the region's area, so masking shrinks
  each pass ~20× — on the order of **40 MB per pass, ~1.2 GB per season**. Pennies in R2.
- **PMTiles, because we already have the whole pipeline**: `scripts/basemap/upload-r2.sh`, the
  bathymetry archive's shape, and a `pmtiles://` reader running natively on both clients.
- **Scrubbing is then swapping an archive URL.** No per-body fetch, no image source, no tile math, and
  the per-body mask and feather are already baked in (A2).

**This needs infrastructure we do not have.** Cutting and rendering granules is a GDAL-class batch job:
not Convex, not a Vercel function. Costed 2026-08-21 against both providers; **Fly** is the
recommendation, on two grounds — its per-job Machine model is exactly this workload (boot, do one
granule, exit, pay per second, and 25 in parallel costs the same as 25 in series), and it is ~2× cheaper
than Railway for the **always-warm, RAM-heavy** service we already know we want next (self-hosted ORS,
~$46/mo vs ~$81/mo at 8 GB). Railway is the nicer developer experience and its $5 Hobby credit would
cover this phase's batch job outright; the ORS workload is what breaks the tie. Fly volumes are
host-pinned with no multi-attach — a real operational edge to know about going in.

### C3 — Ingest gate and season turnover

> **D149 — Ingest is weather-gated, and the archive turns over on the first frame of the new season,
> never on a date.**

> **Founder, 2026-08-21:** *"It's probably not worth much to even bother getting imagery after ice-out
> each spring, until we start getting freezing temps again in the fall… I'm tempted to show the past
> season's imagery from freeze to thaw all the way until it turns over again in November."*

**No new constant, and nothing to tune:**

- **Ingest turns on** when a regional freezing signal appears in the observed weather we already fetch
  (D140's `.past` — never the forecast), and off after ice-out. We skip roughly half the year's passes,
  which is half the bandwidth and half the compute.
- **Retention is "keep the most recent season that has frames."** Last winter's scrubber stays live all
  summer; the moment the first frame of the new winter lands, it flips. In a warm year it flips late,
  by itself.
- `packages/core/src/season.ts` (`seasonOf`, `currentSeason`, D63's July start) already supplies the
  key. What changes is that the key stops being the **turnover** — it just labels the archive
  (`winter-2024-25`), which is what the founder asked for over calendar-year invalidation.

**Backfill last season on first build**, so the feature ships with a full scrubber instead of an empty
one that fills up over three weeks. Copernicus' catalogue is open back to 2015, so depth of backfill is
a storage question, not an availability one.

### C4 — The scrubber, and the honesty that rides with it

**The date is the content, not a caption** (D84, C1 of the original doc, and D3 behind both). A
timeline invites inference far harder than a static image does, so every frame carries its own date and
its own cloud caveat — they travel with the frame, they are not furniture around the control.

### C5 — The nine-season archive and the phenology it yields *(derived dark in PR 2)*

> **Founder, 2026-08-21:** hold every available pass for the region, reveal only the current season, and
> mine the history for **ice-in / ice-out, >90% coverage, first snow, melt events** per body.

**Nine seasons, and the number is an event rather than a preference.** Sentinel-2B reached operations
in mid-2017, which is when the constellation's revisit halved to ~5 days (~2–3 at our latitude).
**Winter 2017-18 through 2025-26 is exactly nine complete seasons at full cadence, with no partial
season at either end.** 2015-16 and 2016-17 exist on a single satellite — a ~10-day revisit, which in a
Northeast winter is one or two usable frames a month — and are excluded, along with everything older
regardless of source *(founder: "not bother with any imagery data older than 9 years")*. That retires
the Landsat-to-the-1980s option; it stays noted as a future product, not this one.

Economics: **~13 GB in R2 (~$0.20/mo)**, backfill ≈ 8,000 granule jobs ≈ **$43 on Fly**, a couple of
days across 25 parallel Machines. Keeping the pixels as well as the derived series is cheap insurance
against wanting to re-derive with a better algorithm.

> **D151 — A phenology date is a bracket between two passes, never a point, and the claim is about our
> observation rather than the lake.**
>
> **Founder, 2026-08-21:** *"we could say something along the lines of 'satellite/radar observed 100%
> ice coverage on X date' instead of '100% ice coverage on X date' so that it's about the **observed**
> date, not the actual date."*

That framing is the honest one and it also solves the cloud problem without statistics. We do not
publish "ice-in: January 8 ± 5 days"; we publish **"open water observed Dec 29 · fully frozen observed
Jan 8."** The gap *is* the uncertainty, stated as the two things we actually saw. A cloudy stretch
widens the bracket, which reads as exactly what happened.

Aggregated across nine seasons those brackets converge on the sentence that is actually wanted —
*"usually freezes in early January"* — which is a climatology, and climatology is the one thing here
that gets **more** reliable as individual dates get fuzzier.

⚠ **Sentinel-1's cadence is not uniform across the archive, and it will bias any trend.** S1B failed in
December 2021 and S1C only reached orbit at the end of 2024, so 2017-22 and 2024-26 have ~6-day radar
revisit while **2022-23 and 2023-24 have ~12-day**. Brackets handle this honestly (fewer passes ⇒ wider
bracket), but a *trend* across seasons — "freeze-up is getting later" — would be contaminated by
observation frequency rather than climate. **Central tendency yes; trend claims no.**

**Prior art — checked 2026-08-21, and the hunch was right.** Nobody has done this for ~25,000 bodies.
What exists is more useful than a dataset anyway:

- **[NSIDC's Global Lake and River Ice Phenology Database](https://nsidc.org/data/g01377/versions/1)** —
  865 lakes and rivers, mostly human-observed, some records centuries long. Far too sparse for us, but
  it is the **variable definitions** everyone else uses, and borrowing them costs nothing.
- **[Remote sensing of lake ice phenology across a range of lake sizes, Maine](https://doi.org/10.3390/rs11141718)** —
  a published algorithm for **small lakes**, validated on **296 lakes in Maine**, one of our five
  states. Fuses Landsat's resolution with MODIS's cadence, which is structurally the same move we make
  with Sentinel-2 + Sentinel-1. **This is the closest thing to a reference implementation we will find**,
  and it says cadence matters at least as much as resolution.
- **[`BigelowLab/iceout`](https://rdrr.io/github/BigelowLab/iceout/f/README.md)** — Maine-based tooling
  in the same lineage. Maine also publishes **human ice-out records**, which gives us a ground-truth set
  *inside our own region* to validate derived dates against. That is how we find out whether the
  pipeline works, and it is worth more than any dataset we could have borrowed.
- **[Daily Lake Ice Phenology from AMSR-E/AMSR2](https://nsidc.org/data/nsidc-0726/versions/1)** — 5 km
  passive microwave. Useless for our ponds; a sanity check for Champlain.

---

## Workstream D — The four pieces D138 moved here

These were specced in N6c's B3, deferred wholesale, and never given a workstream. They are it.

1. **The Copernicus Browser deep link** (D75), built from **`interiorPoint`** — *not* `centroid`, which
   is a `pointOnFeature` result that lands **on the shoreline** and would open the browser off the edge
   of the lake. See the memory note; Willoughby lands on ring vertex 199, Champlain 30.7 km off.
   **It ships in the drawer's reference links, beside Windy** *(founder, 2026-08-21)* — it stays worth
   keeping precisely *because* our own archive stops at the season boundary, and someone will want 2019.
2. **`satelliteImagery: 'auto' | 'on' | 'off'`** per row, resolved by `auto` against
   `surfaceAreaSqM` (`schema.ts:683`, geodesic). Per-row **data**, so an operator edit needs no
   redeploy — only the threshold behind `auto` is a code constant (D75, and the Phase 7 posture).
3. **`SATELLITE_MIN_AREA_SQM`** — the threshold. ⚠ **It is now per-tier**, which the original doc could
   not have known: a pond too small to resolve at Sentinel's 10 m may be perfectly legible at NAIP's
   0.3 m. One constant cannot govern both.
4. **The proving run** — a flag on `scripts/seed-destinations`, which already does the matching half
   (D139). *(The 07-31 doc calls this script `seed-satellite` in two places; that name is two renames
   stale.)*

`packages/core/src/referenceLinks.ts` carries a test asserting **no** Copernicus URL is emitted
(`referenceLinks.test.ts:167`), so the link cannot creep back in ahead of the layer. **Delete that test
here.**

---

## Workstream E — The admin lake editor gets imagery, unmasked

`LakeEditorMap.tsx:301` already re-exports `buildMapStyle`, and tracing a shoreline over a photograph is
the obvious operator win. **Unmasked there** *(founder call, 2026-08-21)* — an operator correcting a
polygon needs to see past its current edge, which is the opposite of what a skater needs.

---

## Prerequisite — the one thing that cannot wait for this phase

**N6d must store the ORS route geometry, before its routing pass finishes.**

A1's mask buffers the trail. **We have no trail geometry.** N6d's correction #9 dropped trail lines from
the OSM extract on the reasoning that a successful `foot-hiking` route *is* the trail signal, so
`amenities` carries a `trail` flag and the schema stores `approachMeters`, `approachAscentM` and
`approachRouted` — but no line.

**And we are already being handed it.** `packages/core/src/access.ts` calls ORS's **GeoJSON** directions
endpoint, which returns the route geometry; the parser takes distance and ascent and discards the rest.
Capturing it costs one optional field and **zero additional ORS quota**. Re-deriving it later means
re-routing every put-in against a 2,000/day quota, paid twice.

It also unlocks **drawing the approach on the map**, which does not exist today — N6d gives a distance
and a hike-in chip, not a line.

---

## Out of scope

- **Derived ice classification / hatch layers → N6f.** Deferred on PR size, not principle; see D150.
- **Paid imagery** (D147). No PlanetScope, no tasking. Revisit with users and a cost-sharing story.
- **A base-map swap** (D146). There is no map-wide satellite mode, and no layer menu.
- **Offline raster.** Imagery requires a connection. Mobile has NetInfo already
  (`OfflineDraftsContext.tsx:109`); **web has no online/offline detection anywhere**, and probably
  doesn't need it.
- **Historical browsing beyond the season archive.** The Copernicus deep link (D75) covers arbitrary
  history in a purpose-built tool at zero cost. ⚠ But see open question 5 — we are now building a date
  slider, which was the deep link's main justification.
- **Deriving a condition, ever.** D3. We show the picture; the skater reads it.

---

## Sequencing — three PRs *(settled 2026-08-21)*

**PR 0 — inside N6d, blocking and time-sensitive.** Capture the ORS route geometry while the routing
pass is still running. See [Prerequisite](#prerequisite--the-one-thing-that-cannot-wait-for-this-phase).

**PR 1 — the reveal. Zero infrastructure.**

1. **A1 + A2 against NAIP** — mask, inverse fill, hard edge. Where the design risk lives, and entirely
   testable before anything is user-visible.
2. **B1 + B2** — the 0.3 m source and its date stamp. The moment the feature exists.
3. **A3 + the control** — the reveal, scoped to the detail view; then rings for the feather.
4. **E** — the admin editor, unmasked. Cheap once 1–3 land, and where operators will stress it.
5. **D** — the deep link and the `satelliteImagery` machinery.

Ships against a keyless public endpoint with no box, no archive and no cron. **Could land while N6d is
still settling**, which is the point of putting the seam here.

**PR 2 — the timeline.** The Fly box, the STAC poll, the granule reader, the masked PMTiles archive,
the scrubber, D149's weather gate and turnover, the 9-season backfill, and the phenology series
**derived dark** (§C5). The long pole, and the only part with an external dependency.

**PR 3 — what the archive knows.** The ice-coverage charts in the drawer and the live hatch layer —
everything user-facing that reads what PR 2 derived. This is N6f's content, and D150's real home.

*This reverses the earlier 2026-08-21 call that the timeline ships with the layer. The timeline is the
biggest thing in the phase and the only part needing infrastructure; keeping it out of PR 1 is what
makes PR 1 reviewable.*

---

## Settled 2026-08-21 (founder review)

- **The scrubber on mobile:** the skater **collapses the sheet without dismissing it** to see the
  timeline. No new layout — the control exists only while the map is visible, which was already D146's
  rule.
- **No zoom floor.** *"They should be able to zoom so far out that it's not visible or so far in that
  it's too blurry to read. That's up to them."* Free to honour: the archive's own tiling decides what
  renders, and it matches the phase's posture — we show the picture, the skater reads it. (Client-side
  restraint on *firing* NAIP requests at absurd zooms is courtesy, not a product rule.)
- **Parent bodies only.** Search a bay, jump to it, turn imagery on, and **the whole lake reveals** —
  not the bay. Consistent with D60: a bay is a name on a lake, not a thing you select.
- **The Copernicus deep link stays**, in the drawer beside Windy (Workstream D).
- **Dev-only; prod deferred**, like every phase since 2.5. This is the first phase with a *recurring
  bill*, and paying it to serve a deployment with no users is a different proposition. Founder: *"Fewer
  surfaces right now keeps life simpler until we're ready."*
- **Hosting: Fly, and the reason changed.** The original tie-break was self-hosted ORS — a service still
  sitting in *Later/deferred* that may never be built, which is thin ground. What actually justifies it
  is **parallel fan-out during backfill**: one season is ~750 granule jobs, which is five days serial
  and a few hours across 25 per-job Machines, at the same total cost. **Lock-in is low if orchestration
  stays host-neutral** — make the container's entrypoint take *one granule id* and keep "which granules,
  when" outside Fly's Machines API. Splitting hosts (Railway for batch, Fly for ORS) costs the same
  ~$50/mo and buys two dashboards, two deploy paths and two bills.

## Resolved 2026-08-21 (second founder review)

- **NAIP survives as the reveal's *home state*.** The founder's instinct was to drop the summer image
  outright; the awkwardness turned out to be a UI problem — a June frame sitting *inside* a freeze-up
  timeline — with a different fix. Turn the reveal on ⇒ **0.3 m aerial**, no pipeline, works today.
  Scrub ⇒ **winter frames display over it** for the dates that exist. One control, no summer frame in
  the scrubber, and the N6d access pairing survives at the only resolution where a pull-off is legible.
  **Keep it easily removable**: founder's standing intent is that *high-res winter replaces summer
  entirely* the day we can pay for tasked imagery (D147's revisit trigger).
- **NAIP stays live-fetched in PR 1 — not archived.** *Archiving it would be ~44 GB* (0.3 m over the
  same water-plus-buffer footprint is ~1,100× the pixels of a 10 m Sentinel pass) — affordable at
  ~$0.66/mo, but it needs the box, which would **destroy PR 1's zero-infrastructure property** and make
  it the harder thing to delete later. Live-fetch is both cheaper to build and more removable. Revisit
  only if courtesy or latency against `USGSNAIPPlus` demands it.
  ⚠ **"Best summer imagery each year" is not annual:** NAIP flies each state on a **2–3 year cycle**,
  so the refresh mechanism is watching the ImageServer's `Year` field per state and re-reading when it
  moves — not a yearly fetch.
- **Nine seasons, derived dark in PR 2, surfaced for real in PR 3.** See §C5 and **D151**.
- **Three PRs.** See [Sequencing](#sequencing--three-prs-settled-2026-08-21).
- **App-wide season turnover: the surgical version, at the founder's delegation** (*"I'll follow your
  lead"*). D63's July boundary stays as the **season key** — it is load-bearing across N5a hazards,
  `contentPurge`, the D66 photo purge, `seasonWindow` and bounties, and changing it is wide blast radius
  for nothing a skater sees. D149's freeze signal applies to the **display default** instead: when last
  season's content stops reading as current. Most of that already happens without a cliff — hazards
  decay on D56's multiplier, reports age on their own curves — so the work is an **audit of what hard-
  cuts at July 1 that a skater would notice**, and moving only that. Scoped as its own small task, not
  part of this phase's PRs.

## Open questions

*(None blocking. The phase is decided end-to-end; what remains is what a screen will tell us.)*

1. **Hard edge vs. feathered rings** — build the inverse mask first, try the rings, keep whichever
   survives being looked at (§A2).
2. **Buffer distances per tier** — the starting numbers in §A1 are estimates, not measurements.
3. **Whether the aerial and the scrubber ever want separate affordances** after both are on screen
   together. One control is the intent; if it reads as two features wearing one switch, that is worth
   revisiting *after* seeing it, not before.
