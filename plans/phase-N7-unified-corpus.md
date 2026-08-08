# N7 — The unified corpus: one record per lake, two catalogues behind it, and a full data campaign on top

> **Status:** ✅ **The corpus is LIVE on dev — campaign `n7-2026-08-07`, steps 0–6 complete**
> (2026-08-07). Originally written 2026-08-03 after a measurement session that corrected four of its
> own findings; the numbers below are the survivors, and anything still marked *unverified* is marked
> that way on purpose.
>
> ### ✅ The campaign, as run — steps 5, 5b and 6 (2026-08-07)
>
> ```
> 25,133 bodies loaded    9,136 inserted · 15,997 updated · 175/175 batches
>                         0 failed · 0 conflicts · 0 queued for merge
>    111 sub-areas        120 total on dev, 0 orphaned
>  2,322 pruned           8.4% of 27,519 · 64 protected · 0 deletable rows remain
> ─────────────────────
> 25,197 stored           25,133 re-affirmed + 64 protected
> ```
>
> **`resolveUpsert` returned zero conflicts and zero merge verdicts across 25,133 bodies**, which is
> D93's ordering rule (reconcile at step 2, import at step 5) validated against real data rather than
> argued. 15,997 bodies were **patched in place**, so their `_id`s never moved and every attachment
> survived.
>
> **D109's vocabulary migration is finished**: `backfillWaterBodyClasses` rewrote the last 53 rows —
> the protected ones, which by definition the loader can never reach — and reports `unmappable: 0`.
> The schema's `type` union may now be **narrowed** to `WATER_BODY_CLASSES`; that is the one step of
> the widen→deploy→backfill→narrow order still outstanding.
>
> **Three limits that only bind on real data**, all found by the load and all fixed:
> `pruneNotInCampaign` advertised a 500-row page while `bodyAttachmentKind` costs **10 index reads**
> per candidate against Convex's 4,096 cap (capped at 250); the sub-area artifact carried
> **unsimplified** geometry, so a clip against Moosehead blew the 1-second mutation budget; and the
> bay batch size ignored a measurement sitting in the file it was written to mirror — `importSeed`'s
> *"comfortable alone"* — settling at **1**.
>
> ### 🔍 The intake audit, 2026-08-06 — D113–D117
>
> A full audit of the path from three archives to one master list, requested because it is the most
> load-bearing pathway in the project. It found **five things that would have failed or silently lost
> data on the next run**, and they are all fixed:
>
> | | |
> | --- | --- |
> | **The wire contract was broken.** `merge.ts` emitted `states`, `CanonicalBody` declared it, and Convex's validator did not have the field — and Convex object validators are exact, so **every batch of a merged load would have been rejected**. Adding the field alone was not enough: the handler read a `--state` CLI flag a single-pass load does not have, so it would have written 27,000 rows with no state and emptied every regional filter. | D116 |
> | **`confidence.ts`'s entire output was discarded.** The merge computed D110's per-attribute scores and the review reasons, tallied them into three lines of terminal text, and stored nothing — so a **1,388-body review queue** could never be opened by anybody. | D115 |
> | **The merge kept no ledger and wrote no run row.** D99 says every pass is run-logged; the pass that decides all 27,074 rows was the one that was not. Eight exits dropped records uncounted, the largest being the one-acre floor — ~64% of raw OSM, with no number at all. | D113 |
> | **Step 6 had no implementation.** `importCanonical` never deletes, so a re-import leaves the corpus as the *union* of the master list and whatever was there before. Every stored body the current rules refuse survives forever. | D115 |
> | **Beau Lake, the phase's own fixture, was wrong.** It merged at 2,457 acres against Maine's published 1,788 — and D92's per-lake override, named as the fix, **had no producer**: the bake-off's scores went to a scratch file nothing read. | D117 |
>
> …plus the veto that depended on a match succeeding, an explicit refusal losing to another source's
> silence, a floor and a prune reading two different areas, `inRegion` dropping 35,637 bodies on an
> eight-vertex sample, a bbox-only bay-parent test wrong in both directions, and `merge.ts` re-running
> the entire five-state GNIS download on every run because it imported a constant from a module with a
> `main()`. See **D113–D117** in [`01-decisions.md`](./01-decisions.md).
>
> ### 🔍 The second intake audit, 2026-08-06 — D118–D124
>
> Requested because the first pass was significant enough to be worth a second one before the flow
> runs against real data. It found **four things that would have lost data on the next run** and three
> that were already wrong in the output, all now fixed:
>
> | | |
> | --- | --- |
> | **A missed match is a duplicate, not a gap.** Identity is keyed on catalogue ids, so a group with no OSM member inserts a *second row* beside the lake we already had. Measured on the master list: **632 overlapping pairs at IoU ≥ 0.3, 408 of them sharing a name** — `Peabody Pond` 7 ac beside `Peabody Pond` 16 ac. The cause is structural: `scoreCandidates` skips any pair whose areas differ by more than 2×, which is most small-pond disagreements — and is also the measured answer to the long-open *"OSM↔NHD matches 33% and nobody knows why"*. | D118 |
> | **Salt water was in the corpus** — Great Bay 4,301 ac, Little Bay 1,826, Waquoit Bay, New Bedford Harbor, ~360 bodies. The token veto only fires when the federal estuary polygon lands in the group, and one estuary against forty OSM coves never does; the bay rule then demoted each cove to `unclassified` and admitted it. The veto is now **spatial**. | D119 |
> | **The name veto deleted two real New York lakes.** `Lake Superior` (179 ac, Sullivan County) and `Little Lake Erie` (4 ac) both match a substring rule aimed at the Great Lakes. Gated on area. | D120 |
> | **A `conflict` verdict plus step 6 deleted both rows.** `importCanonical` wrote nothing on conflict, so neither row was stamped and the prune removed the evidence of the uniqueness violation. Plus: a load with failed batches leaves ~150 real lakes unstamped per batch, and the prune would delete them. | D124 |
> | **Bays were bodies.** `West Branch Keuka Lake`, `Spencer Bay`, `Alton`/`Paugus`/`Meredith` Bay — all stored as rows overlapping the lakes they are arms of. They are sub-areas now. | D121 |
> | **The counts balanced and the identities were nowhere.** ~100,000 floor-refused groups and 35,637 out-of-region ones left no names at all, and nothing compared one run to the last. `dropped.ndjson`, a manifest delta, and `geometry-review.ndjson`. | D123 |
> | **The extraction had stopped at the rules.** `merge.ts` was still excluded from coverage while holding the *order* the rules run in — which is where every ordering bug in this phase has lived. `masterList.ts` is the second extraction, covered end to end. | D123 |
>
> Settled and deliberately **not** changed: cross-border bodies still enter whole, with
> `inRegionFraction` stored as evidence rather than used as a gate (**D122**), and the 26
> `river`-class bodies (deadwaters, stillwaters) stay.
>
> **✅ Run 6, 2026-08-07 — and runs 2–6 each found something the one before could not.** The master
> list is **25,133 bodies + 112 sub-areas + 153,211 named drops = 178,456 groups**, asserted rather
> than printed. Pre-load checks clean: **0 bodies with no state, 0 duplicate catalogue ids**, so the
> load cannot silently collapse two bodies into one row. The headline find of the later rounds:
> **`gnisRescued` fell 1,771 → 921 — 850 bodies were being admitted on a neighbouring pond's name**,
> because the gazetteer's ambiguity rule only refused *many points → one body* and never the mirror.
> See D118–D125. Superseded numbers from the first re-run:
>
> **~~Re-run clean against committed code, 2026-08-06.~~** The master list is now **25,472 bodies +
> 113 sub-areas + 152,736 named drops = 178,321 groups**, and that equation is asserted rather than
> printed. 943 tidal bodies refused; the name lane recovered 369 pairs the area-ratio ceiling had
> rejected; 497 overlapping pairs remain and are flagged for the queue; 322 bodies carry a
> `classDissent` that nothing could previously see. Every named fixture verified in the output —
> **Beau Lake now arrives at 1,871 ac from NHD**, `Lake Superior` NY and `Little Lake Erie` survive,
> Braddock Bay survives, and Great Bay / Saco Bay / Cobscook Bay / Merrymeeting Bay are gone.
>
> **⚠ The architecture changed after this document was written.** It describes a campaign that
> filters each source, reconciles against the *live corpus*, and imports on top of it. What got built
> inverts that: `scripts/etl/src/merge.ts` reconciles the three archives **offline** and emits one
> master list, on the rule **merge first, filter once**. Sections written against the old shape are
> flagged inline. See [`HANDOFF-n7-classification.md`](./HANDOFF-n7-classification.md).
>
> **Depends on:** the D91 area floor and its prune (both landed, 2026-08-03), the N6b containment join
> (landed, tiles **not** rebuilt), and the `osmId`/`nhdId`/`geometrySource` fields — **landed and now
> backfilled**, see the step list.
> **Touches:** every ETL package — `scripts/etl`, `scripts/admin-areas`, `scripts/lake-depth`,
> `scripts/bathymetry`, `scripts/wind-climate` — plus `waterBodies` identity, and every downstream
> that keys off `externalId`.
> **Decisions:** **D92–D105**, proposed here, to be logged in [`01-decisions.md`](./01-decisions.md) at
> build kickoff. D91 is the last one logged. **D95 and D100–D105 are approved** (founder, 2026-08-03).
> D92 was widened to three catalogues and then **narrowed back to two** by measurement.
> **Steps 1 and 1b (NHD + 3DHP acquisition) are ✅ done**, 2026-08-03 — see the acquisition section.
> **D92 is back to two-way**: 3DHP was measured against NHD over 7,878 lakes and is the same data.

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

