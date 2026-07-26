# N1 — Read-path durability: the crash class

> **Status: ✅ complete on dev (2026-07-26); prod deferred.** PR **#27**. The first item in the
> roadmap's *Next-phase candidates* register ([`07-roadmap.md`](./07-roadmap.md) → *Later /
> deferred* → N1), picked first because this is the map's front door and its failure mode is a
> **crash**, not a slowdown.
>
> Nothing from the plan below is outstanding. The retired `isLarge` field was stripped from all
> 116,070 rows and dropped from the schema; the notification **reverse spatial index** was never in
> scope and remains N7 (N1 made the profile walk bounded, not unnecessary).

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

`reads` below is cells looked up + cell rows scanned + one hydrating `get` per distinct candidate —
the figure Convex's **4,096** cap counts.

Each row records the **exact bbox** it was measured with, because a table you can't re-run is the
same kind of unchecked claim this whole phase exists to retire. Re-run any line as
`pnpm exec convex run waterBodies:viewportReadStats '{"viewport":{…},"zoom":N}'`.

| Viewport | bbox (minLat, minLng → maxLat, maxLng) | zoom | bodies | cells | rows | **reads** | |
|---|---|---|---|---|---|---|---|
| Whole Northeast | 40.5, −80.0 → 47.5, −67.0 | 6 | 7 | 8 | 10 | **25** | the widest zoom anything draws at |
| Atlantic, off-data | 41.0, −69.0 → 41.5, −68.5 | 10 | 0 | 17 | 5 | **22** | *the PR #11 crash case* |
| Maine lake belt | 45.0, −69.2 → 45.05, −69.1 | 14 | 2 | 32 | 87 | **121** | |
| Northern Vermont | 44.4, −73.4 → 45.0, −71.5 | 9 | 36 | 22 | 110 | **168** | |
| Burlington waterfront | 44.46, −73.24 → 44.50, −73.18 | 14 | 49 | 27 | 232 | **308** | |
| Burlington + Champlain | 44.35, −73.35 → 44.55, −73.05 | 12 | 138 | 28 | 286 | **452** | |
| Adirondack lake country | 43.7, −74.6 → 43.95, −74.2 | 12 | 154 | 39 | 538 | **731** | |
| Eastern Maine lakes | 44.6, −69.8 → 45.3, −68.4 | 11 | **314** | 74 | 768 | **1,156** | *would have been clamped to 256* |
| Adirondacks | 43.5, −74.8 → 44.0, −74.0 | 11 | **404** | 43 | 989 | **1,436** | |
| Eastern Maine, deep | 44.6, −69.8 → 45.3, −68.4 | 12 | **513** | 227 | 1,031 | **1,771** | |
| Wider Adirondacks | 43.2, −75.2 → 44.3, −73.8 | 11 | 957 | 74 | 1,500 | **2,531** | row budget hit, logged |
| 1°-wide box claiming z14 | 44.0, −73.0 → 45.0, −72.0 | 14 | 1,000 | 233 | 1,408 | **2,641** | incoherent input, bounded anyway |

**What this establishes.**

1. **The crash case is gone and is now the *cheapest* read on the board.** Panning off-data used to
   exhaust an S2 covering looking for results that weren't there; it now costs 22 reads, because an
   empty cell costs an index lookup and nothing else.
2. **Real viewports sit 2–100× under the cap.** The heaviest genuine one (eastern Maine at z12) is
   1,771 — under half of budget.
3. **The 256 clamp was costing real lakes.** That eastern-Maine viewport returns **513** bodies and
   the Adirondacks **404**. Under the old ceiling, 257 and 148 of them — Great Moose, Sebasticook,
   Pushaw, Schoodic, Seboeis and the rest — were simply absent from the map, with a log line nobody
   was reading.
4. **Incoherent input degrades instead of crashing.** A 1°-wide viewport claiming zoom 14 is not a
   thing a real client sends; it stops at the row budget, returns the 1,000 most prominent bodies,
   logs the truncation, and reads 2,641 — bounded by the budgets rather than by luck.

**The `adminAreas` bug, quantified.** The retired `findContainingTown` searched town centroids within
±0.2°, sized on the premise that towns run "well under 0.4° across". Reading the rung each town
landed on in the new index: **9 towns span more than 0.35°** (up to 0.70°) — for these the old
lookup could not reliably find the town from an interior point at all — and a further **264 span
0.18°–0.35°**, where a point near a corner sits more than 0.2° from the centroid. Sampling inside
the Adirondacks now returns `{ town: "Town of Long Lake", county: "Hamilton County", state: "NY" }`.

**Still worth knowing.** The wider-Adirondacks case reads 62% of the cap before its budgets stop it.
That's the design working — the budgets are hard limits, so it cannot crash — but it's the number to
watch if the render budget is ever raised past 1,000. Note *which* budget stops it: the **row**
budget, at 957 of the ~1,000 bodies it could draw. Raising `CELL_ROW_SCAN_BUDGET` is the lever, and
it has a ceiling — reads are bounded by `CELL_SCAN_BUDGET + 2 × CELL_ROW_SCAN_BUDGET` (a row can
cost a hydrating `get`), so 1,500 already sits close to the largest value that keeps the worst case
under 4,096. Past that the render budget has to come down instead.

