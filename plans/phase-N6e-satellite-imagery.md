# Phase N6e — Imagery, scoped to a lake: the aerial reveal and the freeze-up timeline

*Not a base map you switch to. A photograph of **this lake**, clipped to its own shape and the way in,
with a date on it — and behind it, a season of passes you can scrub through and watch the ice arrive.*

> **Status:** 📋 Re-scoped 2026-08-21 after a founder review of the original scoping. **Imagery not
> built; [Workstream 0](#workstream-0--getting-the-way-in-into-the-app--built-2026-08-21) is** — the
> access prerequisite grew into a build of its own on 2026-08-21 (route geometry, the trail
> connectivity pass, and the approach drawn on both clients) and landed on this phase's branch rather
> than as an N6d follow-up (founder call). Gated behind
> [N6d](./phase-N6d-lake-access-points.md), which is complete on dev.
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
| PlanetScope | ~3 m | near-daily | Yes | ~$1.80/km², 250 km² order min |
| SkySat | 0.5 m | **tasked on request** | Yes — would show a ridge | $6–40/km², **25 km² polygon + $15,000 order min** |

**Priced region-wide, 2026-08-21, because "run the region through our masking pipeline" sounds like it
should help and does not.** You pay for **the AOI you request**, and the minimum AOI is larger than most
of our lakes — a typical 2 km² Vermont pond bills as SkySat's 25 km² floor. Masking saves storage, not
money.

| | Rate | Water + buffer (~15,000 km²) | Whole region (~310,000 km²) |
|---|---|---|---|
| PlanetScope archive | ~$1.80/km² | **~$27,000** | ~$558,000 |
| SkySat archive | $6/km² | ~$90,000 | ~$1.9M |
| SkySat flexible tasking | $12/km² | **~$180,000** | ~$3.7M |
| SkySat assured tasking | $40/km² | ~$600,000 | ~$12.4M |

**And that is one pass.** The entire point of paying is cadence, so a season multiplies by 30 (Sentinel-
like) to 150 (near-daily). Three to four orders of magnitude outside a pilot.

*Correcting the earlier "~$200–400 per lake per capture": right per lake (25 km² × $12 ≈ $300), wrong in
practice — **SkySat carries a $15,000 minimum order**, so a single lake cannot be bought. Even the
40-lake destination shortlist is ~$12–15k per pass.* **The realistic paid future is a shortlist tasked a
handful of times a season at ~$15k an order** — a feature paying users fund, not a general layer.

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
| **Sub-area outlines + labels** | drawn | **drawn, behind a flag** | Founder call reversed 2026-08-21b — *"I'm open to keeping [them] drawn… let's make that easy to turn on and off so we can play around with it."* |
| **Hazards** | drawn | **not drawn** ⚠ | Founder call, 2026-08-21b — *"different user intents."* **See the safety note below; behind one constant.** |
| **Skate paths** | drawn | **not drawn** | Same call. The least contentious half of it — a track is a record, not a warning. |
| **Put-ins / parking / toilets / approach** | drawn | **drawn** | They're inside the mask *by construction* — that's what the union in A1 is for |
| **Place labels** | from the vector style | **kept** | The base map never changed, so this is free |
| Attribution | OSM/ODbL, on-map control | **drawer credits + an on-map ⓘ** | §A4 |

> ⚠ **The hazard row reverses a call this phase previously described as non-negotiable, and the
> reversal is recorded rather than smoothed over.** D81 named this exact scenario: *"A skater who turns
> on imagery to check a put-in must not lose the hazard pins doing it; that would be a safety
> regression delivered by a display preference."* That sentence was written from the founder's own
> earlier instruction to keep hazards drawn over imagery.
>
> **What makes the reversal defensible:** the drawer still lists every hazard on the body; Phase 9.5's
> on-ice alerting is independent of map display entirely; and the reveal is a deliberate, temporary,
> planning-mode act rather than a persisted mode someone forgets they left on (D146 killed the
> persisted preference, which is what makes this true).
>
> **What it must therefore never become:** a default, a persisted state, or a mode that survives
> navigation. If the reveal ever becomes sticky, this row has to change back.
>
> **Implementation rule:** one constant governs both hazard and path visibility, so flipping it — or
> moving to the dimmed-rather-than-hidden middle — is a one-line change and not an archaeology
> expedition.

### A4 — Attribution: credits in the drawer, one ⓘ on the map

> **Founder, 2026-08-21b:** *"can we keep all attribution strings in the sidebar/drawer, instead of over
> the map itself? Or is that against ToS"*

**Mostly yes — and the three sources have three different obligations, which is what decides it:**

| Source | Obligation | Drawer-only OK? |
|---|---|---|
| **USGS / NAIP** | **None.** Public-domain federal work | Yes — courtesy only |
| **Copernicus** | Attribution required, **placement flexible** | Yes |
| **OSM / ODbL** | Attribution *"reasonably calculated to make users aware"* | ⚠ **The binding one** |

OSM's guidance for a browsable map wants the credit in the map corner, or — where that is impractical
— reachable through a **clearly-labelled affordance on the map itself**. Credits that live only in a
drawer, with no on-map path, is the configuration that risks non-compliance.

**So: a small ⓘ on the map that opens the drawer's credits panel.** Clean map, compliant attribution,
and one place that composes the whole credit list instead of a control that grows a string per layer.

⚠ **This touches the existing map, not just imagery.** Both clients currently run a live MapLibre
attribution control (`apps/web/src/components/MapView.tsx`, and `attribution` on mobile's `MapGL` at
`MapView.tsx:568`), so this is a change to shipped behaviour and wants its own commit.

**Strings, read off the services rather than paraphrased:**
`USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024.` · `© OpenStreetMap
contributors` · Copernicus Sentinel data \[year].

⚠ **Verify on device:** MapLibre native's attribution button behaves differently from GL JS's control,
and suppressing it in favour of our own ⓘ has not been checked on Android.

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

**A band selector ships with the scrubber** *(founder call, 2026-08-21b — "once imagery is turned on by
the user, they should see an additional toggle to switch between the bands")*. True colour · NDSI ·
a SWIR composite · SAR VV. **This sits comfortably inside D150** precisely because it is the raw
observation with no interpretation layered on — the user reads the pixels, exactly as they read the
photograph. It is also the honest precursor to PR 3's hatch layer: anyone who wants to check what the
classification was derived *from* can look at it.

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

#### The Mt Washington problem, and why it turns out to be cheap

> **Founder, 2026-08-21b:** *"are we at risk of high-elevation weather readings causing the season to
> occupy a lot more of the year than just Nov→Mar? I'm thinking specifically about the top of Mt
> Washington, which can be incredibly cold, even in summer months."*

Real, and worse than the summit: **Lakes of the Clouds is a body in our corpus at ~5,000 ft**, so
"sample only at water bodies" does not save us. Three guards, and the third is the one that matters:

1. **Sample at bodies, not a grid.** No summit stations enter the calculation at all.
2. **Percentile, never minimum.** *The 25th-percentile body* must show sustained freezing — so a handful
   of alpine tarns cannot drag the region into season. We have elevation on **99.5%** of bodies (N7-3),
   so excluding the top decile is free if we want belt-and-braces.
3. **The gate and the turnover are different things, and only one of them is user-visible.** Weather
   decides *when we start looking*; **the first frame that shows ice decides when the app turns over**
   (D149). So an over-eager gate costs a few dollars of granule fetches and nothing else. **Mt
   Washington can make us start looking in September; it cannot make the app claim the season turned.**

That asymmetry is licence to make the gate deliberately generous — the expensive failure is a *late*
gate that misses freeze-up, not an early one that wastes compute.

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
- **[Lake Stewards of Maine's ice-in / ice-out tracking map](https://www.lakestewardsofmaine.org/volunteer-programs-tools/ice-in-ice-out-tracking/ice-in-ice-out-tracking-map/)**
  *(founder find, 2026-08-21b)* — **volunteer-submitted ice-in/ice-out with a downloadable JSON behind
  an ArcGIS FeatureServer query endpoint.** Machine-readable ground truth, in one of our five states,
  from people who watch these lakes. **This is the validation set**, and it is better than anything the
  literature search turned up. ⚠ Two cautions: the site asserts *"©2026 Lake Stewards of Maine"* with no
  stated licence, so **validating against it and republishing it are different acts** — ask before the
  second. And citizen-science definitions drift between observers (first skim vs. full cover), which is
  exactly what NSIDC's standard definitions are for.

#### The window metrics — the most valuable thing in the archive

> **Founder, 2026-08-21b:** *"The prime window for skating is often the brief period between ice-in and
> first real snow (3–6+ inches) — after that, ice conditions get a lot more snow/weather-dependent."*

Target sentence, per body: *"Usually freezes in early January · first lasting snow typically 5 days
later · open ice roughly 30% of the season."*

⚠ **One of those clauses cannot come from imagery, and the split is the design.** Optical imagery sees
snow *presence* (SCL's snow/ice class, NDSI); it **cannot see 3–6 inches**. But the weather lane already
fetches **Open-Meteo snowfall**. So: **imagery for the ice, weather for the snow**, joined on the
imagery-derived ice-in date. Neither lane could produce this sentence alone.

**Phrasing stays inside D151 and D3** — these are observed medians across nine seasons, and each clause
is a description. *"Prime window"* and *"best ice"* are the phrasings to avoid; the sentence is more
useful without them anyway.

#### Two research lanes this archive opens — both deferred, one with a hard cap

**Black ice from SAR + freeze rate → N6g, research, validation-gated.** Physically plausible: smooth ice
is specular and returns dark in SAR, so *low backscatter **plus** Sentinel-2 classifying ice rather than
water* is a smooth-ice signature, and how fast a body froze is a genuine covariate. Against it: 10–20 m
pixels, black ice that changes character within hours, and **an incentive structure that makes a false
positive the costliest error this product could make** — everyone wants black ice, which is exactly why
they would trust the claim.

> **Rule if it is ever built:** validated against our own condition reports first, and **the strongest
> claim it may ever make is "smooth ice observed on \[date]."** Never *"black ice here."* D3, D150, D151
> all point the same way.

**Never-freezing bodies → demote, never delete.** Nine seasons of never-observed-ice is strong evidence
for Cape Cod and coastal brackish water, and it is a genuinely good use of the archive. But evidence of
absence has failure modes: **a sub-pixel pond cannot show ice at 10 m regardless of temperature**, and a
missed cold year is a missed cold year. Deletion is the one irreversible operation in the corpus, and we
already have demote lanes — `listed`, D49 prominence, N6f's access verdict. **So a body with nine dry
seasons gets demoted, with the evidence shown to an operator**, and never removed.

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

## Workstream 0 — Getting the way in into the app ✅ **BUILT 2026-08-21**

*Scoped as a one-line prerequisite. It became a workstream because the window it depended on had
already closed, and because the founder took the second half of it at the same time.*

### 0a — The line ORS was already handing us

A1's mask buffers the trail. **We had no trail geometry.** N6d's correction #9 dropped trail lines from
the OSM extract on the reasoning that a successful `foot-hiking` route *is* the trail signal, so
`amenities` carried a `trail` flag and the schema stored `approachMeters`, `approachAscentM` and
`approachRouted` — but no line.

> ### ⚠ The zero-cost window closed on 2026-08-13, and the prerequisite was written as though it
> hadn't
>
> *"Before its routing pass finishes"* was the right instruction and it arrived eight days late.
> N6d's routing pass **completed at 99.4% on 2026-08-13**, and the check that mattered was not the
> plan but the cache: `.scratch/access/ors-cache.json` holds 4,976 legs as
> `{"meters":129.3,"ascentM":0.2,"routed":true}`. `parseOrsFootHikingRoute` read `summary.distance`
> and `ascent` off `features[0].properties` and dropped `features[0].geometry` — so the responses are
> gone, and *"costs zero additional ORS quota"* stopped being true the moment the last leg cached.
>
> **Recovering it is a re-route**, against a 2,000/day quota that answers with a `403` carrying no
> reset header. Priced from the cache before spending anything: 4,945 routed legs (~3 days), 2,349
> over 150 m (~2 days), or **262 hike-in legs (under one day)**.
>
> **Founder call, 2026-08-21: hike-in only.** The line exists to be drawn and to be buffered into
> N6e's mask, and below 800 m it is a few metres of tarmac between a car and a bank — invisible at
> the drawer's zoom, invisible inside a 30 m buffer, and paid for on every read of the row. The
> residue, stated: the 2,087 legs between 150 m and 800 m keep their distance and their chip and
> render no line, so N6e's mask on a short-walk body buffers the lake and the parking alone.

**What shipped.** `approachPathWanted` is one predicate shared by the parser and the ETL, so a leg can
never be re-routed against the quota and then have its geometry thrown away. The path is stripped to
2D (`elevation: true` returns `[lng, lat, metres]` triples, and the climb is already on the row),
simplified to `APPROACH_PATH_TOLERANCE_M` — 5 m, the corpus shoreline's own tolerance — and refused
entirely above `APPROACH_PATH_MAX_VERTICES` rather than truncated, because a truncated route is a walk
that stops in the woods.

**The cache gained `pathAsked`, and that is what lets the backfill finish.** A routed leg whose line
came back unusable is a **real answer** and is remembered, exactly as a 404 is. Without the flag those
legs would be re-requested on every run for ever — the mirror image of the 429-cached-as-an-answer bug
N6d's first run found, which cached a failure as an answer where this would refuse to cache an answer
at all.

**One line is never drawn: the straight-line fallback's.** The distance can hedge itself — *"at least
900 m on foot"* — because a number carries its own qualifier. A line cannot: a crow-flies segment
through the woods is indistinguishable on a map from a route somebody walked. So `approachPath` is
written only for a routed hike-in leg, and `setPutInAccess` **retracts it** on both branches that
re-point the association, since a stale line would be drawn from the *new* lot's marker as
authoritatively as the routed ones beside it.

### 0b — Pairing a trailhead by the trail rather than by the radius

> **Founder call, 2026-08-21:** take the trail-connectivity fast-follow N6d sized and declined, in
> the same pass.

N6d's *§Sized 2026-08-14* recommended *"don't, yet"* and the founder overrode it. The case is real and
nothing else reaches it: `pairAccessFeatures` caps at `PARKING_INFER_RADIUS_M`, so **a lot a kilometre
up a trail never pairs, and a leg that never pairs is never routed.** Widening the radius does not
help — the measured distance curve from unpaired lots to the nearest launch rises monotonically to
3–8 km with no trailhead population to aim at.

So the trail lines come back, for a question routing cannot answer. They are **not stored**: 1.15M ways
stream into `Float64Array`s, build a graph, and are discarded. Nothing about trails reaches Convex.

- **The graph is built by hashing endpoint coordinates**, which is the de-risking N6d measured: 29% of
  Vermont's trail endpoints are byte-identical across ways, because `osmium export` round-trips the
  same double for the same node. No pyosmium, no node-ref extraction. `COORD_KEY_DP` is 7 (~11 mm) and
  ⚠ loosening it does not improve connectivity, it invents crossings where a path passes over a
  culvert.
- **Dijkstra, not BFS**, because trail ways differ in length by three orders of magnitude and a hop
  count would prefer one 4 km logging track to six 50 m footpaths.
- **The inference budget is `HIKE_IN_ASSERT_M`, not a number of its own.** D144 already drew this line
  for the human direction — above 1,600 m an association must be *asserted* rather than derived — and
  an ETL guessing at 3 km would be doing exactly what that forbids a person from doing silently.
  Beyond it the answer stays `setOfficialParking`, which has no distance limit and attributes the
  claim to somebody.
- **A trail pairing also flips the lot to `paired`**, which is what carries it through the loader's
  water-relevance gate. Without that the very lots this pass exists to find would be filed as
  `notNearWater`, since a trailhead is beyond every shoreline by definition.

### 0c — The walk, drawn

N6d gave a distance, a climb and a Hike-In chip and no way to see **where** the kilometre goes. The
line now renders on both clients from `packages/core/src/approachLayer.ts` — dashed, because a solid
line reads as surveyed infrastructure and this is an ORS route over OSM's trail data.

**It is drawn from the marker query, not from a query of its own**, and that is a correctness choice
rather than a saving. `putIns.hide` inserts a suppression *coordinate*, so a hidden launch is filtered
out of `listForBody` before it can contribute — and its line goes with it. A second query would have
re-created the PR #43 defect exactly: the marker gone from the map while a dashed trail still walked
to where it used to be.

### What the run found — 2026-08-21

*Three things, and the third was invisible until the lines were drawn.*

**1. The geometry came back almost whole, and the quota was never in danger.** 262 hike-in legs
re-requested, **254 lines recovered (97%)**, `retryableFallbacks: 0`, `legsAwaitingPath: 0`, and no
`403` at all — 331 requests including the new pairings, against a 2,000/day ceiling. The stored lines
run **11 to 53 vertices** after simplification, median 18, nowhere near
`APPROACH_PATH_MAX_VERTICES` — so the cap never bound, which is the outcome that makes "refuse rather
than truncate" cost nothing.

**2. The trail pass works and yields far less than it was sized at.** The graph built exactly as
predicted — **1,153,613 ways, 1,559,201 nodes, 0 degenerate, 1,677 cross-border duplicates** — and
Vermont reproduced the sizing pass's own figures to the row (27 of 185 unpaired launches on a trail;
the doc measured 27). Across five states, **2,030 of 8,361 unpaired launches** and **52,667 of 92,384
unpaired lots** are within `TRAIL_SNAP_M` of a trail, 106.9M candidate pairs were pruned by the exact
straight-line filter, 24,480 searches ran — and the result is **69 new pairings**, against the
150–300 N6d extrapolated.

Loaded, that is **+12 launches that gained a lot** and **+1 body with a put-in**: the 69 include a
great many coastal beaches and piers that match no corpus body, which is the same scope boundary the
9,737 unmatched candidates already described. **N6d's *"don't, yet"* was right about the yield.** The
founder took it anyway and the machinery now exists; the honest summary is that the trailhead case is
rarer in OSM than the lot-side numbers suggested, because the **launch** side was always the ceiling.

**3. ⚠ Thirty approaches were not walks, and drawing them is what made that obvious.** Sorted, the
routed legs run continuously to 4,061 m and then jump to 4.9 km, 8 km, 17 km, 26 km, and **three at
99 km** — every one of them a lot within 250 m of its launch that ORS could only reach by going
around the water. N6d has been storing those since August: the drawer says *"about 99 km on foot"* and
the body wears a Hike-In chip. As a number it is absurd and easy to miss; as a **dashed line crossing
three counties out of a lake's parking marker**, it is unmissable, which is why this fell out of the
render work rather than the data work.

`MAX_PLAUSIBLE_APPROACH_M` (5 km) demotes them to the straight-line rung — *"at least 250 m on foot"*
— keeping the pairing, dropping the number that was wrong and the line that would have drawn it. The
rule is applied where the leg is **used** rather than where it is requested, so the 30 already in the
cache were fixed by a re-run that spent no quota at all. Dev now carries **zero** put-ins claiming an
approach over 5 km.

**Where it landed:** 3,589 put-ins · 1,363 with a lot · **30 launches across 22 lakes draw a walk**.
That last number is small for the same reason as the trail yield: of 266 launches whose line was
recovered, **288 of the 331 changed rows matched no corpus body**, so the lines mostly belong to
coastal launches we do not carry.

> **Not yet verified on a screen.** The pure layer is covered by tests on both clients and the data is
> loaded on dev, but nobody has looked at a rendered dashed line. Web first, then the Android build.

**Two operator notes, because both cost time to rediscover:**

- ⚠ **`load-access parking` needs `--batch=1` for a coastal-Massachusetts slice.** The default batch of
  8 blew Convex's **16 MB per-execution read cap** on lots around Boston — 13.5 MB for eight of them —
  and the loader skipped both batches rather than failing loudly. This is the 105 GB lesson's
  smaller sibling: `marginMeters` fixed the *per-lookup* waste, and `bodiesCoveringBox` still matches
  on **bbox**, so one lot near a body with a large bounding box reads that whole polygon. The
  batch size is what bounds it.
- **Only the changed rows were loaded** — 49 lots and 331 put-ins, diffed out of the artifacts against
  the pre-run copies — rather than re-running 95,294 lots through the join that took the deployment
  down in August. The loaders upsert on OSM id, so a subset is a legitimate load and not a shortcut.

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

**PR 0 — the way in.** ✅ **Built 2026-08-21**, on this branch rather than inside N6d (founder call —
N6d is merged, and a follow-up PR against it would have been a second review of the same code). The
route geometry, the trail connectivity pass the founder took at the same time, and the approach drawn
on both clients. See [Workstream 0](#workstream-0--getting-the-way-in-into-the-app--built-2026-08-21)
— including why *"while the routing pass is still running"* arrived eight days too late to be free.

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
