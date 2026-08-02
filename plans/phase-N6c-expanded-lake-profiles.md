# Phase N6c — Expanded lake profiles: derived stats, captions, reference links, and map summary cards

> **⚠️ SPLIT INTO TWO PHASES, 2026-08-02 (founder call at kickoff).** As scoped this was ~15
> workstreams across schema, ETL, two clients, a new external API, an admin surface and a
> corpus-wide re-score — comfortably the largest phase on the roadmap and one review surface for all
> of it.
>
> - **N6c-1 — derived numbers.** Workstreams **A** (geometry stats, elevation), **A5**
>   (`regionStats`), **C** (the caption) and **D2** (profile richness → prominence), plus **A4b**,
>   the winter wind rose that came out of the build. ✅ **BUILT 2026-08-02** on branch
>   `phase-N6c-1-lake-profiles` — unpushed, undeployed, ETL passes **not yet run**. See
>   [*§What the N6c-1 build found*](#what-the-n6c-1-build-found).
> - **N6c-2 — links, cards and observability.** Workstreams **B** (reference links, NWS alerts, the
>   short forecast), **B3a/D** (the seed script), **E** (per-body summary cards) and **F** (record
>   history + import observability). **Not built.** Everything below those headings stands as
>   written except where *§What the N6c-1 build found* corrects it.
>
> **Status:** 📋 Scoped, not built (2026-07-30). Founder ask, same day. **Workstream E (per-body map
> summary cards) was folded in on 2026-07-30**, out of the roadmap's deferred design sketches.
> **Depends on:** N6a (`meanDepthM`/`maxDepthM` + the depth ladder) — built and on dev, **ETL not yet
> run**. That unrun loader is this phase's one scheduling constraint; see [Sequencing](#sequencing--and-the-one-time-sensitive-item).
> **Sibling of:** [N6d — lake access points](./phase-N6d-lake-access-points.md) (split out of this doc
> at scoping, 2026-07-30: it was roughly the size of everything else here combined) and
> [N6b — bathymetry contours](./phase-N6b-bathymetry-layer.md) (complete 2026-08-01 — its coverage is
> what feeds this doc's `+2 has bathymetric contours` prominence term).
> **N6 is now a five-way split:** N6a depth → N6b contours → **N6c profiles** → N6d access points →
> [N6e satellite imagery](./phase-N6e-satellite-imagery.md) (specced 2026-07-31 out of B3).
> **Decisions:** D70, D71, D74, D75, D76, and **D85/D86** added 2026-07-31, plus **D90** (the wind
> rose) and the **D85/D86/D2 amendments** added 2026-08-02 (see [`01-decisions.md`](./01-decisions.md)).
> D72/D73 are N6d's; D81–D84 are N6b's and N6e's, plus **D89** (N6b's fixed contour ladder).
> **All five open questions were answered 2026-07-31**, plus A3, B3, B3a, B5 and E3 — see the marked
> sections. Two answers changed the build: **shoreline is measured on the source geometry** (D85, and it
> moves A2–A4 onto the *canonical water re-import* rather than the depth run), and **the summary card
> carries a consensus quality mark after all** (D86, reversing this doc's own recommendation).

---

## What the N6c-1 build found

*Written 2026-08-02, against the code. **Six of this plan's own claims were false or misleading**,
four of them caught by running the functions against real lakes rather than against fixtures — which
is the finding underneath the findings: every one of these passed its unit tests.*

### 1. The dimension-line method reported 2× the true width

A2 specified *"the hull diameter (longest chord between hull vertices), giving `longAxisM`… The
perpendicular hull width gives `shortAxisM`."* **That pair does not produce a dimension line.** For a
rectangle `w × h` with `h ≫ w`, the hull diameter is the *diagonal*, and the hull's extent measured
perpendicular to that diagonal is `2wh/L ≈ 2w` — because the two extreme corners sit on opposite sides
of the diagonal. A 5 × 1 mile lake would have rendered as **"5 × 2 miles"**, plausibly.

Replaced with the **minimum-area bounding rectangle** — the same rotating-calipers sweep, exact for a
rectangle and major × minor for an ellipse. Lake Champlain now measures **106.3 × 14.8 mi** against a
published ~107 × 14.

*(The dimension line was then dropped from the caption entirely at the founder's ask — but the axis
still feeds the wind clause, the D2 prominence terms and A5's deciles, so the fix stands.)*

### 2. `waterBodies.centroid` is not a centroid, and the fetch profile was cast from the shore

A4 says *"cast a ray through the centroid"*. **That cannot be taken literally.** `centroid` comes from
`representativePoint` → Turf's `pointOnFeature`, which returns the bbox centre only when it lands
inside the polygon and a point on the **boundary** when it does not — true of any curved or narrow
lake. Measured: **Lake Willoughby's stored centroid is ring vertex 199**, and Lake Champlain's sits
**30.7 km** from mid-lake.

Nothing upstream catches this because `pointInPolygon` counts a boundary point as inside, and it was
harmless for every prior consumer. Here it was fatal: **7 of Willoughby's 16 bearings and 8 of
Champlain's came back 0.0**, because a ray cast north from a west-shore vertex correctly finds no
water.

The fetch profile now derives its own origin (`fetchOrigin`), and a supplied origin is honoured only
if it is *strictly* interior, so passing the stored centroid can never silently reproduce the bug.

**Founder call on the wider fix:** `centroid` itself is **left alone** — drive-time bands
(`notifications.ts`, `reports.ts`) and the pin-less report's town stamp all want a shoreline-ish
point, and put-ins are *not* used for drive-time today (checked). A new optional **`interiorPoint`**
is stored instead, and only `lib/sampling.ts` reads it, because weather sampling was the one consumer
the offset genuinely hurt: Open-Meteo's grid is 2–25 km and Champlain's 30.7 km error is one to
several cells wrong on an input the D56 decay math must be reproducible from.

### 3. Fetch alone names the wrong wind direction — **D90**

The caption first said Willoughby is *"most open to wind out of the south-southeast"* on fetch alone.
**Founder:** *"I am almost certain Lake Willoughby never gets wind out of the south… the terrain
(mountains) around lakes drastically impact the chance that wind could come from particular
directions."*

Measured against NREL's WIND Toolkit (2 km WRF, Dec–Mar): **19.4% SE, 16.1% SSE, 18.6% NW** — a
strongly **bimodal rose along the NNW–SSE trough**, with the E/NE quadrant blocked by Pisgah and Hor.
So the specific prediction was wrong and the *reasoning* was exactly right: terrain dominates, and it
funnels wind **along** the valley rather than excluding half of it.

Exposure is therefore the **product**, `winterFrequency[k] × fetchM[k]` (**D90**), and the caption
says nothing about wind without a rose — there is deliberately no fallback to fetch-alone, because
that fallback *is* the claim the rose exists to stop making.

**Source: NREL WIND Toolkit, not the Global Wind Atlas.** GWA resolves 250 m and would see more
terrain, but publishes **no documented public API**. WTK also gives what GWA cannot: hourly data, so
the rose is **winter only** rather than annual. Its host moved from `developer.nrel.gov` (now dead)
to `developer.nlr.gov` — hence `WIND_TOOLKIT_API_KEY`, named for the dataset rather than the provider.

### 4. D2's weights were off by an order of magnitude

The D2 table proposes +1 for a name, +2 for contours, +4 for an official put-in — summing to **+13**.
But `displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, and `minVisibleZoom` clamps the
total to `[0,1]`. **Every curated boost on dev is exactly 0.3**, and boosted bodies score 0.75–1.30.
A `+1` for a name would have pushed all ~9,000 named bodies to the widest zoom bucket — and the map
would have read as broken with every test still green.

Rescaled to the real range, with the plan's relative ordering intact and **activity dominant**
(founder call: curation should be *"only a seed, and a check on our automated system"*), so a used
lake out-ranks a hand-seeded one. Plus `curatedBoostIsRedundant`, the retirement signal — advisory,
never automatic, because a check that removes itself is not a check.

### 5. The caption's units contradicted D25

This doc's illustrative caption reads *"1,688 acres, about 5 × 1 miles… a measured 91 m maximum
depth… Its 8 km axis"*, and A3 says *"Metric per D25: nearest kilometre"*. **D25 says store metric,
*display imperial*, and there is no metric display mode in this product.** The caption is imperial
throughout.

### 6. `hasContours` has no data behind it

D2's `+2 has bathymetric contours` assumes contour coverage is queryable. It is not:
`waterBodies.matchBathymetryLakes` is a read-only `internalQuery` that stores nothing, and no field on
the row records it. The term exists in code and **ships dark**; persisting the ~2,437 N6b matches is
roughly thirty lines, deferred by founder call.

### The run order, which is not optional

`richnessFor` costs two index reads per body, so it runs in `backfillCells` and **not** in
`importCanonical`, which already does the heaviest work in the app. A canonical re-import therefore
*resets* the score to area + boost until the re-score runs. The order is:

1. **canonical water re-import** — geometry + the A2/A3/A4 stats + `interiorPoint`
2. **depth + elevation run** — the N6a loader, now carrying `elevationM`
3. **`regionStats:recompute`** — deciles derived *from* what the first two loaded
4. **`wind-climate load`** — needs `fetchProfileM` from step 1 to know which bodies qualify
5. …then everything **N6c-2** gathers (N6d put-ins if they land in the same window, the
   `hasContours` flag if it gets persisted, the B3a seed boosts)
6. **`backfillCells` — ONE re-score pass, at the very end of N6c as a whole** (founder call,
   2026-08-02: *"once we've gathered as much data as we can on every body during this phase N6c
   (either part 1 or 2, whichever makes sense), let's do a single re-score pass"*)

A test fails if step 1 stops clobbering richness, so the constraint cannot drift silently.

> **The re-score is deliberately NOT run at the end of N6c-1.** It walks all 116,070 bodies,
> recomputes `displayScore` and rebuilds every cell row in the N1 index, and running it twice would
> be the mistake D2 was folded into this phase to avoid in the first place. The cost of waiting is
> that **profile richness does not affect the map until N6c-2's data has landed** — prominence stays
> exactly as it is today until then, which is the safe direction, since richness is a boost and its
> absence is simply the status quo.
>
> The trap this creates, worth naming: after steps 1–4 the corpus will *have* depth, elevation and
> stats while `displayScore` still reflects only area + boost. That looks like the D2 term is broken.
> It isn't — it is waiting.

---

## Why this phase exists

N6a gave every lake a mean and max depth with honest per-measurement provenance. What it did not do is
tell a skater what those numbers *mean*. Today the drawer shows two figures and a source caption, and a
skater deciding where to drive on the first cold weekend in December gets no help from them.

This phase closes that gap, and picks up a cluster of related lake-page gaps that have gone unaddressed
since Phase 2: we know where a lake *is*, but almost nothing about its shape, its exposure to wind, its
elevation, or where else a skater could go to learn about it.

One governing rule shapes every scoping call below:

> **P1 (D70) — Derived or third-party, never hand-maintained.**
> Every field in this phase must come from geometry we already store, an ETL source, a user report, or
> a URL template. Hand-written per-lake prose and hand-maintained per-lake notes are **out of scope**:
> they go stale silently, nobody notices, and they do not scale past the handful of bodies someone
> cares enough to write about. We have **116,070**.

A hand-curated regional atlas is a genuinely useful artifact — and it is also the kind of artifact that
stops being updated after one winter, because the maintenance cost lands on one person every season.
Ours has to survive nobody feeling like writing anything.

A corollary that shapes Workstream B in particular:

> **P2 (D71) — A link is not an integration.**
> A URL template computed from `(centroid, name, states)` costs no storage, no quota, no license and
> no legal review, and it covers all 116,070 bodies the day it ships. Reach for the link first and the
> integration only when the link demonstrably isn't enough.

---

## Workstream A — Derived geometry stats

Everything here is computed from data we already have or a single free lookup. Nothing here needs a
human.

### A1 — Elevation *(the time-sensitive one)*

**Why it matters.** Elevation is a real freeze-*order* signal in the Northeast, and an underrated one.
A 1,700 ft pond in the Greens is skateable weeks before a valley lake twenty minutes away, and skaters
already reason this way informally. It is also the cheapest signal in this whole phase.

**Source.** The **Open-Meteo Elevation API** (`api.open-meteo.com/v1/elevation`) — same vendor as our
Phase 10 weather integration, no API key, batched coordinates per call. It serves the Copernicus GLO-90
DEM (90 m), far finer than we need for a lake centroid.

At ~100 coordinates per request, 116,070 centroids is on the order of **~1,200 requests** — minutes of
wall clock, no cost. *(Confirm the current batch limit and rate policy against the live docs at build
time; the pass should chunk defensively and be resumable regardless.)*

**Schema.** `waterBodies.elevationM: v.optional(v.number())` plus
`elevationSource: v.optional(literals(ELEVATION_SOURCES))` — `operator` | `dem_glo90`, following N6a's
precedence discipline exactly: an operator value wins, and the loader refuses to overwrite it. All
optional ⇒ migration-free, and `importCanonical` patches an explicit field list so elevation survives a
canonical re-import untouched, same as depth.

**Why one source and not a ladder.** Depth needed a five-rung ladder because measured bathymetry is
scarce and wildly uneven in quality. Elevation is not scarce — a 90 m global DEM is accurate to a few
metres at a lake surface, far inside the precision this signal needs. A ladder here would be ceremony.

### A2 — Long axis: length, bearing, and a dimension line

**Compute:** rotating calipers over the convex hull of the stored polygon → the hull diameter (longest
chord between hull vertices), giving `longAxisM` and `longAxisBearingDeg` (0–180°, undirected — an axis
has no head). The perpendicular hull width gives `shortAxisM`, which yields a familiar
"5 × 1 miles"-style dimension line.

**Where:** `@skating/core` (new `lakeGeometry.ts`). Pure, framework-free, unit-testable, no external
call. Runs in the ETL transform alongside `surfaceAreaSqM`, already computed there from the *simplified*
geometry (`scripts/etl/src/transform.ts`).

**Value on its own is modest** — we already show surface area, and this is the least important item in
Workstream A. It earns its place because **A4 needs the axis anyway**, so the dimension line is a free
by-product.

### A3 — Shoreline length: measure the source geometry, not our copy of it (D85)

> **Founder, 2026-07-31:** *"Is there another source we could use to get the perimeter length? I'm open to
> rounding to the nearest mile, or even up to the next whole mile, to be easy. But maybe we're looking at
> the wrong source for this."*

**The instinct is right, and the better source turns out to be one we already have.** We were not looking
at the wrong *provider* — we were measuring the wrong *copy of our own data*.

**The original problem.** Perimeter is resolution-dependent (the coastline paradox), and the polygon we
store is Douglas–Peucker-simplified to ~5 m (`SIMPLIFY_TOLERANCE_DEG` in `scripts/etl/src/transform.ts`),
with Lake Champlain coarsened further to fit Convex's 8,192-element array cap. Measuring the stored
polygon yields *"shoreline at ~5 m fidelity"* — systematically short, and worst on exactly the big
crenellated lakes where the number is most interesting.

**The fix: measure before we simplify.** The ETL transform holds the full-resolution OSM geometry
immediately before `simplify()` runs. Perimeter computed *there* and stored as a scalar has none of the
simplification error, costs no storage beyond one number, and needs no new download, no new licence and
no new join. The Champlain array cap is irrelevant to a scalar — that cap constrains what we can *store
as geometry*, not what we can *measure in flight*.

> **D85 — Derived geometry stats are computed from the source geometry at ETL time, not from the
> simplified copy we store.**
> Applies to `shorelineM` and to A2's long/short axis. The stored polygon exists for *drawing*; the
> stats exist for *describing*, and the tolerance that makes the first cheap corrupts the second.

**This changes the sequencing.** A2–A4 now ride the **canonical water re-import** (`scripts/etl`), not the
N6a depth run — two different passes with different cargo. Recorded in
[N6a's ordering gate](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate) so nobody expects
one run to deliver both.

**A cross-check that rides the depth join for free.** [HydroLAKES](https://www.hydrosheds.org/products/hydrolakes)
carries **`Shore_len`** — shoreline length in km, computed from its own polygon — and we are already
downloading and joining HydroLAKES for N6a's depth rung 3. So the depth loader can carry a second opinion
at zero marginal cost. Two caveats keep it a *check* rather than a *source*:
- **HydroLAKES' floor is 10 ha**, which N6a measured as ~**7%** of our corpus. It cannot cover the long
  tail, and a stat that exists only on big lakes is worse than one that exists everywhere.
- **Its polygon is a different water mask at a different date and its own resolution**, so a disagreement
  doesn't tell us which is right. What it *does* tell us is whether our number is in the right
  neighbourhood — a 2× gap on a well-known lake means the join or the ring handling is wrong, and that is
  worth finding at load time rather than in a screenshot. **Log the comparison; store ours.**

*(LAGOS-US also publishes a lake perimeter and would be a third opinion on the same terms. Not worth a
separate download for a cross-check we already get from a file we're fetching anyway — noted only so the
option isn't rediscovered.)*

**Rounding: nearest whole mile** (founder call — *"even up to the next whole mile, to be easy"*). Taking
the softer of the two offers, because rounding *up* systematically overstates and a shoreline figure is
one a skater might use to judge how long a lap takes. Nearest-mile with an *about* is honest in both
directions:

- Under 1 mile: *"under a mile of shoreline"* — no decimal, no false precision on a farm pond.
- Otherwise: *"about 11 miles of shoreline"*.
- Metric per D25: nearest kilometre, same framing.

**Even measured at source, never present it as authoritative.** Source-resolution perimeter is a real
improvement over simplified-copy perimeter, but OSM's shoreline is still a tracing, drawn by different
mappers at different zooms from different imagery, and it still won't equal a published survey figure.
Same honesty problem N6a solved for modelled depth, same treatment: the framing carries the uncertainty.
This is D3-adjacent and worth stating plainly, because a shoreline number *looks* like a hard fact in a
way a modelled depth does not — which makes it more dangerous, not less.

### A4 — Directional fetch profile *(the interesting one)*

**Wind fetch** is the distance wind travels over open water before reaching a point. It is one of the
main determinants of whether a lake sets smooth black ice or gets chopped and wind-slabbed, and of where
pressure ridges tend to form. Skaters already reason about it — *"the north end will be rough today"* —
and we currently have nothing to say about it, despite holding every polygon needed to compute it.

**Design — precompute, don't compute at read time.** At ETL, for each body: cast a ray through the
centroid at 16 compass bearings (22.5° steps), take the **contiguous over-water run containing the
centroid**, and store its length. Result: `fetchProfileM: v.optional(v.array(v.number()))` — 16 numbers
per body, trivially small.

At read time the drawer already has today's wind bearing from the Phase 10 weather fetch. It picks the
nearest bucket and can say: *"Wind out of the northwest today, across about 6.4 km of open water."* Zero
geometry at read time, zero extra reads.

**Deliberate limitations, to be stated in the code comment so nobody "fixes" them later:**
- It is a **centroid** profile, not per-point. Fetch genuinely varies across a large lake; a centroid
  figure characterizes the whole body, and the copy must not imply otherwise.
- The **contiguous run** rule handles islands and concave shorelines honestly: if an island interrupts
  the ray 800 m out, the fetch is 800 m, not the full chord. Summing water segments across an island
  would overstate exposure, which is the wrong direction to be wrong in.
- MultiPolygon bodies use the sub-polygon containing the centroid.
- **Sub-areas (N2) should eventually get their own profiles** — a named bay is exactly the scale at
  which per-point fetch starts to matter. Deferred within this phase; the field shape already supports
  it, since sub-areas carry their own geometry.
- **Rivers would produce nonsense.** Still deferred (D4), and one more reason the still-water assumption
  belongs in the function contract.

### A5 — `regionStats`: the comparison basis

Workstream C wants to say things like *"among the deepest in Vermont."* That needs a corpus-relative
basis, and per-body percentiles are the wrong shape — they shift with every import and would need
116,070 rewrites to stay true.

Instead: **one row per state**, holding deciles for depth, elevation, surface area and long axis,
recomputed at the end of each state's import. Tiny, cheap, honest, re-derivable. Captions read the
deciles; bodies store nothing extra.

---

## Workstream B — Reference links

### The design call that makes this cover 116k bodies

The founder asked whether these links can be configured through the ETL for the whole corpus rather than
a curated few. **They can — by not storing them at all** (D71).

Every one of these links is a pure function of `(centroid, name, states[])`, all already on the row.
Generating them in a `referenceLinks.ts` module in `@skating/core` means:

- **Full coverage on day one**, including bodies imported later, with zero ETL work.
- **No stale URLs** — when a provider changes its query-param format we fix one function, not 116,070
  stored strings.
- **No storage, no migration.**

Storing 116,070 copies of a derivable string would be the expensive way to get a worse result. The
*only* thing that needs storage is the one link that genuinely isn't derivable (B7).

### B1 — Every external link opens **in-app** on mobile (D76)

Founder call: linking out is fine on desktop, but on mobile a skater should not be ejected into Safari
and left to find their way back.

**Mechanism: `expo-web-browser`'s `openBrowserAsync`** — SFSafariViewController on iOS, Chrome Custom
Tabs on Android. The page opens *over* our app with a Done button, shares the system cookie jar, and
returns the skater exactly where they were. One line at the call site, one dependency, and it covers
**every** link in this workstream uniformly — satellite, weather, community, lake association.

**Why not a `WebView`.** A `react-native-webview` would let us render a third-party page inside our own
chrome, which sounds better and is worse:
- **It frames someone else's site inside our UI**, which many providers' terms prohibit outright. An
  in-app browser is unambiguously *a browser* — the provider gets its own URL bar, its own branding, its
  own terms. There is no framing question to lose.
- It inherits their auth walls, cookie banners and consent flows with none of the system browser's
  handling for them.
- It is more code, more surface, and more to break.

**Rule to record:** a `WebView` is only for content we're licensed to embed (a provider's own documented
embed widget). Everything else goes through the in-app browser. Web stays a plain `target="_blank"`.

### B2 — Directions ✅ already built

`directionsUrl` (`packages/core/src/putIn.ts:144`) already emits Apple Maps on iOS and Google Maps
elsewhere, wired into `apps/web/src/components/DirectionsButton.tsx` and
`apps/mobile/src/components/FavoriteButton.tsx`. **No work here** — N6d re-targets it at parking areas.

*(Directions are the one deliberate exception to B1: a maps deep link should hand off to the real maps
app, which is where navigation belongs.)*

### B3 — Copernicus Browser — and the satellite blocker it retires

**The roadmap entry this closes.** [`07-roadmap.md`](./07-roadmap.md) has parked the satellite-imagery
layer as *"needs design — and it needs an imagery source whose terms permit the use."* That second half
is now answered: **Copernicus Sentinel data is under the free, full and open Copernicus licence** —
reproduce, distribute and adapt, with attribution. The terms question was the blocker; it is no longer
one.

**Ship in this phase: the deep link.** To `https://browser.dataspace.copernicus.eu/` with lat/lng/zoom
from the centroid, Sentinel-2 L2A true colour, and the time window pre-set to roughly the last 14 days.
Zero cost, zero quota, no license question, works today.

> ⚠️ **Verify the exact query-param shape against the live browser at build time.** This is the one link
> whose URL format we don't control, and it has changed before. Put it behind a single function with a
> test asserting the shape, and treat a 404 as a signal to re-check rather than a bug.

**Why Sentinel-2 is genuinely useful here, not just a neat toggle:** 10 m resolution, ~5-day revisit, and
at that scale the difference between open water, black ice and snow-covered ice is *visually obvious*.
Cloud cover is the real limiter — which is exactly why the link defaults to a two-week window rather
than a date.

**Sizing gate — 10 m pixels can't resolve a small pond.** A 2-hectare pond is a handful of pixels; the
link would open on a smear. So the availability of the imagery link is **derived from surface area**, not
hand-curated:

```
satelliteImagery: 'auto' | 'on' | 'off'   // default 'auto'
```

`auto` resolves against a `SATELLITE_MIN_AREA_SQM` threshold in `@skating/core`; `on`/`off` are operator
overrides. This is P1 applied to a feature flag: the default is derived for all 116,070 bodies, and the
manual control exists only for the exceptions.

**The admin control needs no redeploy** — worth being precise about, because Phase 7 established that
*constants stay in code and editing them means redeploying*. That posture is about **constants**.
`satelliteImagery` is **per-row data**, so it edits like any other field through the N2 lake editor /
Phase 7 admin surface and takes effect immediately. Both halves of the founder's question resolve the
same way: the dashboard toggle works, *and* the threshold driving `auto` is a code constant that would
need a deploy to change.

**The proving run (B3a).** Founder ask: prove the pipeline now against the lakes that already surfaced in
research, rather than waiting for general traffic.

- Assemble a seed list of the regional Nordic-skating destinations already identified — the
  most-discussed bodies from the scraped community corpus, plus the well-known regional destinations
  from the atlas survey (~35–40 across VT/NH to start).
- A script (**`scripts/seed-satellite/`** — renamed from `seed-destinations` at the founder's ask,
  2026-07-31: *"then in the future we can expand this beyond just the lake shortlist"*) matches each to a
  `waterBodies` row by name + state + centroid proximity, **reports ambiguous matches for a human rather
  than guessing**, sets `curatedBoost` (Workstream D), and **verifies the generated Copernicus URL
  resolves for each**.

  *The rename is worth the thirty seconds it costs.* `seed-destinations` names the **input** — a list of
  lakes — which is the thing most likely to change. `seed-satellite` names the **job**: prove and
  provision the imagery path. When the shortlist grows into a region, or a second cohort, or the tile
  pre-warm list [N6e](./phase-N6e-satellite-imagery.md) will want, the script keeps its name and only its
  input file changes. A script named after its first dataset is a script somebody forks instead of
  extends.
- Ship with a README documenting how to re-run it — same posture as the other `scripts/` tools.
- **What this proves:** that the URL shape is right, that name-matching against a 116k corpus works, and
  that the imagery is actually legible at these bodies' sizes. All three are cheaper to learn now than
  after we've built the in-app tier on top of them.

**Imagery *in* the app → [N6e](./phase-N6e-satellite-imagery.md), specced 2026-07-31 at the founder's
ask** (*"I don't want to lose track of this, because I want to do it ASAP"*).

**Does it fit inside B3?** No — and the reason is worth one paragraph, because "it's just a raster layer"
is a very reasonable thing to think. In-app imagery is a **basemap swap**: a second style branch on both
clients, a toggle whose state has to persist, an offline story, a tile-caching service, an attribution
change, and an interaction with every layer already on the map. B3's deep link is a URL. Bundling them
would put a map-engine change inside a phase whose other four workstreams are strings and numbers.

**What N6e found that changes the shape of the ask:** the quota problem below applies to *one* of two
imagery tiers, and the tier that answers *"is this the right dirt road, where's the point, where's the
island"* is **public-domain USDA/USGS aerial imagery** with no quota at all. Sentinel-2's quota only
binds the *recent-ice* tier. So the toggle the founder asked for is buildable now and the constrained
half stays scoped to where it's actually needed. Full treatment in N6e; **D84**.

**The Sentinel-2 quota, recorded here because B3's link lives in this phase.** The Copernicus Data Space
exposes Sentinel Hub–compatible OGC/Process APIs on a free tier of **10,000 requests + 10,000 processing
units per month, 300/min**. A full-screen tile view is roughly 10–20 requests, so raw that's only
~500–1,000 lake views per month — not enough for general use.

It becomes viable with **server-side tile caching**, which the open licence permits: popular bodies get
viewed many times but only need fetching once per satellite revisit (~5 days). That turns the quota from
a per-view cost into a per-lake-per-week cost, which comfortably fits. **The gate is knowing which
handful of bodies get real traffic** — caching only wins if reads concentrate, and right now we're
guessing that they do. B3a's proving run is what starts producing that evidence, which is why
`seed-satellite` is now named after the job rather than the list.

Full cost/benefit for Copernicus and Planet lives in
[`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md).

### B4 — Weather links: Windy

**Windy is a link, not an integration — but on mobile it's an in-app link (B1).** Confirmed against their
docs: the Map Forecast API is *"a simple-to-use library based on Leaflet 1.4.x"* and tightly coupled to
it. We render **MapLibre**. There is no way to add Windy's animated layers to our map — using their
product means embedding *their map* wholesale, not extending ours.

So: `windy.com/?<lat>,<lng>,<zoom>` opened through `openBrowserAsync`. On mobile that already achieves
what the founder asked for — Windy's animation, over our app, with a Done button. It costs one line and
€0/year, versus €990/year and a second map engine for the API route.

Cost, tiers and the future-integration case are documented in
[`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md).

### B5 — Weather data: NWS alerts ✅ **in scope** (D74)

Founder call, 2026-07-30: build it.

**`api.weather.gov` is free, needs no API key, and is US-only.** It does **not** replace Open-Meteo:
Open-Meteo's `past_days` history is the input to the D56 decay math, and NWS has no comparable history
endpoint. What NWS uniquely has is **official alerts** — winter storm warnings, ice storm warnings, wind
chill advisories — issued by the local forecast office.

> **D74 — one weather physics source, plus a separate advisory layer.**
> Open-Meteo stays the single source for anything that feeds a calculation. **Do not blend.** Two
> providers disagreeing produces a *worse* number, not a better one, and it would silently break the
> reproducibility of the decay math, which depends on one deterministic input.
> NWS alerts render as a clearly-labelled advisory strip that **never feeds a calculation**.

**Shape:**
- Poll `/alerts/active?area={state}` per state we cover (5 states — a handful of calls), on a cron,
  cached. **Not** per-body-per-view: alerts are issued over counties/zones, so one state-level fetch
  serves every body in it, and the read cost stays independent of corpus size (the `listInViewport`
  lesson, applied before it can bite).
- Map alerts → bodies via the `states[]` field for v1. Zone-level (county) precision is a refinement, not
  a v1 requirement — a winter storm warning is rarely so local that state-level misleads, and
  over-showing a weather warning is the safe direction to err.
- Render on the lake drawer above the weather-since strip, visually distinct from our own content and
  attributed to the NWS.
- **A `User-Agent` header identifying the app is required** by their terms; rate limits are unpublished
  and a 429 should be retried after ~5s. Their documentation warns an API key may be required in future —
  worth a comment at the call site so it isn't a surprise.

**Coverage gap to record:** US-only. A future Québec expansion needs Environment Canada, a different API
with different terms.

### B5b — A short forward forecast, for the drive decision ✅ **in scope, and cheaper than expected**

> **Founder, 2026-07-31:** *"It would be cool to show a few hours' forecast in-app for a given lake, not
> just official alerts. That way if someone's going to drive 90 minutes they could see in-app if it's
> going to be snowing by the time they get there so they shouldn't bother."*

**It fits here, and the reason it fits is that we are already fetching this data and throwing it away.**

`packages/convex/convex/weather.ts:112` sends `forecast_days: '1'` to the Open-Meteo forecast endpoint —
present so the series includes today's already-elapsed hours — and then the window filter trims
everything after `nowMs`. **The forward hours arrive in the response and are discarded.** So a few hours
of forecast costs:

- **No new provider.** Same endpoint, same call, same `HOURLY_VARS`, same attribution. **D74 holds
  untouched**: this is still Open-Meteo, still the one physics source, and there is no second opinion to
  blend.
- **No new quota.** One parameter changes (`forecast_days: '2'`, so the window survives a day boundary
  and an evening skater still sees tomorrow morning) and the trim keeps a forward slice instead of
  dropping it.
- **No new cache.** It rides the existing conditions/weather fetch on drawer-open.

**Why it's genuinely the right feature and not just a cheap one.** The 90-minute drive *is* the product's
core decision — it's why Phase 4 built drive-time bands at all — and a report is necessarily about the
past. A skater reading *"great ice, 2 hours ago"* and a forecast of snow starting at 3pm has everything
they need; either half alone leaves them guessing. This is the same insight as the weather-since strip
(*what has happened to this ice since the report*), pointed the other way in time: **what will happen to
it before I arrive**.

**The D3 line, and it is a real one.** A forecast of *weather* is not a forecast of *ice*. Open-Meteo
saying 2 cm of snow at 3pm is a third-party meteorological forecast, attributed to them, and we may
render it. *"The ice will be unskateable by the time you arrive"* is a prediction about conditions, which
D3 says is not ours to make — and the temptation to write that sentence will be strongest here, because
it is exactly the sentence the founder's scenario describes a skater *thinking*. **Let them think it.**
We show snow starting at 3pm and their drive time; the inference is theirs, and it is a good one.

**Shape:**
- **Where:** the lake drawer, immediately after the weather-since strip, so the two read as one timeline —
  *what happened* then *what's coming*. Same component family, mirrored.
- **Horizon:** ~12 hours, which covers a decision made in the morning about an afternoon session and a
  decision made in the evening about tomorrow morning. Beyond that the forecast degrades and the strip
  gets long.
- **Variables:** the ones that change whether you go — temperature, snowfall, precipitation, wind. Not the
  full `HOURLY_VARS` set; the decay math's inputs and the skater's inputs are different lists that happen
  to overlap.
- **Ordering:** it renders *below* the NWS alert strip (B5), because an official warning outranks an
  hourly forecast, and *below* the weather-since strip, because observed beats predicted.
- **It never feeds a calculation.** Same rule as NWS alerts under D74, for a different reason: decay math
  runs on what happened, and a hazard whose confidence decayed on a forecast that didn't come true would
  be unreproducible after the fact.

### B6 — Regional community search link

Founder ✅, framed as *a bridge to future ingestion* — something to tide skaters over until they switch.

Derive from `states[]`: a small state → community map in code, plus a search-URL template carrying the
body name. Full list in [Appendix B](#appendix-b--regional-communities).

**This sits entirely outside the Q8/L5 legal gate.** That gate is about *ingestion and republication* —
consent, ToS, copyright. A link is none of those: we store nothing, republish nothing, and the skater
arrives at the community's own site under the community's own terms. It is the 5% of the ingestion
feature that carries 0% of the risk.

Store nothing per body; the state is already on the row.

### B7 — Local lake associations — the one thing that gets stored

Founder ✅. Genuinely non-derivable: there is no algorithm from a lake's name to its association's URL.

So it gets the phase's only new link storage: `referenceLinks: v.optional(v.array(...))` on
`waterBodies` — `{ label, url }` pairs, operator-editable through the N2 lake editor, preserved across
re-import like `curatedBoost`.

Expect this populated for **tens** of bodies, not thousands. That's correct, not a failure: it is the
exception that proves P2's rule, which is why it's the only field of its kind here.

---

## Workstream C — The derived caption

Workstream A's payoff: one or two sentences per lake, generated from our own numbers, telling a skater
what the stats *mean*.

**Rules, all load-bearing:**

1. **Generated, never written.** Assembled in `@skating/core` from stored stats + `regionStats` deciles,
   so web and mobile render identically and the whole thing is unit-testable. No per-lake text exists
   anywhere in the system to go stale, and nothing is adapted from anyone else's write-ups — the prose is
   ours because the template is ours.
2. **Physics and history only. Never prediction (D3).** *"Deep lakes lose heat slowly and typically
   freeze weeks after nearby shallow ponds"* is ours to say. *"This will be frozen by mid-January"* is
   not. The line between them is the one hazard decay had to walk, and it needs the same care here — a
   caption feels casual in a way that invites over-claiming.
3. **Every clause traces to a stored number, and every clause is optional.** No depth ⇒ no depth clause.
   Most of the 116k will render a one-clause caption or none. That is the correct outcome, not a coverage
   failure to paper over.
4. **Provenance discipline carries through from N6a.** A modelled depth's clause must read as an
   estimate. If the number is a 90 m-DEM guess, the sentence built on it cannot sound like a
   depth-sounder transect.

**Shape:** `[size] [depth → freeze-timing tendency] [elevation → relative freeze order] [fetch → wind
exposure tendency]`, each independently omittable.

**Illustrative output** (generated, not written):

> 1,688 acres, about 5 × 1 miles. At a measured 91 m maximum depth it is among the deepest in Vermont —
> deep water holds heat, and lakes like this typically freeze well after nearby shallow ponds. Its 8 km
> axis runs NNE–SSW, leaving it exposed to northerly wind.

Every clause there is a lookup plus a threshold. None of it needs a person.

---

## Workstream D — Curated boost for known destinations

**Founder call: no new flag.** Use `curatedBoost`. The reasoning is worth recording: a separate
`isDestination` boolean *and* a `curatedBoost` number would be two knobs expressing one idea, and within
a season nobody would remember which governs what. One concept, one maintenance surface.

**Task:** the seed list and matching script from B3a set the boosts through the existing Phase 7 admin
path. Same script, two outputs — which is why they're specified together.

**Cross-check the two source lists against each other.** Where the scraped community corpus's
most-discussed bodies and the surveyed regional destinations *agree*, we have high confidence. Where they
**disagree** is the interesting part: a spot the community talks about constantly that no atlas lists is
a discovery signal; a listed spot nobody discusses may be listed for scenery rather than ice.

**Long-term:** D49 already plans for popularity to feed `displayScore` once we have our own report
volume. These manual boosts are a **cold-start seed with a retirement path**, not a permanent registry —
another argument against giving them their own flag.

---

## Workstream D2 — Profile richness feeds prominence (founder call, 2026-08-01)

> *"Maybe we just really deprioritize any water bodies for which we don't have bathymetry, put-ins,
> etc? Like having more **kinds** of body profile data should maybe automatically boost prominence on
> the map, in a similar way to how we boosted the visibility of lakes that appear in our training
> corpus."*

Filed here rather than in its own phase for the reason the founder gave: **this rides the ETL pass
N6c is already making.** A `displayScore` change means recomputing `minVisibleZoom` across all
116,070 bodies and rebuilding the N1 cell index, and doing that twice would be the mistake.

### The question it answers, and the one it doesn't

The founder's starting instinct was to consider **dropping unnamed bodies** — the map feels crowded,
and a lot of what's stored will never be skated. Measured against the corpus (8,000-body sample,
2026-08-01), that turns out to be the wrong lever:

| Prominence | Named | Unnamed |
| --- | --- | --- |
| **z ≤ 10** (regional browse) | 201 | 122 |
| z 11–12 | 305 | 2,746 |
| z 13+ | 33 | 4,593 |

**92% of the corpus is unnamed**, so "drop unnamed bodies" is very nearly "drop the corpus." And D49
is *already* doing the filtering: at regional zoom the split is 62% named, and named bodies average
**529,301 m²** against unnamed **13,986 m²** — 38× larger. The crowding at z13+ is unnamed ponds you
only see zoomed right in, which is arguably correct behaviour rather than a bug.

So the answer is not subtraction. It is that **prominence should reward how much we know about a
body**, which is additive, reversible, and self-correcting: a pond nobody has documented stays quiet
until someone documents it, and then it surfaces. It also makes the map reward contribution, which is
the behaviour this product wants most.

### The shape

Additional `displayScore` terms, weighted by how much each signal says about whether a body is worth
a skater's attention:

| Signal | Weight | Why this weight |
| --- | --- | --- |
| Has a real name | **+1** | Weak but real: someone cared enough to name it. Near-free, since it's already on the row. |
| Has bathymetric contours (N6b) | **+2** | A state surveyed it, which is itself a statement that the water matters. |
| Has a depth (N6a, any rung) | **+1** | Weaker than contours — most of it is modelled. |
| Has **derived** put-ins (N6d) | **+2** | Access exists and we found it. |
| Has **official/moderated** put-ins (N6d) | **+4** | A human confirmed you can get on the ice here. The strongest static signal we have. |
| Has hazards or reports on record | **+3** | Someone has actually been there — the only signal that is evidence of *use* rather than of data. |

Weights are illustrative and belong in the `@skating/core` "signs locked, numbers tunable" family
alongside the existing D49 constants, surfaced read-only on the Phase 7b tuning page.

### Three things to get right at build

**Reports and hazards are a different kind of signal from the rest**, and probably want to stay
separate rather than being one more term. Every other row is *static metadata we imported*; report
volume is *evidence of use*, and D49 already plans for popularity to feed `displayScore` once there's
enough of our own. Folding them together now risks a cold-start problem where the seeded corpus
permanently outranks anything a community actually discovers.

**This must not silently bury bodies.** Prominence is a *boost*, never a penalty: a body with no
profile data keeps exactly the `minVisibleZoom` it has today, and richer bodies rise past it. Framing
it as "deprioritize the empty ones" and implementing it as a subtraction would push already-obscure
ponds below the discoverability floor — and the founder's own stated worry, *"I'd hate to not have a
body someone cares about"*, is precisely the thing that would break.

**It interacts with `curatedBoost` (Workstream D above) and should not duplicate it.** The curated
seed is a cold-start hack with a retirement path; this is the durable mechanism meant to replace it.
Best read as: curated boosts are what we assert before we know anything, and profile richness is what
takes over once we do.

---

## Workstream E — Per-body summary cards on the map

**Moved into this phase by founder call, 2026-07-30**, from the roadmap's *Design sketches for deferred
items*, where it had sat since 2026-07-21 — *"it's about time we took care of that."* It belongs here
rather than anywhere else because this is the phase about **what we can say about a lake without opening
it**: A–C answer that from geometry and third-party data, and this answers it from our own reports.

**The ask.** At suitable zoom levels, surface a compact card or label over *unselected* bodies with the
at-a-glance basics, so the map stops being a field of anonymous polygons you must click one at a time.

### E1 — What goes on the card (founder call, 2026-07-30)

**Active report counts and types only.**

| On the card | |
|---|---|
| Lake name | already available |
| Recent report count | within a "recent" window (E4) |
| Active hazard types | the top few, as icons or short labels |

**Explicitly *not* on the card:** recurring / "potential hazard" advisories from
[N5c](./phase-N5c-hazard-memory.md). That was asked and answered at N5c's scoping: this surface sits
closest to the map, where D3 pressure is highest, and a history line rendered over an unselected polygon
is one step from reading as a live condition. Recorded there as worth revisiting — *"likely open water"*
or *"frequently pressure ridges off the eastern shore"* would genuinely help someone judge a lake with no
recent reports — but deliberately, later, and not inherited by default.

**A consensus quality signal ✅ is in — as a mark, not a word (D86, founder call 2026-07-31).** See
[open question 5](#5--the-consensus-quality-signal-ships-as-a-graded-mark-d86), which reverses this
doc's own recommendation to defer it.

### E2 — Denormalized on write, not aggregated on read

The shape from the original sketch stands, and **N1 changed the argument for it rather than against it**:
a viewport read is now bounded (the ladder grid replaced the geospatial component), so aggregating per
read is no longer a crash risk — just a cost proportional to bodies × reports on every map pan. The
denormalized shape still wins, and now it wins on cost rather than on survival.

**`waterBodies.summary`** — `{ recentReportCount, topHazardTypes[], latestReportAt, updatedAt }` —
maintained on write, generalizing the Phase 4 contribution-counter pattern
(`lib/contributionCounts.ts`). Bumped by `reports.create`, moderation transitions, and hazard
create/confirm/archive. Swept by a cron for time decay, because the counts are inherently time-windowed
and go stale without a tick.

### E3 — It renders nothing when there is nothing to say

The old deferral trigger was *"do this when there's enough report density that a summary is non-empty for
most bodies"* — otherwise it's a field of blank cards. **That trigger is retired by a design rule rather
than by waiting:** a body with no recent reports and no active hazards gets **no card at all**, not an
empty one. So the feature is harmless to ship into a sparse corpus — it simply shows up on the lakes
people are actually using, which is precisely the signal a browsing skater wants.

**Founder check, 2026-07-31:** *"The card would still show the body's name, right? If it has one. If it's
just 'Pond' and has no reports we probably shouldn't bother."*

**Yes — and that second sentence is the rule, stated more precisely than this section had it.** The name
is always on the card when there is a card. What the founder's phrasing adds is that **the name is not by
itself a reason to draw one**:

| Body | Card? |
|---|---|
| Named, has recent reports/hazards | **Yes** — name + counts + types |
| Unnamed *or* generically named, has recent reports/hazards | **Yes** — activity is the trigger, and a skater still needs to know *something is happening there*. Falls back to the map's existing label behaviour for the title. |
| Named, no recent activity | **No card.** A name alone is not news, and the basemap already labels prominent bodies. |
| Unnamed, no recent activity | **No card**, emphatically. |

So the trigger stays **activity**, not name — but the generic-name case the founder raises is worth a
build note, because "Pond" is not hypothetical: OSM's Northeast water layer is full of bodies named
literally `Pond`, `Mill Pond` and `Beaver Pond`, several within a few miles of each other. A card reading
just **Pond** is worse than no title at all — it looks like a bug and it's ambiguous even to a local.

**Two things follow:**
- **Disambiguate the way the Phase 5 feed card already does** — name plus town, which was chosen for
  exactly this reason. *"Beaver Pond · Marshfield"* is useful; *"Beaver Pond"* is not. Reuse that
  formatter rather than writing a second one, so the two surfaces can't drift.
- **A body with no name at all still gets its counts**, because the card's job on an unnamed body is to
  say *someone skated here* — which is arguably more valuable there than on a lake everyone knows.

### E4 — The sub-questions to settle at build

- **What "recent" means.** Probably the same freshness window the feed and the report list already use,
  rather than a fourth number.
- **Rendering:** a MapLibre `symbol` layer with data-driven zoom filters, or HTML overlays? Symbol layers
  keep it inside the style and scale better; overlays are easier to make accessible and to style richly.
- **Interaction with `minVisibleZoom` / `displayScore` (D49).** Cards must not fight the existing
  prominence scoring — a lake suppressed at this zoom should not acquire a card that reintroduces it.
- **Season scoping (N5a).** The count is a current-season count; a card must never carry last winter's
  numbers into November. This is one line, and it is exactly the line that gets forgotten.

---

## Workstream F — Record history and import observability

*Added 2026-07-31 from the N6a review (founder call: fold it in here rather than into its own phase).
Both halves answer the same question — **what happened to this lake, and who or what did it** — and both
are cheap because the data already exists and is simply never read.*

**F1 — A per-lake activity timeline on `/admin/water/$id`.** Linear-style: a tight, blame-attributed
list at the bottom of the editor. **This is a UI component and no backend at all** —
`moderation.listActions` already takes `targetType: 'waterbody'` + `targetId`, reads `by_target` newest
first, and resolves the actor. Every human write to a body already lands there: depth, curated boost,
sample points, sub-area create/redraw/rename, put-ins, features. Nobody has ever been able to look at it,
which is why five mis-matched bodies from the Phase-2.5 seed stayed invisible until N2 built a screen.

Two gaps to close as part of F1, neither large:

- **Before *and* after.** An audit row records what a field *became*, so the log can answer "who changed
  this" and never "changed it from what". `setDepth` / `clearDepthOverride` already write a `prev` object
  into their metadata (N6a review); extending that convention to the other body mutations is a few lines
  each and is what makes an undo affordance possible later. Undo itself is **not** in scope — read the
  old value and re-enter it, which is one click short and zero new invariants.
- **ETL writes are unaudited**, so the timeline is human-only until F2.

**F2 — Store an ETL run summary instead of printing it.** Every loader we have (`etl`, `admin-areas`,
`lake-depth`) computes a genuinely useful summary — match rate, rejects by reason, un-gated matches,
overrides held, contested merges — and writes it to a terminal that scrolls. There is no way to answer
"how did the last import go", "is coverage better or worse than last time", or "which lakes did it
decline" without re-running it.

One row per run — source, target deployment, started/finished, the counts, and a bounded sample of
itemized rejects — written by the loader through an internal mutation. **Not one row per body**: an 8k-row
audit trail per run is a different feature with a different cost, and the per-body question is answered by
the depth provenance already stored on the row. An `/admin/imports` page then lists runs and drills into
one, which also gives F1's timeline its ETL half ("HydroLAKES filled this mean on 2026-08-12").

Sequencing note: F2 wants to exist **before** the N6a depth run, not after — the first real run is the
one whose numbers matter most, and it is also the run whose LAGOS-US findings (§5b of that runbook) want
a durable home.

## Out of scope / explicitly not doing

- **Hand-maintained per-lake prose** (D70) — replaced by Workstream C.
- **Per-body archival photos** (founder call) — the photos that matter come from reports and hazards.
  Access-point photos are N6d's business: infrastructure, not conditions.
- **Blending weather providers** (D74) — one physics source, deliberately.
- **In-app satellite imagery** — deferred with a stated trigger (B3), no longer *blocked*.
- **MerrySky** — a frontend over data we already have.
- **Rivers** — still deferred (D4). A2/A4 assume a still-water polygon and would produce meaningless
  output on a reach; the function contracts must say so.

---

## Sequencing — and the one time-sensitive item

> **A1 (elevation) should land before the N6a depth ETL is run.**

That loader is written and tested but **has not been run yet** — it's waiting on three third-party
downloads plus a licence/column confirmation. Elevation is a per-centroid lookup against a free
endpoint. Folding it into that same run costs one column; doing it afterwards costs a **second full pass
over 116,070 bodies**. This is the only hard ordering constraint in the phase, and it expires the moment
someone runs that loader.

Everything after is preference:

1. **A1** — before the depth run. ⏰
2. **A2–A4** — pure geometry, no external dependency, testable in isolation. **These ride a different
   pass** (D85): they're computed in `scripts/etl`'s transform from the pre-simplification geometry, so
   they need a **canonical water re-import**, not the depth run. Two passes, different cargo — the
   inventory is in [N6a's ordering gate](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate).
3. **A5 + C** — captions need the deciles; both are small once A is in.
4. **B** — link generation. Only B7 touches the schema. Fast, visible, high value-to-effort.
5. **B3a + D** — the proving run and the boosts, one script.
6. **B5 + B5b** — NWS alerts (the one genuinely new external integration here, separable from everything
   above) and the short forward forecast. **Do B5b first**: it is a parameter change and a slice on a
   call we already make, so it ships in an afternoon and it is the half a skater notices. The zone-stamp
   import (open question 2) is the long pole in B5 and shouldn't hold either back — the state rung
   covers v1 while it lands.
7. **E** — the summary cards. Independent of A–D (it reads our own reports, not derived geometry or
   third-party data), so it can run first, last or in parallel. The only ordering note is that its
   write-path counters touch `reports.create`, so it wants a quiet moment rather than the middle of
   another phase's changes there.

**N6d (access points) is independent of all of this** and can run in parallel or after.

---

## Open questions — all answered 2026-07-31

### 1 — Fetch profile at **16** bearings

> *"I agree with 16, but I'm open to 18 since that divides evenly into 360° if that is helpful in any
> way?"*

**16, and the divisibility intuition is right about the wrong number.** 18 does divide 360 evenly — into
20° steps — but so does 16, into **22.5°**. Every integer divisor of 360 divides it evenly; 16 just lands
on a fraction, and a fraction is not a problem for a float. There is no arithmetic anywhere in this
computation that prefers whole degrees.

**What 16 buys that 18 doesn't** is the reason to keep it: 16 bearings are the **compass points** —
N, NNE, NE, ENE, E … — which is both how weather APIs report wind direction and how skaters describe it.
Bucket *k* has a name, and the caption writes itself: *"exposed to northerly wind"* is a table lookup
rather than a rounding decision. At 18 the buckets are 20° apart and land on 20°, 40°, 60° — none of which
is a compass point, so every caption needs a second mapping from our buckets back to the names people
actually use, and that mapping is lossy in both directions.

The precision difference is negligible either way (11.25° vs 10° of worst-case angular error, against a
centroid-based figure whose real uncertainty is far larger — see A4's stated limitations). **Take the one
that speaks the same language as the wind data.**

### 2 — NWS alerts at **zone precision**, with state as the fallback rung

> *"I'd love to do zone precision for v1 if we can."*

**In for v1**, and the "if we can" is the right hedge, so here is what it actually takes.

The obstacle this doc named was *"a zone→body mapping we don't have."* That mapping is obtainable: NWS
publishes its forecast and county zones as **public geometry** (`/zones` on `api.weather.gov`, plus
downloadable shapefiles), so it is the same shape of work as the Phase 5 `adminAreas` import — polygons
in, point-in-polygon at ETL, a stamped id per body. We have built this exact thing once already.

**So the plan is a ladder, not a choice** — the same discipline as N6a's depth sources:

| Rung | Basis | When it applies |
|---|---|---|
| 1 | **Zone** — body stamped with its NWS forecast zone at ETL | Whenever the stamp exists |
| 2 | **State** — via the existing `states[]` field | Any body the zone import missed, and any state before its zone pass has run |

Rung 2 is the v1 fallback and it is **already specified and cheap**, so a slipping zone import cannot
block the feature — it just means some bodies over-show for a while, which was the acceptable v1
behaviour anyway. Build the state path first, then stamp zones; the alert-matching code reads whichever
rung is present.

**Two things that don't change:**
- **Polling is still per-state** (`/alerts/active?area={state}` — a handful of calls on a cron). Zone
  precision is about *matching* alerts to bodies, not about fetching more. The read cost stays independent
  of corpus size, which was the whole point.
- **Over-showing stays the safe direction.** When zone data is ambiguous or an alert covers a partial
  zone, show it. A skater seeing a warning that turns out to be for the next valley loses nothing.

**Confirm at build:** NWS alerts carry affected zones in `properties.affectedZones` as zone URIs, and
some alert types are issued by county (SAME/FIPS) rather than forecast zone. Handle both id spaces or the
match silently misses a class of alerts — the failure mode is invisible, since a missing warning looks
exactly like no warning.

### 3 — Elevation **blocks** the N6a ETL run ✅

> *"Definitely block N6a ETL run until we're ready for elevation."*

Recorded in N6a itself as a hard gate — see
[*§Before the ETL runs*](./phase-N6a-lake-depth.md#before-the-etl-runs--the-ordering-gate) — with the
escape hatch stated (run alone, accept a second pass) so the decision stays reversible under season
pressure rather than becoming a rule nobody can override. The founder's phrasing was *"until N6c is
complete,"* deliberately more conservative than *"until A1 is built,"* and N6a's gate carries the
inventory of what else wants to ride a pass.

### 4 — The seed list gets founder review before boosts are applied ✅

> *"Sure, I'm happy to look over the seed list first."*

So `scripts/seed-satellite` is **two commands, not one**: a `--dry-run` that emits the proposed matches
(and the ambiguous ones) as a reviewable file, and an apply step. This is the same shape as the other
`scripts/` tools' `--prod` guard — a human between the computation and the write — and it means the
ambiguous-match report has somewhere to be read rather than being a console warning that scrolls past.

**What review is actually for**, worth stating so the pass isn't perfunctory: not verifying that
"Lake Willoughby" matched a row called Lake Willoughby, but catching the two cases the script can't judge
— a destination that matched the *wrong* body of a similar name in the wrong town, and a destination
with **no** match, which is the interesting one. A well-known skating lake absent from a 116,070-body
corpus means either a naming mismatch or a genuine gap, and both are worth knowing before the boosts go
in. Log every unmatched entry by name; that list is short and it is a to-do.

### 5 — The consensus quality signal ships, as a **graded mark** (D86)

> *"I'm open to showing consensus quality signal on the cards! If everyone who writes a report says 'It's
> awesome' then I'd love to surface that. But maybe instead of writing the word 'Awesome' or 'Great' or
> whatever, we could show some kind of symbol or fill-bar or dots or something."*

**This reverses the recommendation above, and the founder's instinct closes the exact gap that made me
recommend deferring.** My objection was that *"a single word summarising how good the ice is here is a
safety claim wearing a summary's clothes."* That objection is about **words**, and the founder's answer
removes the words:

> **D86 — Aggregate quality renders as a graded mark, never as a word.**
> Three or four filled dots is legible at a glance and is unmistakably *a summary of what people said*.
> "Great" is a sentence the app appears to be asserting, on a surface where a skater is deciding whether
> to drive.

**Why the mark is safer than the word, precisely.** A word has a referent — "Great" is a claim *about the
ice*. A mark's referent is whatever the legend says it is, and we control the legend: **"how recent
reporters rated it."** The dots are a rendering of our own users' ratings, which is a fact about the
reports, and facts about reports are what E1 already established the card may carry. Same class of
content as the count next to it.

**The shape to build (first stab — finesse expected):**

- **Four dots, filled left-to-right** — enough resolution to distinguish "people liked it" from "people
  didn't," not enough to imply a measurement. A continuous fill bar reads as a gauge, and a gauge reads
  as an instrument reading; discrete dots read as a tally, which is what this is.
- **Derived from the existing thumbs**, not a new rating field. Phase 6 already built polymorphic thumbs
  on reports and hazards, and Phase 4's contribution counters are the pattern for maintaining the
  denominator. **No new user-facing input**, which is most of why this is small.
- **A quorum floor, and it is the load-bearing rule.** Below ~3 rating reports in the window: **no dots at
  all**, not a low score. One person's opinion rendered as a consensus mark is the single worst failure
  mode here, and it fails silently — the mark looks identical whether it summarises 1 report or 40. This
  is the same denominator discipline **D78** applied to recurrence claims, and it applies for the same
  reason.
- **Season-scoped and window-scoped** like the counts beside it (E4) — a mark that carries last winter's
  consensus into November is worse than no mark.
- **Never a fifth-dot ceiling effect.** If everyone loves everything, the mark stops discriminating.
  Watch this once there's real data; it may want to be relative to the corpus (the A5 `regionStats`
  pattern) rather than absolute.
- **Accessibility is not optional here.** Dots must carry a text alternative — *"rated 3 of 4 by 12
  recent reports"* — which is also, usefully, the honest long form: it names the denominator that the
  glanceable version omits.

**Still deferred, and now clearly separable:** the [N5c](./phase-N5c-hazard-memory.md) recurrence line
(*"frequently pressure ridges off the eastern shore"*). That one is deferred because it is **history
presented as a tendency**, which is a different and harder problem than aggregating explicit ratings. The
two were bundled as "the D3-sensitive half of this card"; the founder's mark-not-word answer separates
them, because a recurrence claim has no equivalent word-free rendering — its whole content is the claim.

---

## Where the tuning constants live

> **Founder, 2026-07-31:** *"If we can store these tuning constants somewhere in the admin dashboard that
> would be cool, but I'm also okay with requiring a redeploy."*

**Redeploy, and the Phase 7 posture holds unchanged** — but the answer splits cleanly in two, and the
split is what makes it easy to live with:

| | Where it lives | Changing it |
|---|---|---|
| **Constants** — `SATELLITE_MIN_AREA_SQM`, the fetch bearing count, the quality-mark quorum, the recency window, N6d's association radii | `@skating/core`, in code, with tests | **Redeploy.** Visible in the Phase 7b tuning control-room as read-only. |
| **Per-row data** — `satelliteImagery: 'auto'/'on'/'off'`, `curatedBoost`, operator depth, `referenceLinks` | The row | **Edit in the admin UI**, effective immediately |

**Why not move the constants.** Phase 7b built the control-room read-only on purpose: a constant in code
is version-controlled, reviewable, and **covered by tests that fail when it's wrong**. A constant in a
database row is a value someone changed at 11pm with no diff, no test and no record — on a product where
several of these constants feed safety math. The redeploy isn't friction to be removed; it's the review.

**What's already true and worth knowing:** the constants are *visible* in the tuning control-room today,
so the dashboard answers *"what is this set to?"* — which is the question you actually have most of the
time. Only *"change it right now"* requires a deploy, and none of these constants is one you'd want to
change in a hurry.

**The one class that could reasonably move later** is N6d's OSM association radii (the ~250 m parking
rule), because those want *iteration against real output* rather than judgement — the loop is
change-and-look, not change-and-reason. If that turns into a real annoyance during the ETL tuning pass,
the honest fix is a script flag, not a database row: the tuning happens at ETL time, where a CLI argument
is already the natural knob and the chosen value ends up in the runbook.

---

## Appendix A — Ice-science reading list

Recorded as a research asset for a future pass (founder ask: read these and see whether anything should
change our hazard taxonomy, decay signs, or freeze-timing copy). **In-app guides remain deferred** —
this is source material, not a feature.

| Work | Relevance to us |
|---|---|
| Michel, B. & Ramseier, R.O. (1971), *Classification of River and Lake Ice*, Canadian Geotechnical Journal | The academic taxonomy behind our **16 canonical hazard type keys**. Worth citing in [`docs/hazard-decay-and-lifecycle.md`](../docs/hazard-decay-and-lifecycle.md). |
| Ashton, G.D. (1989), *Thin Ice Growth*, Water Resources Research | Early-season growth rates — directly relevant to Workstream C's freeze-timing clauses and to D56 decay. |
| Gow, A.J., Ueda, H.T. & Ricard, J.A. (1978), *Flexural Strength of Ice on Temperate Lakes*, CRREL Report 78-9 | Load-bearing physics — the basis for any thickness guidance, and therefore for our decision **not** to give any. |
| Fransson, L. (2009), *Ice Handbook for Engineers* v1.2, Luleå University of Technology | General engineering reference. |
| Tsai, V.C. & Wettlaufer, J.S. (2007), *The Formation of Lake Stars*, Physical Review E | Radial melt patterns — a surface feature skaters see and may report. |
| Taberlet, N. & Plihon, N. (2021), *Sublimation-driven Morphogenesis of Zen Stones on Ice Surfaces*, PNAS | Sublimation and surface morphology. |

Plus the standing practical reference already cited throughout `plans/` — Bob Dill's lakeice site, still
the most useful single source for skater-facing ice behaviour.

> **Link, don't rehost.** The CRREL report is US-government work and freely distributable; the 2007 and
> 2021 journal papers are **not** ours to mirror.

---

## Appendix B — Regional communities

Recorded for three purposes with different timelines and different legal footing:

**(a) Outreach** — where the people we're building for already are; the list to work through when it's
time to pitch the app publicly.
**(b) Corpus candidates** — for vocabulary and training work. The Q8/L5 gate applies to **ingestion and
republication**, not to reading; the VT group already seeded our existing corpus.
**(c) Distribution via Strava** — the cheapest channel we have, and **already built**. Phase 8 pushes
activities to Strava; regional wild-ice Strava clubs are exactly where those land in front of exactly our
users. A skater who pushes a session into a regional club is doing our marketing.

| Region | Community | Platform | Notes |
|---|---|---|---|
| General | Nordic Ice Skating | Facebook | Moderately active |
| New England | New England Nordic Skaters | Facebook | Regional |
| New England | Wild Ice Vermont and New Hampshire | **Strava club** | Very active — the (c) target |
| Maine | Maine and NH Skating and Ice Report | Facebook | Reports + photos; also serves NH |
| Maine | Maine Wild Ice Skaters | **Strava club** | Active |
| New Hampshire | NHNordicSkating | Google Groups | Email archive, frequent |
| New York | ADKNordicSkating | Google Groups | Adirondacks |
| Vermont | VTNordicskating | Google Groups | Very active — **our existing scraped corpus** |
| Vermont | Vermont Nordic Skating | Facebook | Companion to the above |
| Québec | Patinage sur Glace Sauvage / Nordic Skating Québec | Facebook | Montréal; relevant only if we cross the border (note the NWS gap, B5) |

**B6's mapping uses this table:** VT → VTNordicskating, NH → NHNordicSkating, NY → ADKNordicSkating,
ME → the Maine/NH Facebook group. The Google Groups have searchable public archives, so they get a
*search* URL carrying the body name; Facebook groups get a plain group link, since their search is
neither stable nor reliably public.
