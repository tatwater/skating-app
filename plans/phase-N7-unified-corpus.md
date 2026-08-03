# N7 — The unified corpus: one record per lake, two catalogues behind it, and a full data campaign on top

> **Status:** 📋 Scoped, not built (2026-08-03). Written after a measurement session that corrected
> four of its own findings; the numbers below are the survivors, and anything still marked
> *unverified* is marked that way on purpose.
> **Depends on:** the D91 area floor and its prune (both landed, 2026-08-03), the N6b containment join
> (landed, tiles **not** rebuilt), and the `osmId`/`nhdId`/`geometrySource` fields (landed, unbackfilled).
> **Touches:** every ETL package — `scripts/etl`, `scripts/admin-areas`, `scripts/lake-depth`,
> `scripts/bathymetry`, `scripts/wind-climate` — plus `waterBodies` identity, and every downstream
> that keys off `externalId`.
> **Decisions:** **D92–D101**, proposed here, to be logged in [`01-decisions.md`](./01-decisions.md) at
> build kickoff. D91 is the last one logged. **D95, D100 and D101 are approved** (founder,
> 2026-08-03), and **D92 was widened to three catalogues** at the same sitting.

---

## What the kickoff review found — corrections to this document

*Added 2026-08-03 at build kickoff, after checking this plan's claims against the code and against the
live sources. The findings are recorded here rather than silently folded in, because three of them
change a decision.*

**1. NHD was retired on 2023-10-01, and this plan never said so.** Every state geodatabase on
`prd-tnm.s3.amazonaws.com` carries `LastModified: 2023-12-27` and will never be updated again; the
successor is the **3D Hydrography Program (3DHP)**. That promotes *currency* from one of D92's
"secondary signals to record alongside" to a **decision criterion**: an NHD-primary outcome freezes
our outlines in 2023 while OSM keeps improving underneath us.

**2. 3DHP is not a drop-in replacement, and the reason is the join key.** Its Waterbody layer
(`3DHP_all/MapServer/60`, checked 2026-08-03) carries `id3dhp`, `mainstemid`, `gnisid` — and **no
`Permanent_Identifier`, no `ReachCode`**. Every measurement in this document keys on
`Permanent_Identifier`, including the 5/5 duplicate collapse and the whole Maine MIDAS linkage (MIDAS
*is* NHD precisely because it carries those two fields). Counts are near-identical — **14,418 3DHP
waterbodies against NHD's 14,855** in a northern-Maine bbox — so for lakes 3DHP is largely the same
polygons re-published. It is worth having as a *third claim*, not as a substitute. See D92.

**3. The bake-off as ordered is circular.** Step 3 refereed the bake-off with our soundings; step 10
re-keys the soundings. But D95 says ~12% of Maine's soundings are mis-keyed, and those are the same
soundings the referee uses — while the re-key needs the unified corpus, which needs the bake-off's
answer. **Resolution: the bake-off runs only over source keys that pass containment today** (2,415 of
2,491). MIDAS 870 is excluded by construction, since it is a containment failure. The referee is then
clean without needing the re-key first, and no iteration is required.

**4. `waterBodyKey` is the crux of D93 and is unspecified.** "A stable id we mint once" does not say
what the **upsert key** for the next import is — the job `externalId` does today. See the new
subsection under D93; this is the hardest unsolved part of the phase and it must not be discovered
during implementation.

**5. This document uses two numbers for one set.** §Why says **36** Maine lakes with published surveys
have no polygon in the corpus; §Verification says the floor applied to the **42** Maine bathymetry
misses admits 41. Re-derive both from one query at kickoff and quote a single figure.

**6. `regionStats` is empty on dev — zero rows, confirmed 2026-08-03.** D85's deciles and prominence
are not stale, they are *absent*; the N6c campaign's recompute never ran because it was gated on the
elevation pass. Step 11 is a first computation, not a refresh.

**7. Simplification parity is not addressed and would corrupt a bake-off signal.** Our transform
simplifies to ~5 m; NHD HR is 1:24,000 and far denser. Comparing simplified copies makes "shoreline
vertex density" a measurement of our own pipeline. **The bake-off compares source geometries; only
storage simplifies** — the same rule D85 already applies to derived stats.

**8. Two mechanical traps, each needing one rule defined once.** NHD HR is **NAD83 (EPSG:4269)** and we
store WGS84 — a 1–2 m offset in the Northeast, negligible but it must be an explicit `ogr2ogr`
reprojection rather than an assumption. And `PERMANENT_IDENTIFIER` arrives as a **brace-wrapped
uppercase GUID** (`{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}`); normalize it in one place.

**9. Beau Lake checks out.** Queried live 2026-08-03: `PERMANENT_IDENTIFIER
{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}`, `AREASQKM 7.594` = **1,876.6 ac** against Maine's published
1,875.1. The phase's headline fixture is real.

**10. The pointer migration the founder asked for is currently a no-op — and should stay one.**
Everything attached to a body on dev is **2 hazards, 1 report, 9 sub-areas and 1 `pointEvent`, with
zero dangling references** (measured 2026-08-03). User content points at the Convex `_id`, which only
moves if a row is deleted and recreated. **The re-import therefore patches geometry in place and never
delete-recreates a body that carries a claim.** If a replacement is ever unavoidable, its attachments
are carried across by hand and each one verified — at this scale that is a list of twelve, not a
migration.

---

## Why this phase exists

Three separate investigations converged on the same conclusion: the ceiling on what we can show a
skater is set by **coverage gaps we can measure and close**, not by anything we lack the machinery to
build.

1. **Bathymetry is capped at 2,494 lakes** — the entire five-state archive — of which we drew 2,022.
   36 Maine lakes with published depth surveys have **no polygon in our corpus at all**, so they can
   never be matched, contoured or counted. The largest is **Beau Lake: 1,875 acres, 181 ft deep**,
   absent because Geofabrik clips the Québec half of a cross-border lake.