**8. Every identifier in this phase has more than one spelling, and each one fails silently.** Four
found so far, all by measuring rather than by reading docs:

| id | spellings | consequence of getting it wrong |
| --- | --- | --- |
| NHD `permanent_identifier` | brace-wrapped GUID from REST, bare GUID from `ogr2ogr`, **and plain numeric** — **76.4%** of Maine's post-floor GNIS-keyed rows are numeric (`141034078`), only 23.6% GUIDs | a GUID-only rule drops three quarters of Maine's lakes from reconciliation, with no error |
| GNIS id | NHD zero-pads to a string (`"00869848"`), 3DHP stores an int (`561883`), OSM tags `gnis:feature_id` | joined raw over Maine: **0 of 3,031** matched. Normalised: **3,007** |
| NHD field names | lower-case in the geodatabase, upper-case from REST | every measurement taken before the archive existed used the REST spelling |
| CRS | NHD HR is **NAD83 (EPSG:4269)**; 3DHP staged is **NAD83(2011)/Conus Albers (EPSG:5070)**, a metre grid | `ogr2ogr -spat` reads its envelope in the *source* SRS — a degrees box against Albers selects ocean and the clip "succeeds" empty |

**The pattern is the finding.** In each case the wrong rule produced *silence*, not an error: an empty
join, a missing id, an empty clip.

### ✅ Fixed as a mechanism, not as four fixes (2026-08-03)

`@skating/run-log` gained a **`DropLedger`**. A normalizer now returns a **reason** instead of
`undefined`; the ledger tallies each reason with a bounded sample of the offending raw values; and
**`expectAcceptance` throws** when a rule drops more than its census says it should. A warning inside a
twenty-minute ETL log is indistinguishable from silence — an exception is not, and it carries the
breakdown and the samples, so it is the diagnosis rather than the start of one.

