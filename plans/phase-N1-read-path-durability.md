# N1 — Read-path durability: the crash class

> **Status: in progress (started 2026-07-26).** The first item in the roadmap's *Next-phase
> candidates* register ([`07-roadmap.md`](./07-roadmap.md) → *Later / deferred* → N1), picked first
> because this is the map's front door and its failure mode is a **crash**, not a slowdown.

**Goal.** End the read-cap crash class on the water-body read path for good: replace the centroid
prefilter + two-tier large-body workaround with a spatial index whose reads are bounded **by
construction**, then apply the same discipline to every other query whose cost grows with the corpus.

Nothing here is a feature. A skater sees exactly one difference — more lakes at dense zoom — and
the operator sees a read path that stops needing to be re-tuned every time the corpus grows.

---

## What the roadmap's N1 entry got wrong

The entry was written from the Phase-6 sketch and had drifted. Corrections found while scoping
(2026-07-26), all verified against code:

1. **The stated fix isn't expressible in the component we're on.** N1 said "multi-cell /
   bbox-coverage **geospatial** indexing," implying a reconfiguration of `@convex-dev/geospatial`.
   But that component's entire write API is
   `insert(key, { latitude, longitude }, filterKeys, sortKey)` — **one point per unique key**
   (`dist/client/index.d.ts`, v0.2.1). There is no bbox, no multi-cell, no per-key cell set. So N1
   is not "configure the component differently"; it is **"stop using the component for water bodies
   and own the spatial index."**

   That distinction is also *why* the fix works. The component reads roughly ∝ `maxResults` because
   it walks an S2 covering internally; a plain Convex index range read costs only **the rows it
   returns**, and an empty cell costs ~nothing. The structural change is the fix — a bigger cap
   never was one.

2. **The trigger already fired, and the safety constants are stale.** `MAX_VIEWPORT_LIMIT = 256`
   was tuned against a measured "~320 crash edge" on the **9,967-body Vermont** corpus (PR #11,
   Phase 1). Phase 2.5 then loaded **~116k bodies** — NH 15,458 · ME 25,541 · MA 30,219 · NY 34,885
   plus VT's ~9,970 (`scripts/etl/README.md`, `phase-2.5-regional-expansion.md` §1). Nobody
   re-measured. The roadmap's own trigger ("do this when the corpus grows enough that the 256 clamp
   visibly drops bodies at normal zoom") fired **11.6× ago**; the register just didn't know it.