2. **NHD has those lakes.** Verified against `hydro.nationalmap.gov` on 2026-08-03: Beau Lake at
   1,876.6 ac against Maine's published 1,875.1, plus Crystal Lake, Kingdom Bog, West Shirley Bog,
   Pingree Pond and New Hampshire's Sessions Pond — every one within 0.1% of the state figure.
3. **OSM cannot see its own duplicates, and NHD can.** Five lakes are carried twice by OSM under
   different ids (Long Pond as `way/150404999` at 2,552 ac *and* `relation/2602300` at 2,532; Lovell
   Lake, Duncan Lake, Meadow Lake, Bolster Pond the same). **All five pairs collapse onto a single NHD
   `Permanent_Identifier`** — tested, 5/5.

Separately, ~**12% of Maine's soundings** sit in the archive under a lake id that is not a lake,
recoverable into **217 bodies that would draw** and that we currently render blank.

---

## The corpus as it actually stands

**Correcting a figure used throughout the earlier N6 work.** "116,070 bodies" described the corpus
*before* the D91 floor. Today's re-import produced **over 120,000** features, and the prune brought
the stored corpus to **~21,000** (D91 predicted 21,660 kept of 123,940 — confirm the exact survivor
count at kickoff and use it as the campaign baseline).

That changes the arithmetic of everything below. Against a 116k corpus an NHD gap-fill is a rounding
error; against **~21,000**, adding on the order of a thousand real lakes is a **~5% expansion**, and
Maine's measured post-floor delta alone is ~450 bodies.

---

## What is already built, and what is now back in question

| Landed | Where | State |
| --- | --- | --- |
| `osmId` / `nhdId` / `geometrySource` + `by_nhd_id` | `convex/schema.ts` | built, **undeployed, unbackfilled** |
| `backfillCatalogueIds` — paginated, idempotent, never overwrites | `convex/waterBodies.ts` | built, unrun |
| Containment join — `containedFraction`, `MIN_SURVEY_CONTAINMENT = 0.5` | core + `matchBathymetryLakes` | built; re-run 2026-08-03 matched **2,415/2,491** |
| `bodiesCoveringPoint` + `alsoCovers` + bay re-clip | core, convex, `build.ts` | built, tiles not rebuilt |
| `BATHYMETRY_APPROACH_M = 25` | `convex/waterBodies.ts` | built |

**Nothing here is load-bearing enough to constrain the design.** The founder's position is explicit:
*"I am not married to what we built already… I am not worried about effort here and I'd like to know
we hashed this out properly."* The identity fields survive any outcome; the rest is replaceable.

**The tiles on disk are stale** — built from the pre-fix join, still carrying mis-matches. Infer
nothing from `contours.geojsonl` until it is rebuilt.

---

## D92 — Which catalogue draws each lake is decided by a **bake-off**, not by precedent

**Proposed as a measurement, deliberately not as an answer.**

> **Widened to three catalogues (founder, 2026-08-03).** The bake-off is **OSM vs NHD vs 3DHP**, not
> a two-horse race. The reasoning is that NHD's freeze date makes it a snapshot with a known
> expiry, and 3DHP is the only source that is both *maintained* and *elevation-derived* — so the
> question "does LiDAR-derived hydrography actually draw a better lake than either?" is worth one
> measurement now rather than a re-litigation in a year.
>
> **What each brings, and what it costs:**
>
> | | OSM | NHD HR | 3DHP |
> | --- | --- | --- | --- |
> | currency | continuously edited | **frozen 2023-12-27, retired** | quarterly |
> | join key | `way/…` · `relation/…` | `Permanent_Identifier` + `ReachCode` | `id3dhp` · `mainstemid` · `gnisid` — **no `Permanent_Identifier`** |
> | derivation | human tracing, mixed imagery | 1:24,000 compilation | LiDAR-derived where EDH exists, **NHD elsewhere** |
> | access | Geofabrik `.pbf` (already ingested) | state GDB, 924 MiB for five states | REST service; downloadable product on ScienceBase |
>
> **3DHP cannot be the identity spine**, whatever the bake-off says about its geometry. It has no
> `Permanent_Identifier`, so it cannot carry the MIDAS linkage, cannot collapse the five OSM duplicate
> pairs, and cannot key any measurement this plan has already taken. If 3DHP wins on geometry, it wins
> as a **`geometrySource` value on a record whose identity is still OSM ↔ NHD** — which is exactly the
> separation D93 exists to make possible, and is the strongest available argument that D93 is worth
> building.
>
> **A third source needs a third id field.** `id3dhp` joins to our record the same way the other two
> do; note that 3DHP falls back to NHD geometry wherever EDH does not yet exist, so **a 3DHP polygon
> that is byte-identical to its NHD counterpart is the expected case, not a bug** — and the bake-off
> must report how often that happens, or it will claim a three-way comparison it did not make.

An earlier draft of this document asserted "OSM wins, NHD fills holes" on the strength of a
count comparison. That comparison is real but it only answers *how many*, not *which is better*:

| Maine | count |
| --- | --- |
| NHD, all waterbody features | 41,323 |
| …passing the D91 floor | 5,822 |
| …minus SwampMarsh (9.9%) and Estuary (1.4%) | **5,163** |
| **OSM Maine, same floor** | **4,715** |

**1.10×** — nearly all of NHD's apparent 5× bulk is water the floor deletes anyway. So *coverage*
barely separates them in Maine, which is the fairest test available (a corner state where crowd
mapping should be weakest). NH measured 1.23× and VT 1.88×, both discounted: those bounding boxes
bleed heavily into neighbouring states.

**What no measurement so far has settled is accuracy, and the reason is a trap worth recording.**
Maine's MIDAS waterbody layer carries `Permanent_Identifier` and `ReachCode` — it *is* NHD. Scoring
NHD against it returned a 0.1% median error and that is a tautology, not a finding. The only
independent number obtained is that **OSM's median disagreement with that geometry is 2.4%**, with 39
of 51 sampled lakes inside 5%. That says OSM is not *bad*. It does not say which is better.

### The referee: our own soundings

We hold something neither catalogue does — **2.4 million depth measurements taken on the water**. A
polygon that is a better description of a lake will:

- **contain a higher fraction of that lake's soundings** (`containedFraction`, already built), and
- **have less of its own area far from any sounding** (the body-probed density measure of D98).

Both are physical, independent of either publisher, and computable for the ~2,400 lakes that carry a
survey. That is a large enough sample to decide a default and to detect whether the answer is uniform
or varies by lake size, state and shape.

**Two constraints on how the referee is run**, both added at kickoff because getting either wrong
produces a confident wrong answer:

- **Only source keys that pass containment today are eligible.** The referee cannot use soundings that
  D95 has not yet re-keyed, and D95 cannot run until the corpus exists. Restricting the bake-off to
  the 2,415 of 2,491 keys that already pass containment breaks that circle without iteration, and it
  excludes MIDAS 870 by construction — 870 *is* a containment failure. The excluded keys must be
  named in the write-up, not just counted.
- **The comparison runs on source geometry, never on the simplified copy.** We simplify to ~5 m and
  NHD HR is a 1:24,000 compilation; comparing the stored copies would make "shoreline vertex density"
  a measurement of our own transform. Same rule D85 already applies to derived stats. Storage still
  simplifies; the bake-off does not.

**Secondary signals to record alongside, not to decide on:** shoreline vertex density (detail
available for D85's derived stats), currency (OSM is continuously edited; NHD HR is a periodic
snapshot), and the frequency of one-to-many segmentation disagreements.

### What the bake-off must output

1. A **default** geometry source, per-state if the answer is not uniform.
2. A **per-lake override rule** where the default loses by a margin — this is the part that makes the
   minted-key design (D93) worth having, because the override can be applied lake by lake without
   re-keying anything.
3. An honest statement of **how much it mattered**. If the two are within noise, say so and pick the
   one with the cheaper pipeline; that is a legitimate outcome and must not be dressed up.

> **Scope note.** Whichever way this lands, D72's access layer (put-ins, parking, toilets, trails)
> continues to come from the Geofabrik extract, because it is not in NHD at all. An NHD-primary
> outcome therefore means *two ingest pipelines*, and that cost belongs in the bake-off's write-up
> rather than being discovered afterwards.

---

## D93 — We mint the body key; OSM and NHD become claims on our record

**Proposed, and the founder's stated preference:** *"Minting our own body IDs gives us an opportunity
to create our own record from either or (or both) sources for each body."*

A body carries:

- **`waterBodyKey`** — a stable id we mint once and never change. Not the Convex `_id`, which moves if
  a row is ever recreated; not `externalId`, which is a foreign catalogue's key and cannot survive a
  source change.
- **`osmId` and/or `nhdId`** — what this lake is called in each catalogue that knows it. Both may be
  present, and once reconciled most will be.
- **`geometrySource`** — whose outline we drew, so D92's per-lake override is a field and not a
  migration.

**Why this is the enabling change and not a nicety.** Today `externalId` is doing three unrelated jobs
at once: upsert key, tile stamp, and identity. That is why changing a lake's geometry source is
currently impossible without re-tiling five states. Splitting them makes source choice a per-lake,
reversible decision — which is precisely what D92's bake-off needs in order to be actionable rather
than academic.

**It also pre-empts the merge problem rather than solving it.** With reconciliation run *before* any
NHD geometry is imported, we know each OSM body's NHD counterpart in advance, so the duplicate row is
never created. Everything downstream points at `waterBodyKey` and is unaffected by which catalogue we
later prefer. Residual one-to-many cases (Sherman Lake is one OSM body that NHD splits) are not fixable
by any id scheme and need a rule or a human.

> **Reconcile by `polygonIoU`, never by point containment.** Measured, not assumed. North Bay's
> interior point sits inside NHD's *Moosehead Lake*, so a containment join hands a bay its parent's id
> — after which the bay and the lake look like duplicates of each other. Meanwhile Moosehead itself
> matches **nothing**, because `centroid` is Turf `pointOnFeature` and lands on the shoreline of any
> large irregular lake (D85 amendment). Both failures are silent.

### The unsolved half: what is the upsert key?

**Flagged at kickoff, because the plan as written skips it and it is the hardest part of D93.**

`externalId` does three jobs today, and D93 names all three but only re-homes two. Identity moves to
`waterBodyKey` and the tile stamp moves with the rebuild — but the **upsert key**, the thing an import
uses to decide *"is this row already here?"*, has nowhere to go. A minted key is by definition not
derivable from an incoming feature, so it cannot answer that question.

The lookup therefore has to run on the catalogue ids, and that is a two-key (now three-key) match with
a genuine failure mode:

| incoming feature matches | action |
| --- | --- |
| exactly one stored row, by one id | patch in place — the normal case |
| one stored row by `osmId` and **a different** row by `nhdId` | the reconciliation missed a duplicate; **merge, do not create** |
| nothing | mint a new `waterBodyKey` |
| two stored rows by the same id | corrupt state — fail the batch loudly, never guess |

**The third row is the whole reason reconciliation runs before any NHD geometry is imported** (step 2,
before step 5). Get that ordering right and the case is rare; get it wrong and every NHD-only lake
arrives as a duplicate of an OSM lake we already had.

**This needs designing before the loader is written, not during.** In particular: whether the merge
case is allowed to run unattended, or whether it stops and files for review the way the dedup queue
already does.

**Migration.** `externalId` is retained and kept in step for one full campaign so the contour tiles,
sub-areas and put-ins keep resolving, then retired in a follow-up once every consumer reads
`waterBodyKey`. The tile stamp moves in the same rebuild this phase already requires.

**And `_id` never moves.** User content keys off the Convex `_id`, not off any of these. A body that
carries a report, hazard, sub-area, favourite, put-in, track or bounty is **patched in place**; it is
never deleted and recreated, whatever its geometry source ends up being. On dev that set is twelve
objects with zero dangling references (measured 2026-08-03), so the rule costs nothing to hold — and
holding it is what makes "change a lake's geometry source" a field update rather than a migration.

---

## D94 — Our record is best-of-both **per field**, and a name is not an area

