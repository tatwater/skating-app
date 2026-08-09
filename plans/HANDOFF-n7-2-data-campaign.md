# HANDOFF — N7-2 PR B: the data campaign

> **Written 2026-08-08, at the point PR A closed.** This is the *start here* document for the second
> half. PR A ([#40](https://github.com/tatwater/skating-app/pull/40)) audited and refereed the corpus
> itself; this is the enrichment on top of it, which is the larger half.
>
> Delete this once the campaign lands and the findings are folded into `phase-N6a-lake-depth.md`,
> `phase-N6b-bathymetry-layer.md` and `phase-N6c-expanded-lake-profiles.md`.

---

## Where things stand

> ### 🔄 In flight — campaign `n7-3-20260809`, updated 2026-08-09 afternoon (N7-3)
>
> Branch **`phase-n7-3-unified-corpus`**. Decisions **D131–D137** in
> [`01-decisions.md`](./01-decisions.md).
>
> | pass | state |
> | --- | --- |
> | elevation | ✅ **99.5%** — 24,834 of 24,958, all at 1 m LiDAR |
> | depth | ✅ 24.2%, **81.2% of stored depths measured**; `state_agency` 0 → **3,033** |
> | wind fetch (1 km) | ✅ **5,910 cell-years archived**, 7,092 objects mirrored to R2 |
> | wind `derive` | ✅ **1,193 / 1,193 bodies stamped**, zero requests, zero cells missing |
> | wind fetch (250 m) | ⬜ **D135** — 41,855 new requests, ~60 h. Resumable; start it and leave it |
> | bathymetry chain | ✅ ran end to end: **2,066 lakes → 49,362 lines**, 2,057 bodies stamped (was 2,022). Tiles NOT uploaded — see below |
> | `osm→osm` lane | ✅ **D136** built + tested, **not yet re-merged** |
> | D95 re-key lane | ✅ built + tested, **not yet run** |
> | `regionStats:recompute` | ⬜ last, always |
>
> #### ⚠ The ordering that matters
>
> **Both corpus fixes must land before the bathymetry chain re-runs.** The join is keyed on
> `externalId`, so a re-merge that collapses duplicates while a tileset exists orphans coverage.
> Order: re-merge → re-load → prune → join → build → tile → coverage → `regionStats`.
>
> #### What the audit found that this document did not know
>
> - **There was no `osm→osm` matching lane** (D136). Three lanes ran; none matched a catalogue
>   against itself, so an OSM relation and its own outer way both shipped. 37 pairs, **every one of
>   the 18 at IoU ≥ 0.6 is OSM–OSM**, two at IoU 1.000, all wetland. `Mud Pond Swamp` is in the
>   corpus twice. Fixed at a 0.9 bar; the loose cross-catalogue pairs stay queued.
> - **The wind fetch was gated by the caption's constant** (D135). `MIN_FETCH_CLAUSE_M` was chosen
>   for pressure ridges and was silently deciding wind-hole coverage too, which has no fetch minimum.
> - **The census read a different number from the rule it audits** (D137). Four "under-floor"
>   wetlands were an artifact of banding on `surfaceAreaSqM` where the floor ran on `sourceAreaSqM`.
>   126 bodies sit in that straddle band; the prune already got this right, the census did not.
> - **Depth's 24.2% probably has the wrong denominator.** The corpus holds **5,882 non-wetland bodies
>   over 10 ha** — HydroLAKES' and GLOBathy's floor — against 6,033 with a depth. `corpusStats` now
>   bands by area so this can be confirmed rather than inferred from two close numbers.
>
> #### Three sources loaded that predate this document
>
> NH depth **band polygons** (624 lakes, max *and* integrated mean — layer 1 of the service N6b read
> layer 0 of), NYSDEC **CSLAP** (278 lakes, its own rung per D133), and Maine's **MIDAS → NHD
> crosswalk** (5,611 of 5,803 keys).

## The order, and why it is this order

### 1. Give `state_agency` a producer — the biggest win, and no new source

**Confirmed against the loaded corpus: 0 rows carry it.** It is rank 1 on D68's ladder, above LAGOS
and HydroLAKES, and nothing has ever written it. Its docstring says it was *"deferred to N6b, where
those datasets are fetched for their contours anyway"* — N6b fetched them and never came back.

**298 MB and ~2,400 lakes are already on disk** at `scripts/bathymetry/.raw/`:

| source | what | lakes |
| --- | --- | --- |
| `me-dep-soundings` | 147,755 depth points, keyed by **MIDAS** | 1,528 |
| `nh-granit-contours` | 9,285 contour lines | 558 |
| `ma-massgis-contours` | 27,989 contour lines, integer ft, `NAME` + `PALIS_ID` | |
| `vt-anr-biobase-soundings` | 2,442,512 points | 66 |
| `vt-vcgi-champlain-soundings` | 20,345 real soundings (the other 84,565 are shoreline zeros) | Champlain |

Max depth is the deepest contour or sounding per lake; mean needs care (a contour set is not a
volume). **Read `scripts/bathymetry/src/sources.ts` first** — it documents a unit trap per source,
including Maine's `DEPTHM` computed with a 3.3 ft/m constant rather than 3.28084.

This is the same shape as the `osm_tag` no-producer finding the N6a review caught, one rung up.

### 2. Load the 3DEP archive, and measure the datum shift first

`loadElevation.ts` still reads Open-Meteo. The archive is at
`scripts/lake-depth/.raw-elevation/readings.ndjson` (mirrored to `skating-raw-elevation`).

⚠ **D101 asked for the comparison before the swap**, and it is the one step here that is easy to
skip: *"a source swap that silently changes a datum would move every decile in `regionStats` and look
like a data-quality improvement."* `elevationDeltas()` in `elevationArchive.ts` exists for exactly
this and is tested — run it against the **5,692 rows already stamped `dem_glo90`** and read the
distribution. A one-sided distribution is a datum shift; a two-sided one is an accuracy improvement.

Also outstanding from D104: store `resolutionM` and `rasterId` on the row, so the 443 bodies that
came from a coarser raster can be re-stamped when 3DEP improves. `resolutionMetres()` already
normalizes the degrees-vs-metres quirk.

### 3. Join ALSC by name

1,345 Adirondack ponds at `scripts/lake-depth/.raw/alsc/ponds.ndjson` (mirrored in
`skating-raw-lake-depth`), every one with a max **and** a mean depth. See **D130**.

**The lane exists as of PR A** — `transform --alsc=.raw/alsc/ponds.ndjson` reads the archive back and
emits one record per pond at the `alsc_1987` rung, which `load` then feeds to the ordinary join. It
had to: the archive shipped for one release with nothing reading it, so the scrape produced a
directory rather than a depth. **So this step is a run, not a build.**

⚠ **What it runs at is the shared 500 m bound, and that is the part still worth building.** Measured:
point-in-polygon matches **326**, a name match within 2 km matches **866**. The coordinates are
pre-GPS — a small systematic offset (~72 m N, ~97 m E) and a much larger random one (**sd ~340 m**).
The shipped join gives ALSC no special treatment (containment, then proximity ≤ 500 m corroborated by
name or area), so somewhere between those two numbers lands and the rest is named on the run row.
Widening it means two things that do not exist yet: a **per-source distance bound** passed into
`matchAndImportDepths`, and reading **`nameClaims`** rather than the stored name — ALSC's spelling
may agree with OSM's where the stored one is NHD's. Run it first and read the actual rejection
counts; they decide whether the wider join is worth the machinery.

⚠ **Depth only.** Its coordinates, elevation and area are all superseded by what we hold — the
transform reads name and area purely as match corroboration and emits neither as a stored field.

Report the **incremental** figure, not 1,345: LAGOS covers New York too, and under the ladder ALSC
correctly declines to overwrite it. The honest headline is *"ponds that gained a depth they did not
have"*.

### 4. Bathymetry: re-key → join → build → tile → coverage

⚠ **CORRECTION (2026-08-09): the table was never empty, and it is not called `contourCoverage`.**
It is **`bathymetryCoverage`**, and it held **2,022 rows** — N6b's build — for as long as this
document has claimed otherwise. The claim came from querying a table name that does not exist and
reading the empty result as a finding: *"a null result reads exactly like a negative one"*, the exact
trap listed under §Things it would be expensive to re-learn. **Query the schema for the table name
before reporting a zero.**

**Maine publishes a MIDAS→NHD crosswalk** and this is the find that unblocks D95's re-key lane:
`https://gis.maine.gov/mapservices/rest/services/dep/MaineDEP_Lakes_Data/MapServer/3`
("MIDAS Waterbodies") carries **5,640 of 5,831 rows with a `Permanent_Identifier`**. Our corpus is
keyed on NHD ids, so Maine's half of the join stops being a geometric guess and becomes an id lookup.

That should settle the open items N6b left: the **9 containment rejects at 39–49%** (Yoke Ponds,
Wallagrass First Lake — plural names, which smells like one key spanning two bodies, D95 rule 2), the
Caribou Lake → Ripogenus (15.7×) and Fahi Pond → Mud Pond (22.3×) mismatches, and the **655 soundings
of MIDAS 870 (3.7%) that fall outside every body**.

⚠ **Aggregate rows per MIDAS before quoting any figure** — Moose Pond has five rows, three of them
0.0 acres, and MIDAS 9861 holds both Long Pond (651 ac) and Lewiston Pond (24 ac).

Also unblocks the one unresolved merge verdict: **`way/522157160`**, refused because its losing row
carries contour coverage and deleting it would orphan a tileset.

### 5. Wind climate — the archive rebuild, THEN the fetch

`HANDOFF-wind-climate-archive.md` is still accurate and still entirely unbuilt. Everything in it
stands; the elevation lane was built to that exact shape and is the proof it works.

⚠ **Re-measure the scope before spending 7.7 hours.** Its `1,061 bodies / 1,045 cells` figure was
taken against the old area floor and a 123,952-body corpus; ours is 24,945. The README's `3,184` is
simply wrong.

⚠ **`skating-raw-wind-climate` exists but has never been written to.** Created 2026-08-02, confirmed
on the API token 2026-08-08 — so that write permission has never actually been exercised. Run
`mirror-r2.sh status` *before* the fetch.

### 6. `regionStats:recompute`, last

Deciles are computed from elevation. Its own docstring: *"Running it early is not harmful, just
wrong: it would describe the corpus as it was."*

---

## Two sources found and not yet read

- **NH `EDP_Bathymetry_Lakes/FeatureServer/1`** — `depthmin` / `depthmax` per lake polygon, 7,351
  rows. We only read layer 0, the contour lines.
- **NYSDEC `All_CSLAP_Lakes`** (`services6.arcgis.com/DZHaqZm9cxOD4CWM`) — official mean depth and
  elevation for **278 NY lakes**. Distinct from ALSC and worth having beside it.

---

## Things it would be expensive to re-learn

**Tests are not a deploy.** `convex-test` runs local code. Widening a union in `@skating/core` and
running 3,990 green tests says *nothing* about what the deployment will accept — PR A lost 19 load
batches to exactly this. `pnpm convex-dev --once` before any load that touches a validator.

**A failed load must never be followed by the prune.** D124's guard prints it and exits non-zero;
`run-corpus.sh` honours the exit code. The upsert is idempotent — re-run the load until it reports
zero failed batches, *then* prune.

**A wrapper's pipe eats the exit code, and `pipefail` does not save you.** `./run-corpus.sh … | tee
run.log` reports **success for a run that failed** — a pipeline's status is its last command's, and
`pipefail` governs pipelines *inside* a script rather than one a caller wraps around it. Hit on
2026-08-09: the sub-area step exited 1, the wrapper reported 0. `run-corpus.sh` now logs itself to
`.scratch/merge/run-<campaign>.log`, so there is no reason left to pipe it.

**A cheap argument must not be able to fail an expensive campaign at the last step.** The same run
died after a 45-minute merge and a 25,000-body load because `load-sub-areas` requires `--actor`
*unconditionally* while the wrapper only guarded the `--apply` case. Everything expensive had
succeeded; the campaign read as a failure and the non-zero exit suppressed the prune. Now skipped
with a message that prints the command to run instead.

**Denominators lie by default.** This campaign corrected three: the depth join's `8,517 / 40,260`,
the matcher error rate measuring coverage, and a corroboration rate that would have counted
un-comparable rows as agreement. Report `covered / inScope` and name what was walked past.

**A null result reads exactly like a negative one.** Twice in PR A: a duplicate band where name
agreement was structurally impossible, and a referee that returned `0 conclusive` because a flat
`[lng, lat, lng, lat…]` array was read as tuples. Both looked like findings. If a measurement comes
back suspiciously clean, check that the instrument is reaching the data at all.

**The artifacts find the bugs, not the review.** `dropped.ndjson`, the manifest delta and
`geometry-review.ndjson` were built as bookkeeping and caught more than static reading did.

---

## The commands

```bash
# the corpus (PR A — only if something upstream changes)
scripts/etl/run-corpus.sh <campaign-id>
pnpm --filter @skating/etl prune-floor                    # dry; --apply to delete
# sub-areas need an actor: a moderator profileId, audited per N2/D60

# the measurement tools PR A committed, all read-only
pnpm --filter @skating/etl referee-duplicates             # D129's soundings referee
pnpm --filter @skating/etl tidal-band                     # D126's blast-radius check
pnpm --filter @skating/lake-depth corroborate-alsc        # D130's evidence

# the archives
pnpm --filter @skating/lake-depth snapshot-elevation --from=<bodies.ndjson>
pnpm --filter @skating/lake-depth snapshot-alsc
scripts/lake-depth/mirror-elevation-r2.sh push|pull|status
scripts/lake-depth/mirror-r2.sh push|pull|status

# step 3 — the ALSC archive into the corpus (dev; `load` refuses a non-dev target without --prod)
pnpm --filter @skating/lake-depth transform --out=.scratch/alsc.ndjson --alsc=.raw/alsc/ponds.ndjson
pnpm --filter @skating/lake-depth load .scratch/alsc.ndjson --campaign=<campaign-id>
```

**Prerequisite for the referee:** `pnpm --filter @skating/bathymetry export-soundings` writes the
2,383-survey file it reads.

---

## Related

[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) ·
[`HANDOFF-n7-classification.md`](./HANDOFF-n7-classification.md) ·
[`HANDOFF-wind-climate-archive.md`](./HANDOFF-wind-climate-archive.md) ·
[`HANDOFF-n6c-data-campaign.md`](./HANDOFF-n6c-data-campaign.md) (half superseded — read its banner) ·
[`01-decisions.md`](./01-decisions.md) (D126–D130)