## Corrections from review

Three of the caps this phase added were bounded correctly but ordered wrongly — each kept the rows
the index happened to reach first rather than the rows the caller needed. Worth naming as a class:
**a cap is only as good as the scan order it caps.** `takeCapped` makes the bound explicit and logs
it, but it can't know which end of the index matters; that has to be decided at each call site.

A second lesson came out of the follow-up rounds: **fixing the order isn't enough if the truncation
can still change the answer.** Two of the three needed a second pass — the viewport had to spend its
row budget across the box and not just rank what it happened to collect, and the bounty gate had to
stop treating a saturated scan as evidence of anything. Each fix below carries a regression test
verified to fail against the code it replaced, which is what the first round was missing.

### The recent-report cap kept the oldest reports

`bounties.recentReports` reads `by_water_body_moderation_and_skate_end_time`, which runs *ascending*
on `skateEndTime` — so `take(200)` on a busy body retained the 200 oldest reports in the 144-hour
window and discarded the newest. Both callers want the opposite end: the freshness gate needs the
freshest suppressor (someone could otherwise open a bounty on ice skated an hour ago), and the
eligibility fan-out wants the people who reported most recently, not least. Fixed with `.order('desc')`,
which also makes the cap drop the candidates least likely to matter. The comment above the constant
claimed newest-first ordering that the query never had — the claim was right, the code wasn't.

**Newest-first is still only a heuristic, though** (round 3). A report's freshness window stretches
with author trust and thumbs — up to 3× base — and shrinks to as little as zero, so a trusted read
from four days ago genuinely can outlast 200 newer throwaway ones. Raising the cap doesn't fix that
and can't: the gate does an author `get` plus a `tallyThumbs` scan *per report*, so 1,000 here would
be 2,000+ reads on its own. The scan cap is a fan-out cap wearing an index cap's clothes.

What fixed it was making truncation unable to produce a wrong answer. `evaluateFreshness` now
reports `saturated` — the cap was hit **and** nothing in the scanned set suppressed — and the gate
treats that as "unknown", which resolves to a block. The failure it prevents (a bounty asking for
fresh eyes on ice that already has them) is a wrong answer, not a slow one, and blocking is also the
right product call on its own terms: a body carrying 200+ visible reports inside six days is not one
anybody needs to be sent to go look at. The fan-out helper keeps its plain cap, because notifying the
200 most recent reporters instead of all 300 is a partial answer rather than a wrong one.

### The hazard-weather cap could never rotate

The decay cron capped its sweep at 1,000 active hazards off `by_status`, whose order never changes.
Past that count, every hourly tick re-read the same prefix and the hazards behind it would keep
absent decay and snow-hidden state forever. The per-hazard cadence gate can't rescue that: it filters
rows that have *already* been read. Now indexed `by_status_weather_adjusted` and scanned ascending —
`undefined` sorts first, so never-refreshed hazards lead, then the longest-stale — and a refresh
stamps `weatherAdjustedAt`, sending that hazard to the back. The cap became a rotation rather than a
wall. (A hazard whose Open-Meteo fetch keeps failing deliberately isn't stamped, so it stays at the
head and retries; that's the fail-open behaviour, and it only costs a slot.)

### The viewport kept whichever cell it scanned first

The first cut of `bodiesCoveringBox` hydrated bodies as the cell walk reached them and stopped at
the render budget. Within one cell that's prominence-ordered (`by_cell` is ascending on
`minVisibleZoom`), but a viewport spans many cells, and row-major traversal is not a prominence
order — so when the budget bound, an early cell's least prominent ponds displaced a later cell's
headline lake. Which lakes the map drew depended on cell arithmetic.

It now runs in two passes: collect candidate *rows* across every rung (cheap — `minVisibleZoom` is
denormalized onto the row, so ranking costs no document read), then sort by prominence and hydrate
in that order. The answer is the top-`limit` bodies by `minVisibleZoom` wherever they sit in the box.

The cost of not stopping the scan early is visible in the table: the wider-Adirondacks case now
reads to the row budget rather than to the render budget, and returns 957 bodies instead of 1,000.
That is the right side of the trade — 957 correctly-chosen bodies beat 1,000 chosen by scan order —
but it is a real change, and it's why the note above cares which budget binds.

**And sorting alone wasn't enough** (review round 3, same finding pushed one level down). Ranking
after the scan only helps if the scan collected candidates from across the box. With each cell free
to take `limit + 1` rows, two dense cells could spend the whole 1,500-row budget between them and the
sort would faithfully rank a *spatially selected* prefix — whole neighbourhoods of a dense viewport
blank while the first corner scanned rendered its every pond.

So each cell now takes what it wants only after reserving `MIN_ROWS_PER_CELL` for every cell still
unserved. The first attempt at this divided the budget evenly up front, and re-measuring caught it
immediately: a 227-cell viewport got 6 rows per cell, and four reads that previously fit inside the
budget started truncating (eastern Maine at z12 fell from 513 bodies to 362). A floor is the right
shape and an even split is not — rationing has to bite only when the budget is actually scarce. With
the floor, every real viewport in the table above is byte-for-byte what it was before the change, and
only the two budget-bound rows move.