**Proposed.** Each field takes the better claim, with provenance recorded:

| Field | Rule |
| --- | --- |
| `name` | Union — prefer a name over its absence; prefer the more specific when both exist. |
| `polygon` | D92's rule; recorded in `geometrySource`. |
| `type` | D96's parity mapping, from whichever source supplied the polygon. |
| `surfaceAreaSqM` | Measured from the polygon we actually stored. **Never** the larger of two claims. |

**Why name and area are different.** A name is a boolean assertion — *this place is a place* — so a
union of two independent sources biases nothing. An area is a *measurement*, and taking the larger of
two turns D91's floor from a threshold into "did either source round up enough," non-uniformly and
only where both sources exist.

**Both rescues are small, and honesty about that matters.** Only **6.5%** of NHD's 1–5 acre Maine
features carry a GNIS name, capping the name-tier rescue at **468** bodies — against **149** for a
largest-wins area rule (the 4.5–5.0 ac band, the only place a 2.4% median disagreement can flip the
outcome). Take the name union because it is free and correct, not because it is large. If more bodies
should clear the floor, lower the floor: D91 says it is "tuned to be cheap to loosen."

---

## D95 — Re-key soundings against the corpus, not against the source's lake id ✅ **APPROVED**

**Approved by the founder, 2026-08-03.** The state's lake id is evidence, not gospel; where it
disagrees with geography, geography wins.

### The evidence

**MIDAS 870 is not a lake.** Filed as North Pond (59 ac), it holds **17,922 soundings spanning
151 × 348 km** — essentially all of Maine — of which **0.51% are actually inside North Pond**. Every
row is `FMSRC=depthmap`, `FMSRCORG=meifw`: the digitised IF&W paper maps that `sources.ts` documents
as a second dataset sharing one schema. Rows the digitisation could not key landed here.

Assigning each sounding to the body containing it: **96.3% land in a body, across 263 distinct
bodies.** Under the real gates (`MIN_SOUNDINGS = 12`, then density at `MAX_GAP_RATIO = 0.22`):

```
217  ok  ← would draw          39  too-sparse          7  too-few-points
```

**All 217 are net new** — zero overlap with the shipped set, which follows from what 870 is. That is
2,022 → ~2,239, **+11%**, from one broken key. The largest are real destinations: Great Pond (937
soundings), Lake Auburn (297), Thompson Lake (195), Mooselookmeguntic (142), Spring Lake, King and
Bartlett Lake, Watchic Lake.

**And 870 is the whole opportunity.** Across all 1,526 Maine keys, 54 fail containment holding 20,484
soundings — **870 is 17,922 of them (87%)**. The rest score 0% because there is no polygon there at
all, which is D92's job.

### Rule 0 — the re-key lane never touches a key that already works (founder, 2026-08-03)

*"We should only do this if the soundings source points at a lake and then doesn't match up with the
lake's polygon. If there is a direct match (name/id/coords) then we don't need to get creative about
re-keying any of the soundings within."*

**Eligibility is the containment gate, and nothing else.** A source key whose soundings land inside the
body its own name/id resolves to is finished — it is not re-examined, not re-clustered, not split.
Only keys the containment gate *rejects* enter the lane at all. This is a hard boundary, not a
heuristic: it is the difference between recovering 17,922 orphaned soundings and quietly re-deciding
where 2.4 million measurements belong.

The fixture that enforces it is MIDAS **5448** — China Lake, a real 3,939-acre lake with 25,807
legitimate soundings and a clean containment score. **It must be provably untouched by the lane**, and
that assertion belongs in the test suite rather than in a run log, because a future refactor that
generalises the re-keyer is exactly the change that would break it silently.

### The four rules (founder, 2026-08-03)

1. **Match against the corpus first — both catalogues.** Re-keying runs *after* the unified corpus
   exists, so a sounding can land on an NHD-sourced body as readily as an OSM one. Running it earlier
   would silently discard every sounding whose lake only NHD knows about.
2. **One key, many bodies → decide whether to split.** The existing `splitByBody` is scale-free and
   derives its gap threshold from the cloud's own extent, which fails exactly when the cloud is
   contaminated: MIDAS 870's 348 km span yields a 27.8 km gap threshold, wider than the spacing
   between real Maine lakes, so the whole state collapses into one cluster. **Replace the
   bootstrapped threshold with corpus evidence**: soundings in different bodies are in different
   bodies, full stop. Split on body membership, then fall back to `splitByBody` only for soundings
   that matched nothing.
3. **Many keys, one body → join them.** The inverse case, and it is live: an agency filing one lake
   under two keys is normal (NH GRANIT files Great East Lake as both `NHLAK…` and `MELAK…`, and the
   two halves together *are* the lake). Where separate keys — or separate entries sharing a body name
   — all resolve to one canonical body, merge their soundings before gating, because the density gate
   must see the whole survey. `preferSurveyedLane` already handles the *lane conflict* half of this
   and must not be duplicated; what is new is merging same-lane keys.
4. **The density gate must judge the body, not the survey.** See D98 — this is a defect, not a
   refinement.

### The cost, recorded

`normalizeMeSoundings` refuses this today by explicit principle: *"guessing one spatially would be
inventing an association the state didn't make."* We are now overriding that for keys the containment
gate rejects. We will publish bathymetry for ~217 lakes on an attribution the surveying agency never
made. The lane already renders as `interpolated` rather than `surveyed`; **the credit line should say
that the lake assignment is ours.**

---

## D98 — The density gate probes the **body**, not the sounding hull

**Proposed. This is a defect with a known false-negative, found by the founder.**

`assessDensity` builds its probe grid inside the **convex hull of the soundings** and measures the
95th-percentile distance from those probes to the nearest sounding. It therefore asks *"is this survey
internally dense?"* and never *"does this survey cover this lake?"*

**The consequence:** a tight cloud of soundings anywhere inside a large polygon passes. `gapRatio`
divides by `sqrt(bodyArea)`, so a *bigger* body makes the ratio *smaller* — the gate rewards exactly
the mismatch it should catch. This is why `me-dep-soundings:4156` and `108#2` still resolve to large
bodies after the containment fix: containment asks "is the survey *in* this body" and the retired area
test asked "are these the *same* lake", and we currently have only the first.