3. **A fifth unbounded `.collect()` sits in the hot path and wasn't listed.** `waterBodies.ts`
   collects the whole `by_is_large` index on **every** `listInViewport` call *and* every
   `listedBodiesNearCoord` (which Phase 8's track resolver uses). `isLarge` means bbox extent >
   0.05° (~5.5 km): 12 bodies in Vermont, plausibly several hundred across Maine/NY/NH. It may well
   be the larger real-world cost today, and the new index deletes it outright.

4. **Two of the four named `.collect()` sites were misfiled.**
   - `bounties.listOpen`'s `OPEN_BOUNTY_SCAN_CAP` **already logs what it dropped** — that bullet
     shipped with Phase 6 and the register never struck it.
   - `contradictions.findContradictingPriors` **does not exist**. The real site is
     `contradictions.contradictionCluster`, and it is worse than described: an unbounded
     report-window `collect()` *plus* a `pointEvents` `collect()` **per report** — an N+1 inside
     the loop.

5. **There was no verification story.** `convex-test` does not enforce Convex's 4,096-read cap, so
   no unit test can prove "this no longer crashes." Both prior bugs (PR #10, #11) were only found
   live on the dev deployment. Any N1 that ships on unit tests alone reproduces exactly the
   evidence gap that left `256` sitting unexamined through an 11.6× corpus growth.

A sixth item surfaced once `adminAreas` came into scope — see *Decision 2* below. It is a latent
**correctness** bug, not a performance one.

---

## Decisions taken at kickoff (2026-07-26)

**Decision 1 — Own the spatial index; retire `@convex-dev/geospatial` completely.**
Not just for `waterBodies` but for `adminAreas` too, so the app has **one** spatial mechanism
rather than two, and the component (plus its `convex.config.ts`, its typed-stub codegen branch, and
the `components as unknown as ConstructorParameters<…>` casts it forced) leaves the tree.
*Considered and rejected:* re-measuring and re-tuning the existing constants (half a day, honest
about the numbers, but the failure mode stays a crash and it needs redoing at the next corpus
growth).

**Decision 2 — `adminAreas` comes along, because it has the same bug with a worse symptom.**
`findContainingTown` queries town **centroids** within a ±0.2° rectangle, sized "to comfortably
contain a town's centroid from any interior point … our towns run well under 0.4° across." Across
the Phase-2.5 corpus that premise no longer holds: Adirondack towns (Long Lake, Newcomb, Arietta)
span well past 0.4°, and their own comment admits the failure is silent — "a town larger than this
margin can allow degrades to a county+state label." So a report from the middle of a big Adirondack
town **silently loses its town label** in the newsfeed today. A bbox-covering index removes the
premise entirely: an area is indexed in every cell its bbox covers, so containment is exact
regardless of size. Same change also kills the two unbounded `by_level` collects (county/state),
which grow with every state added.

**Decision 3 — the result limit becomes a render budget, raised to 1,000 and logged.**
Once reads are bounded by construction, the cap stops being a safety device and becomes a product
choice about how many polygons to hand MapLibre. Dense Maine/NY viewports at z13–14 exceed 256
today, so this is exactly where the corpus growth becomes visible to a skater. Ordering stays
prominence-first (lowest `minVisibleZoom`), so a truncation still keeps the bodies that matter, and
still logs (D5 — never silent).

**Decision 4 — verification is property tests + `convex-test` + a live measurement pass.**
Property-test the grid invariants in `@skating/core`, `convex-test` the query semantics on a
synthetic corpus, then deploy to dev, backfill the ~116k bodies, and measure **actual read counts**
across wide / sparse / dense / off-data viewports. The measured numbers land in this doc, so the
next person to touch these constants inherits evidence instead of folklore.

**Decision 5 — `zoom` becomes a required argument to `listInViewport`.**
Completeness is only provable when the zoom filter is in play (see the invariant below), and both
clients already pass it. The optional-`zoom` legacy path (pre-D49 behaviour) goes away.

---

## The design: a ladder grid

A body is indexed into a **table of cells**, not a point. One row per (body, cell).

**The grid.** Square-in-degrees, power-of-two: at level `z`, a cell spans `360 / 2^z` degrees in
both axes, and `(x, y) = (floor((lng + 180) / size), floor((lat + 90) / size))`. Deliberately not
Web Mercator: the code already reasons in degrees of bbox extent (`bboxExtentDeg`,
`LARGE_BODY_EXTENT_DEG`), the map's zoom levels line up with the same power-of-two ladder anyway,
and degree cells keep the math trivially testable with no projection in the middle.

**Which level a body is indexed at.** The **coarser** of two answers:

```
indexLevel(body) = clamp(min(fitLevel(bboxExtent), minVisibleZoom), Z_MIN, Z_MAX)
```

- `fitLevel(extent)` — the finest level whose cell is still at least as big as the body, so a body
  never covers more than ~4 cells at its own level. This is what keeps writes bounded: without it,
  a long river reach at a fine level would need hundreds of rows.
- `minVisibleZoom` (D49) — the level at which the body *becomes visible*. Taking the min means a
  body is always indexed at a level **no finer than the zoom it first draws at**, which is the whole
  completeness argument below.

`Z_MIN`/`Z_MAX` come straight from D49's `MIN_VISIBLE_ZOOM_WIDEST` (6) and `MIN_VISIBLE_ZOOM_FLOOR`
(14), so the ladder has nine rungs and needs no separate tuning.

**The query.** For a viewport at map zoom `Z`, scan ladder levels `Z_MIN … min(Z, Z_MAX)`. At each
level, enumerate the cells covering the viewport and read
`by_cell = [z, x, y, minVisibleZoom]` with the range `minVisibleZoom <= Z`. Dedup by body id,
`bboxIntersects`-refine, order by prominence.

**Why the reads are bounded.** Every scanned level is *coarser than or equal to* the viewport's own
zoom, so its cells are at least as large as the viewport — each level contributes ~4 cells (9 in the
worst alignment). Nine rungs × ~4 cells ≈ 36 index reads, each returning only rows that pass the
zoom filter. That bound comes from the geometry, not from a constant somebody measured once.

**The completeness invariant (the thing to property-test).**

> A body whose bbox intersects the viewport and whose `minVisibleZoom <= Z` is **always** returned.

Proof in two steps: (1) `indexLevel <= minVisibleZoom <= Z`, so the body's level is inside the
scanned range; (2) at any fixed grid level, two intersecting bboxes necessarily share at least one
cell — the intersection region contains a point, and that point lies in exactly one cell, which both
coverings contain. No margin, no `isLarge` outlier list, no gap to reason about.

**What this retires.** `VIEWPORT_MARGIN_DEG` · `LARGE_BODY_EXTENT_DEG` · the `isLarge` field, its
index, and both of its `.collect()`s · `MAX_VIEWPORT_LIMIT`'s role as a crash guard · the JS
`listed` re-check and its "cheap only because Phase 1 has ~no unlisted bodies" caveat (unlisted
bodies simply aren't in the index, so the filter is free rather than ceiling-halving) · the
`adminAreas` ±0.2° margin and its silent town-label degradation · the geospatial component itself.

**Point lookups** (`listedBodiesNearCoord`, `resolvePlaceForCoord`) are the degenerate case: one
cell per ladder level, no zoom filter (a tiny pond you are standing on must be found regardless of
prominence).

---

## Work breakdown

Committed in the order below; one PR at the end (per the phase convention).

1. **This doc** — the design and the corrections above, on record before the code.
2. **`@skating/core` grid math** — `spatialCells.ts` + property tests for the completeness theorem
   and the write-bound (a body never exceeds ~4 cells at its own level).
3. **`waterBodyCells` table + write path** — the sync-on-write diff helper, wired into every
   mutation that currently re-inserts a geospatial point (import, create, approve, remove, restore,
   merge, `setCuratedBoost`, reindex).
4. **`listInViewport` + `listedBodiesNearCoord` rewrite** — off the cell index; the render budget
   raised to 1,000; `zoom` required.
5. **`adminAreas` migration** — `adminAreaCells`, exact containment, both `by_level` collects gone.
6. **Component removal + backfills** — `convex.config.ts`, `lib/geospatial.ts`, the dependency, the
   test registrations; paginated backfill `internalMutation`s for both cell tables.
7. **The `.collect()` sweep** — full triage of all 67 sites in `packages/convex/convex`; pagination
   + a *logged* cap on every one whose size grows with the corpus or a global table; a one-line note
   on the ones bounded by design, so the list never has to be re-derived.
8. **Dev deploy, backfill, measurement** — the numbers recorded here.
9. **Doc updates** — roadmap N1 struck with a pointer, plus the phase-1 / 2.5 root-cause notes,
   `packages/convex/README.md`, and the ETL README's batch-size rationale (sized around the
   component's ~15–20 S2-cell reads per insert, which no longer exist).

## Measured results

Taken **2026-07-26 against the dev deployment** (`agile-bee-397`) after backfilling the real corpus:
**116,070 water bodies** in 233 batches, **3,240 admin boundaries** in 17. The corpus size the
roadmap estimated at "~116k" is exact.

Numbers come from `waterBodies:viewportReadStats`, which runs the same scan as `listInViewport` and
returns the counters instead of the bodies. It's a permanent internal query on purpose: the
constants it measures were wrong for a year without anyone noticing, and `convex-test` structurally
cannot catch that (it doesn't model the read cap), so the claim needs to stay checkable against a
real deployment.

`reads` below is cells looked up + cell rows scanned + one hydrating `get` per distinct body — the
figure Convex's **4,096** cap counts.

| Viewport | zoom | bodies | cells | rows | **reads** | |
|---|---|---|---|---|---|---|
| Whole Northeast | 6 | 7 | 8 | 10 | **25** | the widest zoom anything draws at |
| Atlantic, off-data | 10 | 0 | 16 | 5 | **21** | *the PR #11 crash case* |
| Northern Vermont | 9 | 45 | 21 | 103 | **169** | |
| Maine lake belt | 14 | 9 | 31 | 144 | **184** | |
| Burlington waterfront | 14 | 12 | 21 | 216 | **249** | |
| Burlington + Champlain | 12 | 122 | 24 | 271 | **417** | |
| Adirondack lake country | 12 | 230 | 48 | 446 | **724** | |
| Adirondacks | 11 | 222 | 20 | 560 | **802** | |
| Eastern Maine lakes | 12 | **319** | 145 | 930 | **1,394** | *would have been clamped to 256* |
| Wider Adirondacks | 11 | 1,000 | 58 | 1,383 | **2,441** | render budget hit, logged |
| 1°-wide box claiming z14 | 14 | 1,000 | 180 | 1,373 | **2,553** | incoherent input, bounded anyway |

**What this establishes.**

1. **The crash case is gone and is now the *cheapest* read on the board.** Panning off-data used to
   exhaust an S2 covering looking for results that weren't there; it now costs 21 reads, because an
   empty cell costs an index lookup and nothing else.
2. **Real viewports sit 5–25× under the cap.** The heaviest genuine one (dense eastern Maine at z12)
   is 1,394 — about a third of budget.
3. **The 256 clamp was costing real lakes.** That same eastern-Maine viewport returns **319** bodies.
   Under the old ceiling, 63 of them — Great Moose, Sebasticook, Pushaw, Schoodic, Seboeis and the
   rest — were simply absent from the map, with a log line nobody was reading.
4. **Incoherent input degrades instead of crashing.** A 1°-wide viewport claiming zoom 14 is not a
   thing a real client sends; it stops at the row budget, returns the 1,000 most prominent bodies,
   logs the truncation, and reads 2,553 — bounded by the budgets rather than by luck.

**The `adminAreas` bug, quantified.** The retired `findContainingTown` searched town centroids within
±0.2°, sized on the premise that towns run "well under 0.4° across". Reading the rung each town
landed on in the new index: **9 towns span more than 0.35°** (up to 0.70°) — for these the old
lookup could not reliably find the town from an interior point at all — and a further **264 span
0.18°–0.35°**, where a point near a corner sits more than 0.2° from the centroid. Sampling inside
the Adirondacks now returns `{ town: "Town of Long Lake", county: "Hamilton County", state: "NY" }`.

**Still worth knowing.** The wider-Adirondacks case reads 60% of the cap before its budgets stop it.
That's the design working — the budgets are hard limits, so it cannot crash — but it's the number to
watch if the render budget is ever raised past 1,000.