The residual is stated rather than fixed: a dense cell is read to its share's depth, so under a bound
budget a body can be missed if its own cell holds more prominent bodies than that share. Removing
that would mean reading every row — the unbounded scan this phase exists to retire.

### "Exactly the cap" is a complete answer, not a truncated one

Round 4, and the smallest bug of the set with the largest blast radius: `take(cap)` returning `cap`
rows can't tell "there are exactly this many" from "there are thousands", and every caller was
reading it as truncation. Mostly that only cried wolf in a log — but the round-3 saturation rule had
just given the flag *authority*, so a body with exactly 200 reports in the window, every one of them
read and none of them suppressing, would have had a perfectly valid bounty rejected.

`takeCapped` now asks for `cap + 1` and returns `cap`, so the boundary is a fact rather than a guess;
`bounties.listOpen` and the viewport's per-cell read do the same thing inline. One row buys the
distinction, at 13 call sites and every cell of a viewport scan. The lesson is narrower than the
others and worth keeping anyway: **a flag that only logs can be sloppy at the boundary; the moment it
decides something, it can't.**

### Round 5: the guards needed guarding

Three more, each one a hole in a fix from an earlier round rather than in the original design. Worth
recording as a pattern in its own right — **a guard that only covers the simple case tends to leave
the interesting one open**, and the interesting one is where the bug lives.

**A truncated scan can't be cleared by weather either.** Round 3 blocked a bounty when the freshness
scan truncated *and* found no suppressor. But a truncated scan whose suppressors were all
weather-reopened has no blocker either — and a freeze clearing the reports we *did* read says nothing
about the ones past the cap. The flag is now the raw truncation, and the decision moved to after the
reopen set is applied. The rule states more simply than the thing it replaced: **a truncated scan
cannot clear a body, however the scanned rows resolve.**

**Anything the hazard sweep skips has to rotate too.** Stalest-first only rotates what actually gets
*stamped*. A hazard the sweep declines to refresh is never stamped, so on an `undefined`-first index
it sorts to the front forever and holds a slot in the cap against everything behind it — the round-2
starvation bug, one level in. Moderator-hidden pins (the numerous case) are now excluded by the index
via a `moderationStatus` column, so they never cost a slot at all. The two that can only be judged
after reading — a feature-promoted pin (D53), a hazard whose body was removed — are stamped by
`deferHazardWeather`, which moves only `weatherAdjustedAt` and invents no decay for a pin that
doesn't render. The stamp is honest: the field records when the sweep last *considered* a hazard, and
"this one needs no weather" is a considered answer.

**The probe row belongs inside the budget, not beside it.** The `cap + 1` probe was already charged
to `rowBudget`, so the overshoot was one row for the whole query rather than one per cell — but a
ceiling that reads 1,501 is not a 1,500-row ceiling. Clamping the probe to the remaining budget makes
`CELL_ROW_SCAN_BUDGET` exact, and costs nothing: the only cell it binds is one already spending the
last of the budget, which sets `truncated` on the next iteration anyway. The derived worst case is
now `CELL_SCAN_BUDGET + 2 × CELL_ROW_SCAN_BUDGET` = 512 + 3,000 = **3,512** reads against the 4,096
cap, with the heaviest measured viewport at 1,771 and the heaviest bounded one at 2,531.

### Round 6: one real hole, and one invariant that was load-bearing without saying so

**The clamp created a boundary at the end of the plan.** When the row budget cuts the probe short,
"was there more in this cell?" goes unanswered. On any cell but the last that's harmless — the
exhausted budget flags the truncation on the next iteration — but on the *last* cell there is no next
iteration, and the scan would have returned a partial answer claiming to be whole. Exactly the
failure D5 exists to prevent, introduced by the fix for the previous one. A budget-clamped probe that
comes back full is now reported as a truncation. That can over-report on a scan which happened to fit
the budget exactly, and that is the right direction to be wrong in.

**The ten-suppressor cap turned out to rest on an unstated invariant.** The review asked whether
`BOUNTY_FRESH_MAX_REPORTS` can hide an eleventh, older suppressor once weather has reopened the ten
the evaluator saw. It can't — but only because **reopening is monotone in report age**: a verdict is
read over `[skateEndTime, now]`, an older report's window strictly contains a newer one's, and both
degree-hour integrals accumulate non-negative per-hour contributions, so a superset window can only
push further past the thresholds. If the ten newest suppressors were reopened, anything older was too.

The code was right and said nothing about why, which on this branch's evidence is how a correct thing
becomes an incorrect thing later. The invariant is now pinned by a property test in
`weather.test.ts` ("is monotone in window length"): if either integral ever gains a term that can
*decrease* with more data — a net figure, a mean, a recency weighting — that test fails, and the cap
in `evaluateFreshness` has to be revisited with it. The convex-side test pins the allow, too, so the
next reader doesn't "fix" it into a false block: blocking here would deny a legitimate weather reopen
on any body busy enough to carry eleven fresh reports.