**The fix:** probe the **body polygon**, not the hull. Coverage becomes *"the 95th-percentile distance
from any point of this lake to the nearest sounding, over `sqrt(area)`"*, which is the question the
threshold was always meant to express. A survey covering one arm of a large lake then fails, correctly.

**This must be recalibrated, not merely re-pointed.** `MAX_GAP_RATIO` moved from an earlier value to
**0.22** specifically to restore a keep-rate the founder approved *under the hull-probed denominator*
— its history is recorded in `density.ts`. Changing the probe region changes the distribution, so 0.22
almost certainly no longer means what it meant. **Re-derive the threshold against a keep-rate the
founder re-approves, and record both numbers.** Expect it to drop lakes that currently draw; that is
the point, and every one must be named in the drop ledger.

---

## D96 — Accepted classes are chosen for **parity between the two catalogues**

**Proposed, and the founder's caution is the design constraint:** *"choose our acceptable classes from
both sources specifically for parity/complementary benefit/clarity."*

Our enum is `lake · pond · river · stream · reservoir · bay · marsh · other`. OSM's classifier
(`packages/core/src/osm.ts`) accepts still water and defers flowing water, mapping `water=lake|pond|
reservoir`, `natural=bay`, `wetland=marsh`, and falling back to `other` for a water *area* of
unrecognised kind. Rivers and streams are deferred; swamp, bog and fen are skipped.

Mapping NHD without regard to that produces asymmetry in both directions:

| NHD | Naïve call | Parity problem |
| --- | --- | --- |
| 390 LakePond | accept | ✔ matches `water=lake\|pond` |
| 436 Reservoir | accept | ✔ matches `water=reservoir`, **but** its FCODEs include sewage treatment, settling, cooling and storage ponds, which OSM's `landuse=reservoir` does not imply |
| 466 SwampMarsh | drop | ✘ **asymmetric** — OSM accepts `wetland=marsh`. NHD lumps swamp *with* marsh under one FTYPE and its FCODEs do not separate them, so accepting all of 466 over-admits and dropping it under-admits |
| 493 Estuary | drop | ✘ **asymmetric** — OSM accepts `natural=bay`; an estuary is arguably the same class |
| 445 SeaOcean, 361 Playa, 378 IceMass | drop | ✔ OSM imports none of these |

**The work is to resolve the two asymmetries deliberately**, with the answer recorded either way:
either narrow OSM's acceptance to match NHD's resolution, or admit the NHD class and accept that its
boundary is coarser. Both are defensible; silently differing is not, because it would make "which
catalogue drew this lake" change *what kind of thing it is* — the exact confusion D93 exists to remove.

**The mechanical part is small.** 98.9% of Maine's post-floor NHD set is four FCODEs, all LakePond
variants. The named junk is tiny: 8 sewage treatment, 4 treatment, 11 water storage, 20 unspecified
reservoir.

### What the archived geodatabases actually contain (measured 2026-08-03)

**The sentence above is true of Maine and false of New Hampshire, and that is the finding.** Counted
directly out of the archived geodatabases, above the D91 floor:

| ≥ 5 acres | ME LakePond | ME SwampMarsh | NH LakePond | NH SwampMarsh |
| --- | --- | --- | --- | --- |
| features | 4,670 | 703 | 2,380 | **4,120** |
| named | 3,059 (**66%**) | 16 (**2%**) | 1,411 (**59%**) | 31 (**1%**) |

*(Bounding-box clips: ME `-71.1,42.9 → -66.9,47.5`; NH `-72.6,42.7 → -70.6,45.31`. See the bleed
caveat below — these are approximations of a state, not the state.)*

**SwampMarsh is 13% of Maine's post-floor set and 63% of New Hampshire's.** So D96 cannot be decided
from Maine, which is exactly what the paragraph above did. Admitting FTYPE 466 wholesale would roughly
**triple** New Hampshire's NHD contribution, entirely with wetland.

**And the FCODEs give no lever, confirming the asymmetry is real.** Of NH's 5,138 post-floor
SwampMarsh features, **5,053 are FCODE 46600** — the unspecified variant — against 57 intermittent
and 28 perennial. NHD genuinely does not separate swamp from marsh.

**The naming gradient is the discriminator, and it is consistent across both states:** LakePond runs
59–66% named, SwampMarsh **1–2%**. That is the same signal D91 already leans on — *"a name in OSM is a
human assertion that a place is a place"* — and it says NHD's post-floor SwampMarsh is overwhelmingly
unnamed wetland. **Proposed resolution: admit FTYPE 466 only where it carries a GNIS name**, which
costs ~47 bodies across the two states and closes the asymmetry without importing 8,000 bogs. To be
confirmed against VT/MA/NY and against what OSM's `wetland=marsh` acceptance actually admits today.

**Estuary (493) is a non-issue at this scale** — 83 post-floor in Maine, 10 in New Hampshire. Decide
it on principle rather than on volume.

### Three traps in the geodatabase itself

1. **Field names are lower-case in the GDB** (`permanent_identifier`, `gnis_name`, `areasqkm`,
   `ftype`) and **upper-case from the REST service**. Every measurement in this plan taken before the
   archive existed used the REST spelling.
2. **The CRS is a compound 3D `NAD83 + NAVD88 height`** (EPSG:4269 + 5703) with 3D multipolygon
   geometry — reproject and flatten explicitly.
3. **A "state" geodatabase is not clipped to the state.** Its `CLIPPOLY` layer is *empty*, and New
   Hampshire's extract reaches **46.09°N** — into Maine and Québec. The five extracts overlap
   heavily. Two consequences: the import **must** dedupe on `permanent_identifier`, and every
   per-state figure in this document that came from a bounding box is measuring bleed as well as
   state. That includes D92's count table.

### The count comparison, re-measured — OSM and NHD are a dead heat in Maine

