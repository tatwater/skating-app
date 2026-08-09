# HANDOFF — N7-2 PR B: the data campaign

> **Written 2026-08-08, at the point PR A closed.** This is the *start here* document for the second
> half. PR A ([#40](https://github.com/tatwater/skating-app/pull/40)) audited and refereed the corpus
> itself; this is the enrichment on top of it, which is the larger half.
>
> Delete this once the campaign lands and the findings are folded into `phase-N6a-lake-depth.md`,
> `phase-N6b-bathymetry-layer.md` and `phase-N6c-expanded-lake-profiles.md`.

---

## Where things stand

**The corpus is stable and that is the precondition D100 asks for.** Campaign **`n7-2-20260808`** on
dev: **24,945 bodies · 126 sub-areas**, every fixture verified, 0 orphans, 0 dangling pointers. Prod
has never been deployed and is not in scope.

Branch `phase-n7-2-unified-corpus` is PR A. **Start PR B on a new branch off it** (or off `main` once
#40 merges) — nothing in PR B needs to change the merge.

| pass | coverage today | |
| --- | --- | --- |
| elevation | **archived, not loaded** — 25,044 readings, 98.2% at 1 m LiDAR | D127 |
| depth | **5,633 / 24,945 (22.6%)**, three global sources | |
| bathymetry | **`contourCoverage` = 0 rows** — the N6b join has never run against this corpus | |
| wind | **0** — `scripts/wind-climate/.raw/` does not exist | |
| `regionStats` | empty — computed *from* elevation, so it runs last | |

---

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

⚠ **Join on the NAME with a distance bound, never on the coordinate.** Measured: point-in-polygon
matches **326**, a name match within 2 km matches **866**. The coordinates are pre-GPS — a small
systematic offset (~72 m N, ~97 m E) and a much larger random one (**sd ~340 m**). Read
`nameClaims`, not the stored name: ALSC's spelling may agree with OSM's where the stored one is
NHD's.

⚠ **Depth only.** Its coordinates, elevation and area are all superseded by what we hold.

Report the **incremental** figure, not 1,345: LAGOS covers New York too, and under the ladder ALSC
correctly declines to overwrite it. The honest headline is *"ponds that gained a depth they did not
have"*.

### 4. Bathymetry: re-key → join → build → tile → coverage

`contourCoverage` is empty, so the layer currently ships against nothing.

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