Reasons are three separate facts because they mean three different things. **`absent` is normal**
(71.7% of NHD's post-floor rows carry no GNIS id). **`sentinel` is healthy data** the publisher wrote
deliberately. **Only `malformed` indicts the rule**, and only it counts against the floor.

> **That last distinction was found by the mechanism catching itself.** The floor first excluded only
> `absent`, and the very first real audit run failed at 93.1% — entirely because 1,032
> correctly-identified sentinels were being scored as parse failures. The semantics were fixed rather
> than the number lowered, because a floor that cries wolf gets ignored, which is exactly what this
> exists to prevent.

**The sentinel deserves naming on its own.** NHD writes `gnis_id = -1` on **1,032 post-floor rows
across four states** — cross-border Québec lakes (`Lac des Ours`, `Étang Payeur`, `Lac Coulombe`) with
no US GNIS entry. Treating it as an identifier would **collapse 855 unrelated lakes onto one body**.
Before the census it was rejected only as a side effect of the minus sign failing a digits test: the
right answer reached by accident, uncounted, and one refactor from catastrophe.

**And `pnpm --filter @skating/etl audit-archives` re-derives every rule from the archives** and asserts
it against the census stored beside it (`NHD_ID_CENSUS`, `GNIS_ID_CENSUS` — data, not prose, so next
year's release is checked against this year's rather than against memory).

---

## The archives are audited and clean (2026-08-03)

`audit-archives`, run against all five NHD states plus the 3DHP clip:

```
nhdId    53,130 / 53,130 accepted          ← the rule now covers 100% of the archive
gnisId   13,991 accepted · 38,107 absent · 1,032 sentinel · 0 malformed
distinct nhdIds                    40,928  from 53,130 rows
duplicated across state files        9,792  ← the known overlap, expected
duplicated within a single file          0  ← would be a real conflict
shared ids whose areas DISAGREE          0  ← so dedup is lossless, not a coin flip
3DHP   274,994 rows / 274,994 distinct id3dhp    ← clean primary key
GNIS   10,984 distinct · 92 resolve to >1 body (0.8%)
```

**No duplicates, no conflicts, no format surprises.** The 9,792 cross-file repeats are the state
geodatabases' known overlap and every copy agrees on area to six decimals, which is what makes
deduping on `permanent_identifier` safe. The 92 fan-out GNIS ids are the split-lake case, and they are
the measured reason GNIS proposes while `polygonIoU` decides.

---

### The rule that started it, kept for the record

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

**✅ Measured on dev after the campaign, 2026-08-07.** This is the number every later claim is against.

| | | | |
| --- | --- | --- | --- |
| **total** | **25,136** | listed | 25,136 |
| `geometrySource` | 25,197 (100%) | `nhdId` | 20,467 (81%) |
| `osmId` | 19,289 (77%) | wind rose | 0 |
| depth | 5,662 (22%) | elevation | 5,716 (23%) |
| sub-areas | 120 | of which N7-seeded | 111 |

**by class** — `lakePond` 17,637 · wetland 3,838 · reservoir 2,471 · unclassified 1,223 · river 26 ·
bay 2
**by state** — NY 9,483 · MA 5,799 · ME 5,521 · NH 3,097 · VT 1,347 *(border bodies count in each)*

**`bay` is now effectively unreachable for a canonical body** and the two survivors are legacy rows.
D121 sends a bay with a parent to `waterBodySubAreas` and demotes one without a parent to
`unclassified`, so the merge cannot emit the class at all. It remains in `WATER_BODY_CLASSES` for
user-created water and for the picker.

### The figure this replaced, kept because the arithmetic below still leans on it

"116,070 bodies" described the corpus *before* the D91 floor; the floor brought it to **18,383**, and
the campaign took it to 25,197 — a **+37% expansion**, most of it NHD lakes OSM has never carried.
Against a 116k corpus an NHD gap-fill was a rounding error; against 18k it is the phase.

---

## What is already built, and what is now back in question

| Landed | Where | State |
| --- | --- | --- |
| `osmId` / `nhdId` / `geometrySource` + `by_nhd_id` | `convex/schema.ts` | built, deployed, **backfilled** (2026-08-05) |
| `backfillCatalogueIds` — paginated, idempotent, never overwrites | `convex/waterBodies.ts` | built, **run** |
| `mintWaterBodyKeys` (D93) | `convex/waterBodies.ts` | built, **run** — every sampled row carries a `waterBodyKey` |
| `resolveUpsert` / `requiresReview` (D93's upsert key) | `core/bodyIdentity.ts` | built + tested, **wired to nothing** |
| `merge.ts` — the master list, three lanes, one filter | `scripts/etl` | built, run; **untested and excluded from coverage** |
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
>
> ### 🔬 Measured, 2026-08-03: it happens **every time**. The bake-off is two-way.
>
> Both archives are on disk, so the question got answered before the bake-off was written rather than
> during it. Joining NHD to the 3DHP clip on normalised GNIS id, restricted to bodies matched **1:1**
> on both sides and above the D91 floor:
>
> | state | matched 1:1 | identical area (exact float) | differ < 0.1% | **differ ≥ 0.1%** | worst |
> | --- | --- | --- | --- | --- | --- |
> | ME | 3,003 | 2,090 (69.6%) | 913 | **0** | 0.0000% |
> | VT | 953 | 624 (65.5%) | 329 | **0** | 0.0000% |
> | NY | 3,922 | 2,668 (68.0%) | 1,254 | **0** | 0.0000% |
>
> **7,878 lakes, zero disagreements at or above 0.1%.** The ~32% that are not exact are float
> round-trip through the Albers reprojection — the largest "disagreement" prints as `0.5024 vs 0.5024`.
> Segmentation differs on 4 of 3,007 in Maine.
>
> **Elevation-derived hydrography has not reached the Northeast.** 3DHP's waterbody layer here is NHD,
> republished. So:
>
> 1. **D92's bake-off is OSM vs NHD.** Running a third lane that is provably the second lane would
>    manufacture a three-way result out of a two-way fact, and cost the effort twice.
> 2. **The 3DHP lane still earns its keep — as a divergence monitor, not a contestant.** It is the
>    channel through which EDH *will* arrive, and re-running this exact comparison each year is a
>    cheap, precise tripwire: the year the identical-area share drops, LiDAR-derived hydrography has
>    landed in our states and D92 genuinely becomes a three-way question. That is a better use of
>    417 MB/year than a bake-off lane, and it belongs in D102's runbook.
> 3. **`threeDhpId` still gets stored**, because "which 3DHP feature is this" is the question the
>    monitor asks, and it cannot ask it without the id.

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
- **`osmId` / `nhdId` / `threeDhpId`** — what this lake is called in each catalogue that knows it.
  More than one may be present, and once reconciled most will be. `threeDhpId` is populated, not a
  parity placeholder: 3DHP ships `id3dhp` on every feature.
- **`gnisId`** — the one identifier all three catalogues share, and the cheapest exact-match bridge
  between them. See below.
- **`geometrySource`** — whose outline we drew, so D92's per-lake override is a field and not a
  migration.

### Why not derive the key from geometry (founder question, 2026-08-03)

**Asked, and the answer is no — but the intuition behind it lands somewhere useful.**

The proposal was to mint the key from the body's own coordinates (a bbox hash, a geohash) so it would
be re-derivable on a later dedup pass. Three reasons it cannot be the *key*:

1. **D92 is the thing that breaks it.** The bake-off exists to possibly change *which catalogue draws a
   lake*. That changes the polygon → the bbox → the key. A geometry-derived id would move at exactly
   the moment identity must not, for every lake whose source we switched, in one pass, silently.
2. **It repeats `externalId`'s sin at a worse ratio.** `externalId` conflates identity with a foreign
   catalogue's key; a bbox key conflates identity with a *continuously edited measurement*. A mapper
   tightening one bay re-keys the lake.
3. **No quantization setting works.** Coarse enough to survive shoreline edits and it collides — bays
   nested inside parents (North Bay/Moosehead, below), 180 "Mud Pond"s, dense pond clusters. Fine
   enough to separate them and one vertex re-keys the lake. And we have already paid for the general
   lesson: `centroid` is Turf `pointOnFeature` and lands *on* the shoreline (Willoughby's at ring
   vertex 199, D85 amendment). Anything derived from a polygon inherits that value's pathologies.

**Where the intuition is right is the blocking key** — the cheap thing that narrows candidates before
an expensive `polygonIoU`. That is a real need and it is **already built**: N1's `waterBodyCells`
ladder-grid indexes every body by the cells its bbox covers. A dedup pass asks the grid for co-located
candidates, then computes IoU on the short list. So "re-derivable for dedup" is served by an *index*,
which is allowed to move, rather than by an *identity*, which is not.

**And the sharper question underneath:** if the re-import patches in place and never delete-recreates
(kickoff finding 10), the Convex `_id` never moves either — so what is `waterBodyKey` for? There is an
answer, but it is narrower than this section originally implied: **the tile stamp**. Contour tiles are
built offline and reference bodies by id; a restore-from-export mints fresh `_id`s and would break
every tile in the basemap bucket with no error, just blank lakes. Portability off Convex is the
second-order version of the same thing. **That is the argument, and it should be stated rather than
inherited.**

**Form: opaque and sortable** (ULID-style), not minted from whichever catalogue id we happened to see
first. The first-id version is more debuggable but reads as a provenance claim when it is not — the
exact failure `externalId` is being split up to escape. Debuggability comes from `osmId` / `nhdId` /
`gnisId` sitting on the row.

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

> **Add `gnisId`, and reconcile by it first.** The GNIS Feature ID is **the only identifier all three
catalogues carry** — OSM's `gnis:feature_id` tag, NHD's `gnis_id`, 3DHP's `gnisid` — and unlike
`polygonIoU` it is an *exact* match rather than a geometric inference. Measured against the Vermont
extract (18,260 water features): 361 carry one, **every single one of them is also named**, and it
covers **35.3% of named features**. Since named bodies are what survives the D91 floor and what anyone
drives to, that is a strong deterministic candidate generator to run *ahead* of IoU, free, from data
already in the extract.

**It is a candidate generator, not a uniqueness proof.** GNIS names *places*, so one id can legitimately
span two features where a catalogue splits a lake. It proposes; `polygonIoU` adjudicates.

**Reconcile by `polygonIoU`, never by point containment.** Measured, not assumed. North Bay's
> interior point sits inside NHD's *Moosehead Lake*, so a containment join hands a bay its parent's id
> — after which the bay and the lake look like duplicates of each other. Meanwhile Moosehead itself
> matches **nothing**, because `centroid` is Turf `pointOnFeature` and lands on the shoreline of any
> large irregular lake (D85 amendment). Both failures are silent.

### The upsert key — ✅ **solved and tested**, `@skating/core/bodyIdentity.ts` (2026-08-03)

**Flagged at kickoff as the hardest unsolved part of D93; now pure, tested logic rather than a plan.**
`resolveUpsert` takes the incoming feature's ids and what each one resolved to, and returns one of
four verdicts. The caller does the index reads; this makes the decision, which is what lets the
dangerous cases be tested exhaustively without a database.

| incoming matches | verdict | why |
| --- | --- | --- |
| nothing | `insert` | a lake we have never seen |
| one row, by one or more ids | `patch` | the normal case — in place, `_id` never moves |
| two ids → two **different** rows | `merge` | reconciliation missed a duplicate; never create a third |
| one id → two rows | `conflict` | the corpus already violates uniqueness; refuse to guess |

`requiresReview` gates the last two into the existing dedup queue rather than letting them run
unattended: an automatic merge that is wrong is unrecoverable in a way a queued one is not, and the
measured frequency says queueing is affordable.

**`gnisId` is deliberately not an upsert key.** It is the best *candidate generator* we have, but GNIS
names **places** and a catalogue may split one place into several features — **92 GNIS ids resolve to
more than one NHD body** (measured). Upserting on it would merge those lakes.

**One bug the tests caught before it shipped:** the default survivor rule read the first match in the
*caller's* array, not the first in `CATALOGUE_ID_FIELDS` order. Which row survived a merge would have
depended on the shape of someone else's lookup code — nondeterministic, and untraceable, because both
orderings look correct at the call site. Now ranked explicitly.

### The problem it was solving, kept for the record

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

### The wetland call, deferred on purpose (founder, 2026-08-03)

**Default: keep them.** *"So we're talking about wetlands larger than 5 acres without names? I might
let that become a moderation problem in the future rather than dropping them now."*

**And the size data supports that more strongly than the moderation argument does.** Measured
2026-08-03 — NHD New Hampshire's 4,089 unnamed post-floor SwampMarsh features band as 3,208 at
5–25 ac (78%), 502 at 25–50, 229 at 50–100 and 150 above 100 (largest 1,108 ac). The corpus's own
unnamed OSM marsh (534 in a 3,000-row sample; **zero below five acres, so the prune worked**) has a
median of 14.2 ac — and a **long axis with a median of 552 m, a p90 of 1,355 m and a maximum of
6,108 m**.

That last figure is the argument. D91 settled that *"area is the wrong axis"*: Keiser Pond is 36 acres
and 909 m long, *"a 1.8 km out-and-back, better skating than a round 30-acre pond 390 m across."*
**10% of these unnamed marshes are longer than Keiser Pond**, and some run 6 km. Linear bog and marsh
channels are plausibly skateable in a way that "unnamed 14-acre wetland" does not convey. Keeping them
is consistent with reasoning already committed to, not merely a deferral.

**The one measurement that would reverse this is not available yet, and is free at step 2.** What
matters is not how many wetlands NHD has but how many are **new** — the same bogs are very likely in
both catalogues, and reconciliation collapses them onto one row. If the increment is small, admitting
NHD 466 costs almost nothing. If it is large, five states of this is on the order of a **50% corpus
expansion in unnamed wetland**, which lands on read-path cost, tile size, the D2 prominence deciles,
and every metered pass in D100's table.

**So D96's wetland half stays open until reconciliation reports the increment.** Keep-them is the
standing default; revisit only on that number. The naming gradient stays recorded as the lever that
exists if it is ever wanted — it is a one-line change on both sides, and the two catalogues agree by
construction under it.

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

### 3DHP, resolved (2026-08-03) — and it forced a design call

**There is no per-state and no per-HU4 staging.** 3DHP ships CONUS-wide as one artifact:

| release | FileGDB | GeoPackage |
| --- | --- | --- |
| FY26, published 2026-01-21 | **11.9 GB** | ~22 GB |
| FY25, published 2025-03-20 | 12.0 GB | 22.4 GB |

`https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/3DHP/Annual/GDB/3dhp_all_GDB_FY26_CONUS_20260112/3dhp_all_CONUS_20260112_GDB.zip`

That is flowlines, catchments and hydrolocations for the entire country, to extract a **~300 MB**
waterbody clip for five states. The REST alternative holds **325,404 waterbodies** across our
five-state bbox, but `3DHP_all/MapServer/60` does not advertise `supportsPagination` and caps at
2,500 records, so it would be 130+ tiled requests — exactly the volume this section's own rule warns
against.

**Decision: download CONUS, clip locally, mirror the clip.** Settled by D102's annual cadence — see
below. Mirroring 11.9 GB would grow R2 by ~12 GB *per release*, which is a design error rather than a
storage question once the cadence is yearly. **This is the one source in the repo that archives a
derivative**, and what stands in for byte-faithfulness is the source manifest (URL, byte count, our
sha256 of the full download) plus the literal `ogr2ogr` command in the clip manifest. Re-deriving the
clip needs the 11.9 GB again; re-deriving anything *downstream* of it does not.

---

## D102 — The corpus refreshes annually, and only two of the three catalogues can ✅ **APPROVED**

**Approved by the founder, 2026-08-03:** *"Please also document this process so that we can run
re-imports for OSM and 3DHP every year to keep our maps up to date!"*

| catalogue | cadence | why |
| --- | --- | --- |
| **OSM** | any time — Geofabrik rebuilds daily | live, continuously edited |
| **3DHP** | **annually**, early in the federal fiscal year | new staged release, more EDH each year |
| **NHD** | **never** | retired 2023-10-01; the 2023-12-27 snapshot is terminal |

**This is not a scheduling note — it changes what D92 is measuring.** The bake-off compares three
polygons as they stand today. But two of the three sources improve every year and one cannot, so a
finding that *"NHD draws the better lake"* is a statement about 2023 with a shelf life, while a
finding about OSM or 3DHP is not. **D92's write-up must state the decay direction alongside the
result**, and a per-lake `geometrySource` override chosen on 2026 evidence has to be re-checkable when
the next release lands — which is exactly what D93's field-not-migration design buys.

**The runbook lives in `scripts/etl/README.md` §"The annual refresh runbook"**, not here, because the
person running it next year will be in the package rather than in a phase plan. It covers: how to spot
a new staged release, adding it to `THREE_DHP_RELEASES` (**add, never replace** — there is a test
asserting a predecessor survives, because "what changed this year" needs last year's entry), the two
fetches, the two mirror pushes, re-running the campaign from step 2, and the storage budget.

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

### ✅ Done, 2026-08-03 — step 1b of the campaign

3DHP FY26 acquired, clipped and mirrored to **`skating-raw-3dhp`** (2 objects, 409 MiB). The 11.9 GB
CONUS download verified byte-exact, was hashed (`5c2f868b24c1eb7a…`) and then deleted per D102's
retention rule; its manifest remains. **274,994 waterbodies**, 98% `featuretype = Lake`, no floor
applied — Beau Lake, Moosehead, Champlain and Lake George all present.

**R2 now sits at 4.31 GiB of the 10 GB free tier** across seven buckets.

**Trim parity, checked because the founder asked (2026-08-03).** The three lanes agree on the axes
that affect our data and diverge on one that does not:

| axis | OSM | NHD | 3DHP |
| --- | --- | --- | --- |
| geography | whole state, untrimmed — NY's `clipBBox` is *recorded in the manifest, not applied* | whole state GDB, in practice **wider** than the state | Northeast bbox |
| feature classes | everything OSM ships (roads, buildings, all of it) | all ~30 GDB layers | **1 of 7** — waterbody only |
| water class filter | none | none | none |
| **size floor** | **none** | **none** | **none** |

So no lane applies the D91 floor at acquisition, and no lane filters by water class — the floor and
the classifier stay downstream where redoing them is cheap. 3DHP keeps less of its *source*, and that
was forced by 11.9 GB against 417 MB. **The cost of that asymmetry, stated once:** adding an OSM or
NHD layer later is free, adding a 3DHP layer costs an 11.9 GB re-download. The only dropped layer
plausibly worth anything is `hydro_3dhp_all_flowline` — rivers and streams, which ties to the still-open
"no rivers in the corpus at all" question from N2.

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
 1  acquire NHD → .raw-nhd/ → R2                        ✅ done (no Convex writes)
 1b acquire 3DHP → clip → .raw-3dhp/waterbody/ → R2  ✅ done    (no Convex writes; divergence monitor, NOT a bake-off lane)
 1c acquire GNIS → .raw-gnis/ → R2                    ✅ done   (D105; the fourth lane, added after this list was written)
 1d admin areas from TIGER → adminAreas               ✅ done   (MOVED UP from step 8 — step 5 cannot run without it)
 2  reconcile OSM ↔ NHD ↔ 3DHP by polygonIoU          ✅ done   (writes catalogue ids only)
 3  D92 bake-off, refereed by our own soundings          ✅ done (read-only; OSM by default, ties 63%)
 4  mint waterBodyKey; backfill osmId / nhdId / geometrySource  ✅ done (D93)
 5  canonical re-import: the master list                 ✅ done (25,133 bodies, 0 conflicts)
 5b bays → waterBodySubAreas                            ✅ done (111 created; AFTER 5, BEFORE 6)
 6  PRUNE what step 5 did not re-affirm                 ✅ done (2,322 deleted, 64 protected)
 7  audit report of non-conforming bodies                      (D97, read-only)          ← NEXT
 9  depth + elevation                                          (scripts/lake-depth; D101 for elevation)
10  bathymetry: re-key → join → build → tile → coverage        (D95, in this order, always)
11  wind climate                                               (scripts/wind-climate — the 7.7 h fetch)
12  regionStats recompute                                      (derived from 9/11 — must run last)
```

Steps 1–4 are safe against a live corpus. Step 5 onward are not.

> **⚠ 5b sits between 5 and 6 and the order is load-bearing** (learned by nearly getting it wrong,
> 2026-08-07). The prune deletes the 112 bays *on the assumption that they exist as sub-areas*. Run
> it before 5b and they exist nowhere: Spencer Bay, Meredith Bay, North Bay and Alton Bay all appear
> in the prune's deletion manifest, and the manifest is the only thing that shows it. This is D100's
> ordering trap in a third place, and the reason the prune's dry run had to be made a *complete*
> list rather than a twenty-row sample.

**Three corrections this list has already needed, recorded rather than folded in silently:**

**Admin areas moved from 8 to 1d, and it is now a hard prerequisite of step 5.** `merge.ts` clips the
merged corpus to the five states using `boundaries.ndjson`. Without it there is no region mask and
35,637 out-of-region bodies import.

> **✅ That file now has a producer** (second audit, 2026-08-06). It had none: the only instruction
> for building the mask that decides 35,637 exclusions was a sentence inside `merge.ts`'s own error
> message, telling the operator to hand-page `adminAreas:listBoundariesForClip` out of Convex. That
> route also cost fidelity twice — TIGER outlines are simplified on the way *into* Convex to fit the
> 8,192-element array cap (Maine's is 18,932 vertices raw), so the corpus was being clipped against a
> coarsened copy of a boundary we hold verbatim on disk. `build-region` now writes it from the same
> TIGER archive at full fidelity, beside the two masks it already produced; the Convex export remains
> as a fallback and is the second choice. **The merge also asserts it found five state outlines** —
> `adminAreas` carried three for a year and nothing said so, and a mask short of a state still clips
> correctly, so the only symptom would have been tens of thousands of rows with no `states` value. It sat at position 8 because the old ordering filtered each source in its own extract, where
the extract's own bbox was the only regional statement — which is exactly the assumption
*merge first, filter once* removed.

**The region clip gained a second, different exclusion — D111.** New York south of I-84 is drawn on
the map and left out of the corpus, because a basemap with a world made "what we render" and "what we
claim to cover" two questions instead of one. It is counted apart from `outOfRegion` on purpose: that
number is the geodatabases spilling over their own state lines, which should stay roughly constant,
and at 35,637 it is large enough to hide a coverage decision inside. See
[D111](./01-decisions.md#d111--rendering-a-place-and-covering-it-are-two-questions-new-york-south-of-i-84-gets-one-answer-each-n7).

**Step 3 preceded step 5, and it was worth it — though not for the reason expected.** The worry was
that importing first would mean importing 27,074 outlines twice. The bake-off's answer is that **the
two catalogues are indistinguishable** (63.2% ties; 13.4% vs 12.6% on the least-confounded metric),
so OSM-first stands as the default on D92's own tie-break — the cheaper pipeline. The placeholder
turned out to be right, which is only knowable now. See
[D92](./01-decisions.md#d92--osm-draws-the-lakes-because-the-bake-off-found-no-reason-to-prefer-nhd-n7)
for the numbers, the per-lake override, and — importantly — **what this result cannot say**: the
referee set is built from the bathymetry join and therefore excludes every lake OSM is missing, Beau
Lake among them.

**Step 6 is no longer the D91 area-floor prune — ✅ and it is now built** (D115, 2026-08-06). Under the
old ordering the corpus was filtered on the way in and step 6 re-applied the floor to what was stored,
which is what `pruneBelowAreaFloor` does. Under *merge first, filter once*, the master list **is** the
corpus, so step 6's real job is to remove the stored bodies the master list does not re-affirm: a body
the class veto now refuses, a body the region clip now excludes. `importCanonical` never deletes and
`pruneBelowAreaFloor` can only see area, so neither could find them. 18,383 stored against 27,074 in
the master list, and neither set contains the other.

`waterBodies.pruneNotInCampaign` is that pass. `importCanonical` stamps `lastCampaignId` on every row
it touches, so membership is **asserted by the loader** rather than re-derived — a second copy of the
rules is how a prune and an import come to disagree at the edges, which is the failure D97 names. It
is dry by default, names the bodies it would delete rather than only counting them, and honours every
protection `pruneBelowAreaFloor` does: user-created, `includedByRequest`, a curated boost, a dedup or
merge pointer, a soft-delist, and any attachment.

```bash
# after step 5, with the same --campaign the load used
pnpm exec convex run waterBodies:pruneNotInCampaign '{"campaignId":"<id>"}'          # dry
pnpm exec convex run waterBodies:pruneNotInCampaign '{"campaignId":"<id>","apply":true}'
```

### ⚠ The region rule and the prune: what is automatic, and the one gap that is not

**Asked and answered on 2026-08-07, because the answer is not obvious from either pass.**

**In the normal case it is automatic.** An out-of-region body never enters the master list — the
merge's `inRegion` and `inDownstate` cuts happen before the emit — so it never receives a
`lastCampaignId`, so `pruneNotInCampaign` deletes it. Nothing extra to remember. This run:
35,620 out-of-region and 6,988 downstate bodies never reached `bodies.ndjson`, and the residue
already stored (Musquash Lake, Mashapaug Pond, Lac Arnold) went out with the 2,322.

**The gap is a body that is out of region *and* protected.** The prune spares six categories —
user-created, `includedByRequest`, curated, dedup-flagged, soft-delisted, and anything with an
attachment — and it checks them *before* it would delete. So a protected body never has the region
rule applied to it at all. That is exactly what the 22 downstate rows were: out of coverage **and**
dedup-flagged, and the flag won for two campaigns running.

**`pruneOutsideCoverage` is the backstop**, and its protection list is deliberately narrower — only
user-created and attached, because a *coverage* decision should not be overridden by a curated boost
or a dedup pointer. So the campaign is not finished until it has run and reported zero:

```bash
# after step 6, with the downstate mask build-region writes
pnpm exec convex run waterBodies:pruneOutsideCoverage "$(node -e '…downstate-ny-coarse.geojson…')"
```

**And one gap remains open, recorded rather than fixed.** `pruneOutsideCoverage` deletes what is
*inside* the polygons it is handed, so it covers the downstate cut and cannot express "outside the
five states entirely". A body that is both **outside the region** and **protected** is therefore
caught by neither pass. None exist today; if one ever does, the fix is an inclusion-mode argument on
that mutation (delete what is *not* inside), not a new pass.

> ⚠ **Do not run it after a load that reported failed batches** (D124). `load.ts` deliberately
> survives isolated batch failures, and every body in a skipped batch of ~150 is left unstamped —
> indistinguishable from a body the new rules refuse, and therefore deleted. The loader now says so
> at the moment you can still act on it, and the prune refuses any page more than a third deletions
> (`maxDeleteFraction`, default 0.33) as a backstop. The upsert is idempotent: re-run the load until
> it is clean.

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

## ✅ What blocked step 5 — cleared (2026-08-06)

The five gaps below were closed on 2026-08-05. The intake audit then found **five more**, all of
which would have surfaced during or after the load rather than before it, and all of which are now
fixed — see the status block at the top and D113–D117. The two that would have stopped the run
outright:

- **`states` was not in the `canonicalBody` validator** while the ETL emitted it. Convex object
  validators are exact, so every batch would have been rejected. And the handler ignored the field
  even once added, writing from a `--state` flag a single-pass load does not have.
- **The merge asserted nothing.** Two balance equations now run before it writes — `seen == kept +
  dropped` per lane, and `kept == emitted + emitFailed` across the two artifacts — and they throw.

The rest were silent rather than fatal: a discarded review queue, a missing step-6 prune, a per-lake
geometry override with no producer, a veto contingent on a match, and an admission floor reading a
different area from the prune that enforces it.

## What blocked step 5 (audited 2026-08-05)

The handoff records this as one item — *"`resolveUpsert` → `importCanonical`"* — and that
under-describes it. `resolveUpsert` is built and tested; wiring it is the smallest of five gaps, and
three of the others are schema changes that have to ship in the same deploy.

**1. ~~`master.ndjson` carries no geometry.~~ ✅ FIXED.** `merge.ts` now writes a second artifact,
`bodies.ndjson`, carrying full canonical records. The geometry half of `featureToCanonicalBody` was
lifted into a source-agnostic `toCanonicalBody`, so the OSM lane and the merge share one
implementation of D85's rule — measure the stats on the source geometry, simplify only for storage —
and the merge's own classification and floor decisions are no longer overruled by a second classifier
running inside the transform. `master.ndjson` remains, as the report it always was.

**2. ~~The stored vocabulary is the old one.~~ ✅ FIXED** by the D109 amendment — `waterBodies.type`
is `WATER_BODY_CLASSES`, with a union in the schema until `backfillWaterBodyClasses` reports zero
remaining. See D96 below.

**3. ~~Three of D93's identity fields do not exist in the schema.~~ ✅ FIXED.** `threeDhpId` and
`gnisId` are columns; `by_three_dhp_id` and **`by_osm_id`** are indexes. That second one was not on
the original list and turned out to matter most: the first draft looked `osmId` up through
`by_external_id`, which holds the same string *today* and is exactly the coincidence D93 exists to
end — it silently returned no match for a body whose two fields had diverged, and would have inserted
a duplicate. A test caught it. `3dhp` is now a value in both `WATER_BODY_SOURCES` and the new
`GEOMETRY_SOURCES`.

**4. ~~`catalogueIds()` derives ids instead of carrying them.~~ ✅ FIXED**, and the derivation
survives under its own name (`deriveCatalogueIds`) for one caller only: the backfill of rows written
before the identity fields existed, which genuinely has nowhere else to get them from.

**The update path asserts rather than overwrites**, which is a rule worth stating. The obvious
"incoming record is authoritative, write all of it" is wrong here because nothing in the mutation can
tell a *complete* merged record from a partial one — load one state's OSM lane by itself and an
overwriting rule silently wipes every `nhdId` in the corpus, 18,383 rows of geometric work destroyed
by a load that reported success. So an id present overwrites; an id absent changes nothing.

**5. ~~`merge` and `conflict` have nowhere to land.~~ ✅ FIXED.** Both are counted in the mutation's
return value and itemized on the run row. A `merge` flags every row involved `near_certain` for D36's
queue and performs nothing; a `conflict` writes nothing at all. **Neither throws**, because a batch of
150 must not be lost to one lake whose identity is ambiguous — and because the ambiguity is itself a
finding a moderator can act on.

**One thing that was not on the list and had to be added: `states`.** The OSM lane got it free by
importing one state extract at a time and letting the loader's `--state` flag tag each batch. A merged
corpus loads in a single pass, so there are no per-state batches; `statesFor` computes it per body
against the state-level admin areas, giving a border-spanning body every state it touches rather than
the first.

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

### ✅ The merge's named fixtures, as built (2026-08-06)

Every case the section below asks for is now a test in `scripts/etl/src/mergeRules.test.ts`, and
three of them **changed answer** because the audit closed a hole the old test pinned:

| fixture | before | now |
| --- | --- | --- |
| a group NHD calls `LakePond` and OSM tags `wetland=marsh` keeps `lakePond` | ✅ | ✅ |
| Lake Erie, published by NHD alone as FTYPE 390 | ⚠ **admitted** — the test pinned the hole | refused by name (D114) |
| an unnamed ocean-sized polygon | ⚠ admitted | refused on the 100,000-acre ceiling |
| Lake Champlain at ~271,000 acres | ✅ | ✅ — the allow-list's only entry |
| a group every catalogue refused is `null`, never `unclassified` | ✅ | ✅, and an explicit drop now beats silence too |
| Beau Lake is in region | ✅ | ✅ — and now drawn by NHD at 1,876.6 ac, within 5% of the published 1,788 |
| a named wetland at 5 ac in, an unnamed one at 49 out | ✅ | ✅ |
| a bay whose only candidate parent shares a bounding box | ⚠ **adopted** — pinned false positive | demoted; and a bay poking one vertex past its parent is no longer demoted |
| a group holding two features from one catalogue queues | ✅ | ✅ — and the queue is now *stored* |
| `inRegion` on a body whose in-region sliver falls between samples | ⚠ **dropped** — pinned false negative | found, by escalating to every vertex |

### ✅ The pipeline's own fixtures, as built (second audit, 2026-08-06)

`masterList.test.ts` runs the **whole flow** — three lanes, the name lane, grouping, the merge, the
bay rule, the region clip, the downstate cut, the salt veto, GNIS, the floor, the duplicate sweep and
the emit stage — against hand-built features. Every rule in `mergeRules.test.ts` passed while the
pipeline still admitted the ocean and deleted two real lakes, because none of those is a property of
a rule: they are properties of the **order**, of what one stage hands the next, and of what happens
to a body that satisfies two rules at once.

| fixture | asserts |
| --- | --- |
| Lake Erie, published by NHD as `LakePond` | refused — by name, needing no match |
| **Lake Superior, NY (179 ac)** and **Little Lake Erie (4 ac)** | **kept** — the area gate on the name veto |
| a cove inside a federal estuary that matched nothing | refused as salt water |
| **Braddock Bay**, a freshwater arm of Lake Ontario | **kept** — Great Lakes are not the sea |
| Beau Lake, straddling the border | kept, with `inRegionFraction` between 0 and 1 |
| a named wetland above 5 ac / an unnamed one at 49 | in / out |
| a wetland only the gazetteer named | kept — GNIS runs before the floor |
| Kensico Reservoir | refused, counted apart from `outOfRegion` |
| Peabody Pond at 7 ac vs 16 ac | **one** body, via the name lane |
| the same pair renamed | two bodies, **both flagged `duplicate-candidate`** |
| Mud Pond, ME vs Mud Pond, NY | never merged — overlap is required |
| Alton Bay on Winnipesaukee | a **sub-area**, not a body |
| a bay whose parent was refused | a queued body, never a dangling sub-area |
| Half Moon Cove | demoted and queued |
| the Long Pond duplicate pair | one body, the absorbed id **named** |
| two catalogues sharing an id namespace | throws |
| a body whose geometry defeats the transform | counted, run survives |

### 📌 Deferred, with the setup written down: the regression corpus

**Founder call, 2026-08-06 — worth doing, not now.** The one test the fixture suite cannot be is a
run against *real* data, where the failure modes are the ones nobody thought to write a fixture for.
Everything above is synthetic; the archives are 924 MiB and gitignored.

When it is wanted, this is the shape:

1. **Cut a sample, deterministically.** From each archive, every feature whose bbox falls in two or
   three small, dense, *named* windows — say Moosehead and its bays (ME), the Winnipesaukee basin
   (NH), and the Great Bay estuary (NH) for the salt case. Roughly 2,000 features, a few MB, which
   commits comfortably. Pick the windows by *coordinate*, never by a count or a `head -n`, or the
   sample changes when the source does.
2. **Commit it under `scripts/etl/fixtures/regression/`** with a manifest naming the source archives'
   sha256s, so "which release is this cut from" is answerable — the same discipline `.raw-*/` uses.
3. **Run `buildMasterList` over it and snapshot the summary**, not the bodies: counts by class, by
   geometry source, by refusal reason, plus the full `dropped.ndjson` key list. A body-by-body
   snapshot would churn on every tolerance change and get regenerated without being read.
4. **Review the diff, never accept it blind.** The value is entirely in a human looking at *"−37
   lakePond, +37 wetland"* and deciding whether that is the change they meant to make.
5. **Give it a longer timeout** — see the `ci-test-timeout-5s` note; this is a legitimately heavy
   test and CI runs it ~8× slower than local.

The cost of not having it is bounded: `masterList.test.ts` covers the decisions, and
`dropped.ndjson` plus the manifest delta (D123) make a *real* run diffable by hand, which is where
this would have been read anyway.

### The merge itself is now the piece most likely to fail quietly (2026-08-05)

This section was written when reconciliation was the whole of the matching logic. It is not any more:
`merge.ts` is ~1,000 lines that decide all 27,074 rows, and it is **excluded from coverage as
"subprocess + file-I/O glue"**, which it stopped being the moment it grew a merge rule. The exclusion
was accurate for `cli.ts` and `load.ts`; it is not accurate for a file containing the veto set, the
class precedence order, the name union, a union-find, the region clip, the GNIS lane and the bay rule.

Same discipline, applied to it — named answers, not a percentage:

- **A group NHD calls `LakePond` and OSM tags `wetland=marsh` keeps `lakePond`.** This is the 123-body
  rescue the whole file exists for; it must be a test, not a run report.
- **A group containing Lake Erie (`nhd:ftype=390`, a LakePond claim at 6.4M acres) is refused**, and
  refused by the *veto*, not by the area floor. Likewise Long Island Sound at `ftype=493`.
- **A group every catalogue refused is `null`, never `unclassified`.** The distinction that admitted
  Lake Huron and seven polygons of the Atlantic.
- **Beau Lake is in region** — it straddles the Québec border, so an `inRegion` that samples the wrong
  vertices drops the fixture this phase is named for.
- **A named wetland at 5 acres is admitted; an unnamed one at 49 is refused** — and the named one is
  admitted when the *only* source of the name is GNIS, which is the 306-body ordering claim.
- **A bay whose only candidate parent merely shares a bounding box is demoted.** The parent test is
  `covers()` on bboxes alone; Half Moon Cove is the fixture for the demotion, and a bbox-only test has
  no fixture at all for the false-positive direction.
- **A group holding two features from one catalogue queues rather than merging** — `sameSourceDuplicate`
  is the only thing standing between a three-lane union-find and two distinct lakes chained into one.

---

## Step 2 — reconciliation, as built (2026-08-03)

**Read-only against Convex.** It produces a mapping and a ledger for review; a separate loader applies
them. A reconciliation that writes as it goes cannot be reviewed before it has already happened.

**Fetch once, derive many — the same split the archives use.** `--export` pages the corpus out of
Convex (`waterBodies:listForReconcile`, 100/page because Champlain's polygon is 10,755 vertices and
the byte cap bites before the document cap) and dumps NHD's post-floor polygons out of the five
geodatabases. `--match` reads only those files. The thresholds will want tuning against real
distributions, and re-running the comparison through Convex to try a different number would be absurd.

**The blocking grid.** 21,665 bodies against 40,928 candidates is 887 million pairs, which is not a
computation. NHD features are indexed into a 0.1° grid by bbox, so each body scores only what could
possibly overlap it, and `bboxIntersects` rejects most of those before any geodesic area is computed.

### The decision rule, and why each threshold is where it is

| | |
| --- | --- |
| `RECONCILE_MIN_IOU` **0.5** | they share more area than they don't. Two catalogues tracing one shoreline land at 0.85–0.98; the measured OSM-vs-NHD median area disagreement is 2.4%. Below 0.5 is a bay against its parent, a reservoir against its river, or two neighbours in a chain. |
| `RECONCILE_MIN_IOU_WITH_GNIS` **0.3** | both publishers independently naming the same place is real evidence — but not a bypass, because a lake NHD splits shares its GNIS id with both halves. |
| `RECONCILE_MIN_MARGIN` **0.15** | when the top two are this close, geometry cannot separate them, and `ambiguous` sends it to a human rather than picking the marginally larger number. |

**`ambiguous` and `none` are ordinary, successful outcomes.** A wrong match is worse than no match
because it is invisible: a body silently carrying another lake's `nhdId` will later inherit that lake's
geometry, depth and contours.

**IoU, never containment — measured, not assumed.** North Bay's interior point sits inside NHD's
Moosehead Lake, so a containment join hands a bay its parent's identity; Moosehead itself matches
nothing, because `pointOnFeature` lands on the shoreline of any large irregular lake. A bay has high
containment and *low* IoU, which is exactly the distinction that matters. Both cases are in the tests.

> **One thing this pass cannot do yet, recorded rather than left as a silent no-op.** The stored
> corpus carries **no GNIS id** — the OSM transform never captured `gnis:feature_id`, though the tag
> is present on 35.3% of named Vermont water features. So the GNIS-assisted bar cannot fire on this
> run: every match here is geometry alone. The bar is built and tested, and goes live the moment the
> transform captures the tag — which belongs in step 5's re-import.

---

## D96 — settled: the four admission rules ✅ **APPROVED**

> **D109 amendment — the stored vocabulary migrates, it does not map back ✅ APPROVED**
> **(founder, 2026-08-05: *"we should use our latest, simplified schema, not the one that's live
> now"*.)**
>
> `waterBodies.type` moves from `WATER_BODY_TYPES` (8 values) to `WATER_BODY_CLASSES` (6). The
> alternative — mapping `WaterBodyClass` back at the loader — was rejected because it would
> re-introduce the lake/pond split D109 refused on evidence, and would do it *silently*, inside the
> ETL, where nothing reads it back.
>
> **It is a hard cut.** `schema.ts`'s field, `waterBodies.ts`'s `canonicalBody` validator and
> `scripts/etl`'s `CanonicalBody` are one wire contract; flipping any one alone makes
> `importCanonical` reject every batch. Scoped at ~45 production sites and ~132 test lines.
>
> Three things that bite, all found by audit rather than by compiler:
>
> 1. **`waterBodies.ts`'s `type === 'marsh'` check goes silently dead**, zeroing the
>    `unnamedWetlandBands` tally — the distribution D96 says is the thing most likely to be re-tuned.
>    It must route through `isWetlandClass`, which already accepts both spellings.
> 2. **`humanizeEnum` cannot render `lakePond`** — it only swaps underscores and capitalises, so five
>    user-facing sites across web and mobile would print "LakePond". Needs a label table.
> 3. **`unclassified` reaches a human picker.** Mobile's new-water prompt maps the enum straight to
>    chips, so migrating unreviewed would offer a skater "Unclassified" as a choice. The picker needs
>    a curated subset, which is a product call rather than a rename.
>
> Nothing is indexed on `type`, no map style expression reads it, and no other table stores it — so
> the migration is a value backfill, not an index rebuild.

**Founder, 2026-08-03.** The complete rule set, verified across all nine size × class × named
combinations before implementing — no gaps, no contradictions:

| size | class | named | verdict |
| --- | --- | --- | --- |
| < 1 acre | any | any | **out** |
| 1–5 acres | non-wetland | ✓ | **in** |
| 1–5 acres | non-wetland | ✗ | out |
| 1–5 acres | wetland | either | **out** — wetland gets no name tier here |
| > 5 acres | non-wetland | either | **in** |
| > 5 acres | wetland | ✓ | **in** |
| > 5 acres | wetland | ✗ | **out** |

Rules 1–3 are D91 unchanged. The wetland clauses are new, and **symmetric across catalogues on
purpose** — OSM accepts `wetland=marsh`, NHD's FTYPE 466 lumps swamp with marsh under one code whose
FCODEs do not separate them. A one-sided rule would make *which catalogue drew this lake* change
*what kind of thing it is*.

**Why wetland at all:** above the floor, LakePond runs 59–66% named and SwampMarsh 1–2%, consistently
across states. Of the 19,610 unnamed bodies NHD would add to our region, **13,976 (71%) are
SwampMarsh** and 82% are under 25 acres.

### Rule 5: unnamed wetland needs fifty acres

**Chosen against the measured distribution of the class, not a guess.** The corpus holds **3,659**
unnamed wetlands above five acres:

| | 5–10 | 10–25 | 25–30 | 30–50 | 50–100 | 100+ |
| --- | --- | --- | --- | --- | --- | --- |
| count | 1,533 | 1,230 | 163 | 318 | 251 | 164 |

| bar | kept | removed | corpus |
| --- | --- | --- | --- |
| named-only | 0 | 3,659 | 17,968 |
| **≥ 50 acres** | **415 (11%)** | 3,244 | **18,383** |
| ≥ 30 acres | 733 (20%) | 2,926 | 18,738 |

**Area is knowingly the weaker proxy** — a 60-acre round bog gets in where a 12-acre channel does
not, which is wrong on the merits. Accepted because the rule stays cheap and total, and because
**N7b is the backstop**: *"rely on N7b to repopulate anything we rip out now"* (founder).

### The long-axis exemption it replaced: designed, measured, dropped

A fifth rule — *unnamed wetland over five acres with a long axis over 2 km* — was built and then
removed at the founder's call (*"ditch the 2 km min axis for now, that way we keep this safer"*). The
measurement is kept in `WETLAND_LONG_AXIS_EXEMPTION_DROPPED` because measuring was the expensive part.

**The case for it was real and is D91's own** — area is the wrong axis, and the corpus holds a
516-acre unnamed marsh with a **3,027 m** long axis. Of 728 sampled unnamed marshes, a 1 km bar kept
120 (16%), a 2 km bar kept 34 (4.7%).

**What it cost was more than it looked.** It was the only rule gated on a *derived statistic*, and
that split the correct behaviour in two: an **import** must refuse a body whose axis is unknown, and a
**prune** must keep it, or it deletes the long channels the clause exists to protect on absence of
evidence. Two opposite readings of one rule is how a silent deletion happens. It also forced
`lakeGeometryStats` to be computed lazily mid-check in `transform.ts`, where it is deliberately
derived *after* admission so a convex hull does not run over 124,000 features.

**Dropping it is safe because of N7b.** `includedByRequest` overrides every rule, so a real 3 km
channel someone actually skates has a way back in — one body at a time, with a human looking. That is
a better answer than a threshold nobody can verify.

---

## D103 — Known outlets and inlets: USGS seeds them, users extend them, USGS reclaims them ✅ **APPROVED**

**Founder, 2026-08-03:** *"We use the 'known outlet' (and 'known inlet' if possible) terminology,
seeded by this dataset, but then augmented by our built-in hazard reporting system. That way we can
show this data for more lakes than USGS provides. As the 3DHP dataset grows YoY, we can replace
user-reported markers with 'official' ones."*

**The data.** 3DHP's `landscape` feature class (REST layer 20) holds **1,802 points across our five
states**: **1,519 Waterbody Outlets, 193 Sinks, 90 Springs**. Outlets are where a lake drains — moving
water under ice. Springs are groundwater upwelling, which keeps holes open all winter. These are
exactly where ice goes bad, and it is a tiny dataset sitting inside a download we already take.

**The failure mode this design solves.** 1,519 mapped outlets against ~21,000 bodies means **most
lakes have no mapped outlet, and every lake has one**. A bare import would make absence read as
safety — the same silent-absence trap that ran through this whole phase, pointed at a safety
question. The founder's framing fixes it at the vocabulary level: **"known outlet", never "outlet"**,
so the claim is about our knowledge rather than about the lake. Nothing may phrase it otherwise (D3).

### It lands on `bodyFeatures`, which already exists and already does most of this

`bodyFeatures` (D53, N5c) is the **persistent** counterpart to a hazard: no seasonal reset touches it,
it shares the hazard authoring primitives (point / line / polygon with a buffer), `active` makes
demotion reversible rather than destructive, and `promotedFromHazardId` **already implements the
augment half** — a recurring user-reported hazard becomes a permanent feature by promotion.

So "seeded by USGS, extended by users" is one new source on an existing table, not a new subsystem.
Three gaps to close:

1. **No outlet or inlet type.** `BODY_FEATURE_TYPES` has `spring_current`, `constriction`,
   `bridge_narrows`, `recurring_pressure_ridge`, `gas_hole`, `reef_hole`, `delta`,
   `shallow_early_thaw`, `other`. **3DHP's `Spring` maps straight onto `spring_current`** — no new
   type needed for 90 of the 1,802. Outlets need one; inlets need one if they are obtainable.
2. **No provenance field, and `addedByUserId` is required.** A USGS-seeded feature has no author. It
   needs a `source` (`'user' | 'usgs_3dhp'`) plus the `id3dhp` it came from, both so the two are
   distinguishable in the UI and so the **reclaim** step is a real operation: when a release adds an
   official outlet where a user put one, supersede rather than duplicate. `addedByUserId` becomes
   optional, or a system profile owns the seeded rows — that choice is open.
3. **The reclaim needs a match rule.** "Official one replaces the user one" is a spatial join with a
   tolerance, and it must be conservative: superseding the wrong user marker deletes someone's
   contribution. Prefer leaving both and flagging for review over an automatic merge that can be wrong.

### ⚠️ Outlets are free; inlets are not, and that should be settled before promising them

3DHP's `landscape` layer carries **`Waterbody Outlet` and no inlet type**. An inlet would have to be
derived — a flowline whose terminus meets a waterbody, flowing in — and **`flowline` is the layer we
deliberately did not keep** (D102's clip). Getting it means another 11.9 GB download and the largest
feature class in the product.

The cheaper lead is the `network` layer (48,550 points in our states: headwater, terminus, divergence,
confluence, catchment outlet), which may already carry what an inlet needs without the flowlines.
**Measure that before committing to "known inlet" in any copy** — shipping the phrase and then finding
we can only populate outlets would be the coverage-gap problem all over again.

> ### 📌 Note for whoever wants inlets later
>
> **Postponed deliberately (founder, 2026-08-03), not forgotten.** Ship outlets first; add inlets when
> someone wants them. This is where to start:
>
> 1. **Try `network` first — it is already free.** `3DHP_all/MapServer/30`, 48,550 points in our
>    envelope, types `Headwater · Terminus · Divergence · Confluence · Catchment Outlet`. If
>    `Terminus` or `Confluence` reliably lands where a stream meets a lake, that is an inlet and costs
>    nothing beyond a REST query. **Nobody has checked whether it does.**
> 2. **Only if that fails, reach for `flowline`.** An inlet is properly *a flowline whose downstream
>    end meets a waterbody*, which needs the largest feature class in 3DHP — and D102's clip keeps
>    only `waterbody`, so it means re-downloading the 11.9 GB CONUS geodatabase. The source manifest
>    (`.raw-3dhp/source/manifest.json`) retains the URL and sha256 precisely so that re-fetch is
>    verifiable rather than a fresh guess.
> 3. **Whichever route, the vocabulary rule from D103 still binds**: "known inlet", never "inlet".
>    Coverage will be partial for inlets in exactly the way it is for outlets.
>
> The cheapest moment to do (2) is **during a yearly refresh**, when the 11.9 GB is already coming
> down for the annual clip — adding a second layer to that pass costs disk, not a download.

---

## D104 — Elevation from 3DEP, and the recurring cost is near zero ✅ **APPROVED**

**Founder's question, 2026-08-03:** *"We only have to do this once — when we upsert the latest batch in
a year, we should only have to call this endpoint for any new bodies, right?"*

**Right, and that is the argument for the point service over the raster tiles.** Two routes exist:

| | 3DEP tiles | `epqs.nationalmap.gov` |
| --- | --- | --- |
| cost | ~57 MB per 1°×1° at ~30 m; **~4 GB** for our region | one HTTP call per coordinate |
| key / cap | none — fully offline forever | **no API key, no documented daily cap** |
| resolution | 30 m (or 10 m at 472 MB/tile) | **1 m** where LiDAR exists — verified: Champlain returned 29.689 m at `resolution: 1` |

Since the recurring cost is only new bodies, spending 4 GB of the remaining free tier to avoid a few
hundred annual requests is the wrong trade. **Use EPQS.** Keep the tiles as the documented fallback if
it turns out to rate-limit.

**The incremental behaviour is already built** — `listNeedingElevation` skips already-stamped rows
server-side, which is what made the N6c pass resumable. Two caveats on "only new bodies":

1. **A body whose geometry changes needs re-stamping**, because its representative point moves. Under
   D92 a `geometrySource` switch moves it, potentially a long way (`pointOnFeature` puts Champlain's
   30.7 km off). That set is small but it is not empty, and it is not "new bodies".
2. **3DEP improves under us.** The response carries `rasterId` and `resolution`, so a lake stamped
   from a 30 m raster can be re-stamped from 1 m later. **Store the resolution alongside the
   elevation** — optional to act on, impossible to act on if we did not record it.

**The first run is still the whole corpus**, so throughput-test EPQS before committing to it.

---

## D105 — GNIS becomes a fourth lane ✅ **APPROVED**

**Founder, 2026-08-03.** The National Map stages the authoritative GNIS database per state at ~1 MB a
piece (`StagedProducts/GeographicNames/DomesticNames/`), **~5 MB for our five states**, public domain.

It is the resolver behind the `gnisId` bridge D93 adds: feature ids, official names, coordinates and
feature classes, from the body that assigns them. Two jobs it does that the inline ids cannot:
settling a GNIS id where OSM, NHD and 3DHP disagree, and supplying **names and variant names** for
search on bodies whose catalogue entry is unnamed.

> **⚠ The variant-name half is still not built** (noted by the second audit, 2026-08-06). The lane
> supplies a *name* where a body has none, and it resolves the *feature id* — both live. Variant
> names are neither read from the gazetteer nor stored, so a body findable in GNIS under a second
> spelling is not findable in our search under it. `waterBodySubAreas` already models this
> (`aliases` + `searchText`); `waterBodies` has no equivalent field, which is what makes it a schema
> change rather than an ETL one, and why it is filed rather than folded in here.

Cheapest lane in the phase by a wide margin, and it needs no new bucket — it belongs beside the
catalogues it resolves.

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

### ✅ The 61 the prune spared — resolved, and the dedup queue is empty (2026-08-07)

The step-6 prune protected 64 bodies the master list did not re-affirm: 1 carrying a hazard, 2 with a
curated boost, and **61 carrying a dedup pointer**. That last group turned out to be the most
interesting thing the campaign produced, because it is this phase's own headline finding coming back
around.

**All 61 are the losing halves of OSM duplicate pairs**, every one flagged `near_certain` with
exactly one `duplicateCandidateId`, and all still `listed`:

| the orphan | its partner, re-affirmed |
| --- | --- |
| `Long Pond` relation/2602300, 2,532 ac | `Long Pond` way/150404999, 2,552 ac |
| `Lovell Lake` relation/3862940, 540 ac | `Lovell Lake` way/290716119, 553 ac |
| `Duncan Lake` relation/11825915, 83 ac | `Duncan Lake` way/226732026, 85 ac |
| `Lake Auburn` relation/11198619, 2,263 ac | **`The Basin`** way/130101481, 2,263 ac |

Those are the five pairs §Why this phase exists names — *"OSM cannot see its own duplicates, and NHD
can… all five pairs collapse onto a single `Permanent_Identifier`, tested 5/5"*. The merge did exactly
that: it collapsed each pair onto one body and named the loser in `absorbedIds`. So the winner is in
the master list, the loser is not, and the prune spared the loser because a **D36 match-on-create pass
had already flagged it for a human** — and the prune's rule is that a body under review is not
deleted out from under the person reviewing it.

**That protection is right and is now redundant, which is the useful part.** Two independent systems —
D36's geometric match-on-create and the N7 merge's federal-id collapse — reached the same conclusion
about the same 61 rows. The queue's items are pre-answered; a moderator merging them is confirming a
finding rather than making one.

**What it costs until somebody does.** All 61 are listed, so the corpus renders 61 known duplicate
lakes and search returns both halves. That is visible rather than silent, which is the design working,
but it is not free.

**They were resolved by a one-time pass rather than by hand** (founder call, 2026-08-07):
`waterBodies.resolveCampaignDuplicates`. `merge` is the wrong tool — it exists to re-point children
and leave a tombstone reads can chase, and with zero user content it would move nothing and preserve
a pointer nobody holds. So the pass deletes the loser and clears the flag at the other end, and it
refuses three things: a body carrying user content (re-checked, **not** inherited from the prune,
which tests `dedupOrMerged` *before* `attached` and so had never checked these at all), a body whose
survivor is not in the corpus, and a body a contour tileset points at.

| | |
| --- | --- |
| 34 | deleted outright — a surviving partner, nothing attached, nothing pointing at them |
| 5 | held, then deleted on the founder's call: a full bathymetry pass is coming, and in every case the *survivor* had no coverage because the N6b join had matched the survey to the duplicate |
| 22 | **not a duplicate question at all** — pairs where *both* halves were refused by the D111 cut. They fail the region rule, which is a property of the body rather than of the queue, so `pruneOutsideCoverage` took them. It found exactly those 22 and nothing else, which also confirms no other downstate residue survived the campaign. |

**The dedup queue is now empty**: 0 `near_certain`, 0 `suspected_duplicate`, 0 tombstones, 0 dangling
candidate pointers, 0 orphaned sub-areas. The corpus stands at **25,136 bodies and 120 sub-areas**.

**The rule that survived, and it is the one worth keeping.** D36 and D93 both hold that an automatic
merge which is wrong is unrecoverable in a way a queued one is not, and `resolveUpsert` still refuses
to perform one. What made this pass safe was not that the rule was relaxed — it is that *two
independent systems had already agreed*, and the pass verifies that agreement per row rather than
assuming it.

**And the fourth row above is a second finding.** The 2,263-acre body is stored as **`The Basin`**,
because name selection is authority-ranked (`gnis > nhd > 3dhp > osm`) and NHD's `gnis_name` for that
feature is "The Basin" while OSM calls it "Lake Auburn" — Auburn's own water supply, and one of the
lakes D95 recovers soundings for. It carries `confidence.name: 'low'` and sits in the 463-row
name-conflict queue, so the machinery caught it. It is the clearest example available of what that
queue is for, and of what D93's *"OSM ranking last is a real trade"* costs in practice.

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

**✅ The campaign baseline was measured at 21,665 bodies** (`waterBodies:corpusStats`, paged,
2026-08-03). **D91 predicted 21,660 of 123,940 — the floor landed within five rows of its own
forecast.** Every "how much did this add" statement in this phase is measured against this number.

| | | | |
| --- | --- | --- | --- |
| total | **21,665** | listed | 21,665 |
| `osmId` | **0** | `nhdId` | **0** |
| `geometrySource` | **0** | wind rose | **0** |
| depth | 5,937 (27%) | elevation | 6,791 (31%) |

**by type** — `other` **10,033 (46%)** · marsh 3,854 · pond 3,756 · reservoir 2,393 · lake 1,376 ·
bay 253
**by state** — NY 8,142 · MA 5,130 · ME 4,726 · NH 2,486 · VT 1,282 *(border bodies count in each,
so these sum above the total)*

Three things that measurement settled that were assumptions:

- **The identity fields really were unbackfilled** — zero rows carried `osmId`, `nhdId` or
  `geometrySource`. **Superseded — steps 2 and 4 have since run**, see below.
- **Wind climate is at zero**, not ~2%. The N6c pass wrote nothing before it was stopped.
- **`other` is the largest class in the corpus at 46%** — water OSM's classifier could not identify.
  That is a bigger unknown than the wetland question D96 has been agonising over, and nothing in this
  plan had looked at it. **Since addressed**: `waterClass.ts` maps all three catalogues into
  `WATER_BODY_CLASSES`, where the honest name for this bucket is `unclassified` and it falls to
  1,533 of 27,074 (5.7%) in the master list.

### The baseline after steps 2 and 4 (2026-08-05)

Sampled live against dev. **Re-measure with `corpusStats` before step 5 rather than quoting these** —
the sample is the first 3,000 rows, and the total below is the handoff's figure, not a counted one.

| | | | |
| --- | --- | --- | --- |
| total | **18,383** *(per the handoff; unconfirmed by a full page)* | `waterBodyKey` | **~100%** |
| `osmId` | **~100%** | `nhdId` | **~69%** |
| `geometrySource` | **~100%** | `source` | 100% `osm` |

**`nhdId` at ~69% is the number that makes step 5 safe.** `resolveUpsert`'s `merge` verdict is rare
only because reconciliation writes `nhdId` onto OSM bodies *before* any NHD geometry is imported —
and that ordering has now actually happened. An NHD-only feature arriving in step 5 meets a corpus
whose bodies already carry their NHD ids, so it patches instead of duplicating. The remaining ~31%
are bodies NHD has no counterpart for; those insert cleanly, which is correct.

**`source` is still 100% `osm` and `type` is still the old eight-value vocabulary.** Both are step 5's
job to change — see the `WATER_BODY_CLASSES` migration under D96.

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