D92's table reports NHD Maine at 5,163 post-floor after removing SwampMarsh and Estuary, against
OSM's 4,715 — **1.10×**. Measured from the archive, Maine's post-floor LakePond + Reservoir is
**4,718**, against that same OSM 4,715: **1.001×**.

**So on bulk coverage the two catalogues are indistinguishable in Maine**, and D92's stated
willingness to conclude *"they are within noise, say so"* now has a number behind it. What NHD is
actually worth is not bulk — it is the three things §Why this phase exists names: a key that collapses
OSM's invisible duplicates, specific gap lakes like Beau Lake, and the MIDAS linkage. **D92's write-up
must not let the count table imply otherwise.**

---

## D97 — The audit reports; only the prune deletes

**Proposed.** A read-only pass names every stored body that fails the current rules, with the reason,
so they can be reviewed and removed deliberately — the founder's ask: *"note which bodies Convex has
already that do not meet our new criteria, so that we can go in and remove them manually."*

Deletion stays with `pruneBelowAreaFloor`, which already knows how to keep anything with a claim on it
(`source: 'user'`, a `curatedBoost`, a soft-delist, a dedup/merge pointer, an unknown area, or any
attached report / hazard / bounty / favourite / put-in / track / sub-area).

**Why not one pass.** Two passes that both delete will disagree at the edges, and the edge here is
user content. One deleter, one reporter. The report is the phase's own check that the corpus matches
its stated rules — the same discipline as the ETL drop ledgers, applied to what survived rather than to
what was refused.

---

## D99 — Every pass in the campaign is run-logged, and the ledger is wiped first

**Proposed.** This phase is a **full re-import of everything**, not a bathymetry fix, and the run
ledger has to show it as one campaign.

Five packages participate, and all five already use `@skating/run-log`: `scripts/etl` (canonical
water), `scripts/admin-areas`, `scripts/lake-depth` (depth + elevation), `scripts/bathymetry`
(snapshot, join, build, coverage), `scripts/wind-climate`. Every stage runs under one `--campaign`
id so the whole campaign is one object in `/admin/imports`.

**Wipe the existing rows first.** The current ledger is a partial record of an abandoned run: 36 rows
sampled, with **three still marked `running`** (an `elevation` pass since 02:18, `wind_climate` since
03:05, an `r2_mirror`), one `elevation` and one `lake_depth` marked `failed`. None of it describes the
corpus we are about to build, and leaving it means the first honest campaign is read against a
backdrop of stale failures. Wipe, then run.

---

## D100 — Downstream enrichment runs only against the corpus we keep ✅ **APPROVED**

**Approved by the founder, 2026-08-03:** *"Since we're combining three sources to build our corpus,
then applying our own filters, all downstream data population (including wind) should work off of only
the corpus we chose to keep, not waste time."*

**This inverts the ordering this plan shipped with.** The draft put the prune at step 12, last, on the
strength of D91's ordering trap — *`importContourCoverage` replaces the coverage set, so prune first
and re-tile later and lakes silently drop out of coverage and are then deleted.*

**That trap does not apply once the floor is purely area and name, which is what D91 settled.** The
trap existed to protect an *"…or an agency surveyed it"* tier, and **that tier was proposed and removed
the same day** (D91, founder call). Without it, nothing about the floor depends on any downstream pass:
`meetsAreaFloor` reads `surfaceAreaSqM` and `name`, both known at transform time. So the floor can be
applied at import and the surviving corpus is final before a single third-party request is spent.

The danger the trap describes is the **reverse** order — prune, then re-tile against a coverage set
built earlier. Under this ordering the coverage set is rebuilt *after* the prune, against the pruned
corpus, so it is consistent by construction. The rule to keep is therefore not "prune last" but:
**nothing that computes coverage may read a corpus older than the prune.**

**What it saves is not incidental.** Every metered pass in the campaign is priced per body:

| pass | metered by | why the order matters |
| --- | --- | --- |
| wind climate | 5.3 s and one WTK request per cell-year | 1,061 qualifying bodies was measured against the *old* floor; the number can only have gone down |
| elevation | Open-Meteo counts **coordinates**, not requests | see D101 — this stops being metered at all |
| depth join | Convex transaction bytes | fewer bodies, fewer batches, fewer 16 MB near-misses |
| bathymetry | local, but O(bodies) per probe | the density gate probes every candidate body |

Bodies below the floor are deleted at the end of the campaign under the old order — so every request
spent on them was spent on a row that does not exist by morning.

---

## D101 — Elevation comes from data we already hold, not from a metered forecast API ✅ **APPROVED**

**Approved by the founder, 2026-08-03.** The elevation pass is the campaign's worst bottleneck and it
is self-inflicted: `loadElevation` reads Open-Meteo, whose free tier counts **each coordinate**, not
each request — so batching buys HTTP overhead and no quota at all. The N6c run stalled at **5,975
stamped, page 86 of ~248**, and it competes for that allowance with `weather.ts`'s forecast crons,
which are the product itself.

**We already have the data for the lakes that matter.** HydroLAKES — downloaded, checksummed and
mirrored to R2 for N6a — carries an **`Elevation`** attribute alongside the `Depth_avg` we ingest from
it. It covers lakes ≥ 10 ha, which is ~100% of what draws at regional zoom and every body a decile
statistic is computed over. For the remainder, **USGS 3DEP** is a one-time raster download sampled
locally, with no per-coordinate accounting and no shared allowance.

**NHD's own `elevation` field is not the answer, checked and ruled out 2026-08-03.** `NHDWaterbody`
carries an `elevation` attribute, which looked like a free win sitting inside an archive we were
downloading anyway. It is populated on **1,300 of New Hampshire's 52,999 waterbodies — 2.5%**, and on
1,086 of the 8,257 above the area floor (**13%**). Not a source; a field that exists. Recorded here so
nobody spends an afternoon rediscovering it.

**Measure before switching, not after.** The pass to run first is a read-only coverage comparison:
what fraction of the *post-prune* corpus does HydroLAKES `Elevation` cover, what does 3DEP add, and
where do the two disagree with the ~5,975 rows Open-Meteo already stamped. A source swap that silently
changes a datum would move every decile in `regionStats` and look like a data-quality improvement.

**The general lesson, worth stating once:** the first question about a metered pass is not "how do we
pace it" but "why are we paying for this at all". Elevation is a static property of a fixed point;
nothing about it needed a forecast API.

---

## Acquiring NHD — R2 first, never REST at volume

Agreed with the founder: **download the NHD database, mirror it to Cloudflare R2, then run against the
mirror.** Everything measured so far came from point and count queries against the live ArcGIS
service; 564k features with geometry is not a REST paging job.

- Prefer the state or region **File Geodatabase** from the National Map, read with `ogr2ogr` — already
  a prerequisite of `scripts/bathymetry`, so no new tool.
- Archive it the way `scripts/bathymetry` archives its sources: immutable `.raw/`, a manifest with
  sha256 and fetch date, never overwritten without `--refresh`. Reprocessing must be free, because
  D92's bake-off will want several passes over the same bytes.
- Mirror through the existing `scripts/lib/mirror-r2.sh` lane.
- **Resolve the exact artifact before writing the fetcher.** Discovering the wrong one at 2 GB is the
  expensive way to find out.

### The artifact, resolved (2026-08-03)

`https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/State/GDB/NHD_H_<State>_State_GDB.zip`

| state | bytes | | |
| --- | --- | --- | --- |
| Maine | 189,360,917 | New Hampshire | 110,796,389 |
| Vermont | 139,834,230 | Massachusetts | 131,867,834 |
| New York | 396,742,381 | **total** | **968,601,751 (924 MiB)** |

All five are `LastModified: 2023-12-27` — the final snapshot, see the kickoff findings above.

**Choose GDB over GPKG.** Both are staged (`…/State/GPKG/` exists alongside), both read with
`ogr2ogr`, and GPKG is roughly **2.2× larger** — Maine is 425 MB as GPKG against 189 MB as GDB, New
York 920 MB against 397 MB. There is no capability difference for our use.

**R2 headroom is fine and was checked, not assumed.** Current usage is ~3.2 GB of the 10 GB free tier
(`skating-basemap` 978 MiB, `skating-raw-lake-depth` 840 MiB, plus `skating-raw-bathymetry` and
`skating-raw-osm-extracts`). NHD adds 0.92 GB and the wind archive will add 0.37 GB, landing around
4.5 GB.

**A sixth object per state comes free and should be taken:** the `.xml` FGDC metadata sitting beside
each `.zip` is ~29 KB and is the provenance record — publication date, process lineage, the licence
statement. Archive it with the payload, the way `DepthManifest` archives a data dictionary.

**3DHP is acquired separately and later.** Its downloadable product is on ScienceBase rather than the
staged-products tree, and it is only needed for the bake-off's third lane — so it must not block the
NHD acquisition or the corpus build. Resolve its artifact when the bake-off is written.

### ✅ Done, 2026-08-03 — step 1 of the campaign

All five states archived to `scripts/etl/.raw-nhd/<state>/` and mirrored to **`skating-raw-nhd`**
(15 objects, 924 MiB: a zip, an FGDC `.xml` and a manifest each). Every state passed both checks —
**exact byte count** and **freeze date unmoved from 2023-12-27**. R2 now sits at **3.91 GiB of the
10 GB free tier**.

| | sha256 |
| --- | --- |
| NH | `68c90ef7b0241624…` |
| MA | `b529e30886cc475f…` |
| VT | `d35026b193ecf18c…` |
| ME | `75b193ccf345fdf6…` |
| NY | `dd1bbe1b9b7f63c3…` |

**Beau Lake is in the Maine archive**, not merely on the REST service:
`{85383A01-DC89-47AA-BC5D-BE373FB0B5C3}`, `areasqkm 7.594` = 1,876.6 ac, FTYPE 390. The phase's
headline fixture is now local and checksummed.

**One latent bug fixed on the way in.** `scripts/lib/mirror-r2.sh` now passes `--s3-no-check-bucket`
on every rclone call. rclone issues a `CreateBucket` before its first upload to a bucket it has not
already seen succeed, and R2 answers **403 AccessDenied** for any Object Read & Write token — which is
every token we use, correctly so. It only bites an *empty* bucket, which is why four mirrors worked
and this surfaced on the fifth. **`skating-raw-wind-climate` is also empty** and would have hit the
same wall on its first push.

---

## Ordering — the trap is already documented and gets worse with two sources

D91 records it: **`importContourCoverage` replaces the coverage set.** Prune first and re-tile later,
and lakes silently drop out of coverage and are then deleted. **D100 resolves this**: the rule that
survives is not *"prune last"* but *"nothing that computes coverage may read a corpus older than the
prune"* — and under the order below, nothing does.

```
 0  wipe the run ledger; open one campaign id                  (D99)
 1  acquire NHD → .raw/ → R2                                   (no Convex writes)
 1b acquire 3DHP waterbodies → .raw/ → R2                      (no Convex writes; D92 lane 3)
 2  reconcile OSM ↔ NHD ↔ 3DHP by polygonIoU                   (writes catalogue ids only)
 3  D92 bake-off, containment-passing keys only                (read-only; produces the rule)
 4  mint waterBodyKey; backfill osmId / nhdId / geometrySource (D93)
 5  canonical re-import: unified corpus, floor applied         (scripts/etl)
 6  PRUNE — the corpus is now final                            (D100; nothing metered runs before it)
 7  audit report of non-conforming bodies                      (D97, read-only)
 8  admin areas                                                (scripts/admin-areas)
 9  depth + elevation                                          (scripts/lake-depth; D101 for elevation)
10  bathymetry: re-key → join → build → tile → coverage        (D95, in this order, always)
11  wind climate                                               (scripts/wind-climate — the 7.7 h fetch)
12  regionStats recompute                                      (derived from 9/11 — must run last)
```

Steps 1–4 are safe against a live corpus. Step 5 onward are not.

**Step 6 is the change D100 makes, and its position is the whole point.** Every pass from 8 onward is
priced per body — WTK requests, Convex transaction bytes, density probes — and under the old ordering
all of them were spent on rows that step 12 then deleted. The prune moves to the first moment it is
possible: immediately after the import that establishes what the corpus *is*.

**Step 11 sits last among the metered passes deliberately.** It is the only irreversible spend in the
campaign (7.7 hours, 5,225 WTK requests) and it must see the smallest possible qualifying set. Its
scope figure of 1,061 bodies was measured against the *old* floor and can only have fallen; re-measure
with `--dry-run` before committing to it.

**Step 12 is D85's rule**: the deciles describe the corpus as loaded, so running them early describes
the corpus as it *was*. Note this is a **first** computation, not a refresh — `regionStats` is empty on
dev.

---

## Verification — named fixtures, not coverage percentages

The reconciliation is the piece most likely to fail **quietly**, so it is checked against known
answers:

- The five OSM duplicate pairs **must** collapse to one `nhdId` each (Long Pond, Lovell Lake, Duncan
  Lake, Meadow Lake, Bolster Pond).
- North Bay **must not** inherit Moosehead Lake's `nhdId`.
- Moosehead Lake **must** get one, despite its `centroid` sitting on its own shoreline.
- Beau Lake **must** arrive in the corpus at ~1,875 acres, with bathymetry.
- The D91 floor applied to the 42 Maine bathymetry misses admits **41** and refuses 1 (an unnamed
  3.4-acre pond). A different number means the floor logic diverged between core and the ETL.
- MIDAS 870 **must** re-key into ~217 drawable bodies; 5448 (**China Lake**, a real 3,939-acre lake
  with 25,807 legitimate soundings) **must not** be touched by the re-key lane.
- After D98's recalibration, the set of lakes that stop drawing **must** be enumerated and reviewed,
  not summarised.

---

## New York has no native bathymetry source — the layer's largest gap

**Found at kickoff, 2026-08-03, and not previously recorded anywhere.** `scripts/bathymetry/src/sources.ts`
holds five entries: NH GRANIT contours, two Vermont sounding sets, MassGIS contours, and Maine DEP
soundings. **New York has none.** Its only coverage is Lake Champlain, and that arrives through
*Vermont's* VCGI service — whose own notes say so: *"Covers the whole lake, so it is also our only New
York coverage."*

New York is the largest state in the corpus by NHD volume (397 MB against Maine's 189 MB) and holds
the Adirondacks. Nothing in the layer draws there.

**Founder call (2026-08-03): investigate and report back before building anything.** NYSDEC publishes
lake contour maps, and a *DEC Lake Contour Maps* layer exists on `data.gis.ny.gov`; USGS has
higher-quality bathymetric DEMs for a handful of specific waters (the East-of-Hudson reservoirs, Lake
Gleneida, Seneca). What is unknown and must be measured before a sixth source is written: **how many
distinct lakes it covers, whether it is contours or soundings, its licence, and whether it clears the
same quality bar the other five did.** Report the number first; a fetcher is cheap once the answer is
known and wasted if it isn't.

---

## Open items, flagged rather than buried

**The count of wrong matches in the first bathymetry build is unverified and was overstated.** An
earlier "21 violations, 9 shipped wrong" rested on taking the first state row per `MIDAS_NUM`. Maine
files some lakes as several rows — **Moose Pond has five, three of them 0.0 acres**, and MIDAS 9861
holds both Long Pond (651 ac) and Lewiston Pond (24 ac) — so that comparison measured surveys against
fragments and manufactured mismatches. **Moose Pond → Millinocket Lake was a false example**; the real
lake is 2,730 ac against a 2,158 ac body, 1.27×. The wrong matches that survive scrutiny are Caribou
Lake → Ripogenus Lake (15.7×) and Fahi Pond → Mud Pond (22.3×), both now rejected at 5% containment.
**Aggregate rows per MIDAS before quoting any figure from this layer.**

**Nine containment rejects sit at 39–49%**, just under the 0.5 threshold — Yoke Ponds, Wallagrass
First Lake, Pleasant Lake, Upper Crow Hill Pond, Broad Bay. The plural names are a hint: these look
like one key spanning two bodies, which is exactly what D95's rule 2 handles. Re-check after the
re-key lane exists; tuning the threshold would be the wrong fix.

**655 of MIDAS 870's soundings (3.7%) fall outside every body** — lakes not in the corpus at all,
which D92's unified corpus should absorb. Re-measure after step 5.

**NHD segments differently from OSM.** Sherman Lake returns as `FTYPE 493` at 30.6 ac against the
state's 215.1. One-to-many disagreements are not fixable by any id scheme and will need a rule or a
human; quantify them during the bake-off rather than meeting them in production.

**The exact post-prune corpus count is unconfirmed.** ~21,000 is the founder's figure and D91
predicted 21,660 of 123,940. Establish it precisely at kickoff; every "how much did this add"
statement in this phase is measured against it. **There is no cheap way to ask right now** — no
corpus-count function exists, and a one-off query cannot scan ~21,000 rows inside Convex's 16 MB read
cap. The first deliverable of the campaign is a paged internal counter, which the audit pass (D97)
needs anyway.

**The N6c campaign's own passes are unfinished and this campaign subsumes them.** Elevation stopped at
5,975 of ~11,000 on quota (now D101's problem); wind stopped at ~2% deliberately; `regionStats` never
ran and is empty. Nothing here needs resuming — it needs re-running against the corpus step 6
establishes. The wind archive rebuild described in `HANDOFF-wind-climate-archive.md` is a **hard
prerequisite of step 11**: without the `.raw/` split, the 7.7-hour fetch is spent and then spent again
the first time a threshold moves.

---

## Related

[D48](./01-decisions.md), [D72](./01-decisions.md), [D85](./01-decisions.md),
[D91](./01-decisions.md), [`phase-1`](./phase-1-water-bodies.md),
[`phase-N6a`](./phase-N6a-lake-depth.md), [`phase-N6b`](./phase-N6b-bathymetry-layer.md),
[`phase-N6c`](./phase-N6c-expanded-lake-profiles.md).
