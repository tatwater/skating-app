# N6e PR 2 — state of play, 2026-08-24

Supersedes the operational half of [`PR2-HANDOFF.md`](./PR2-HANDOFF.md), which was written from the
PR 3 worktree and whose §0–§4 are now **done**. That file is still worth reading for §5 (SAR), §6 (the
N6f label) and §7 (the split-body contract); this one is what a new thread needs to avoid repeating
work or repeating mistakes.

**Branch:** `phase-n6e-satellite-imagery-2`, 17 commits ahead of `main`, nothing pushed.

---

## 1. What exists and works

The producer is end-to-end functional. A granule id goes in; a masked PMTiles frame, a manifest with
per-body statistics, and a season index come out.

| Piece | File | State |
| --- | --- | --- |
| Reveal-mask bake | `scripts/imagery/src/bakeMasks.ts` | 24,831 bodies, live in R2 |
| Corpus read | `packages/convex/convex/imageryMasks.ts` | deployed to dev |
| Granule cutter | `scripts/imagery/cut-granule.sh` | in the Fly image |
| Per-body clear fraction | `scripts/imagery/zonal-clear.py` | in the Fly image |
| Granule selection | `scripts/imagery/src/selectGranules.ts` | ungated + tile prefilter |
| Weather gate | `scripts/imagery/src/ingestGate.ts` | calibrated against 2025-26 |
| Archive index | `scripts/imagery/src/buildIndex.ts` | one frame per band |
| Published types | `packages/core/src/imageryArchive.ts` | for PR 3 |
| Fan-out | `scripts/imagery/fan-out.sh` | machine-count throttle |
| Retry loop | `scripts/imagery/backfill.sh` | reconcile-until-converged |
| Status check | `scripts/imagery/status.sh` | **use this, not ad-hoc greps** |

**In R2 right now:** `masks/winter-2026-27.fgb` (24,831 bodies) + sidecar + tile survey;
`frames/winter-2025-26/` with 1,494 frames and 1,486 manifests. ⚠ **That frame set is stale** — cut
before `footprint`, `bodies[]` and `cost` existed. It must be purged before any real backfill.

**Fly:** app `skating-imagery`, org `personal`, region `sjc`, zero machines at rest.

---

## 2. Measured facts — use these, do not re-derive

Everything here was measured on real data. Where an earlier document disagrees, this is right.

### Job counts, one season (winter 2025-26, Nov 1 – May 5)

| | granules |
| --- | --- |
| STAC items in window | 9,201 |
| Gated at 60% cloud (**abandoned**) | 2,560 |
| Ungated | 8,892 |
| **Ungated + empty-tile prefilter** | **4,485** |

`plans/phase-N6e-satellite-imagery.md` §C5 says nine seasons ≈ 8,000 jobs. **It is 10× low.** Ungated
is 80,028; with the prefilter, 40,365.

### Where a job's time goes — 23-granule sample, all size buckets

Median job **114s**, mean **148s**, range 22–555s.

| stage | median | share |
| --- | --- | --- |
| `tile_visual` | 48.7s | **43%** |
| `overviews_visual` | 23.2s | **20%** |
| `warp_visual` | 7.0s | 6% |
| `feather_proximity` | 5.1s | 4% |
| `pmtiles_visual` | 3.7s | 3% |
| `fetch_masks` | 2.9s | 3% |
| SCL + zonal stats (3 stages) | **5.2s** | **~5%** |

⚠ **An earlier claim that SCL "tripled" job time was wrong** — it compared a 923-body granule against a
672-body one and blamed SCL for a 2.2× larger raster. SCL and the per-body statistics together are
~5%. Do not re-litigate this; the numbers are in every manifest under `cost.stageMs`.

**Cost tracks pixels, not bodies** — 1.53 s/Mpixel, clean. A 1-body granule at 39 Mpixels costs more
than a 220-body one at 44 Mpixels.

### Corpus / tile geography

- 24,831 bodies; 28,722 body-slots across 54 tiles (ratio 1.16 — lakes straddling tile seams).
- 100 MGRS tiles per season, **~50 hold no corpus body** (Ohio, Québec, Atlantic, Gulf of Maine).
- Mean 572 bodies per granule; 18% of granules are on 1,000+ body tiles.
- On a real 672-body composite: **12.2% of pixels are lake**, 53.4% of z14 tiles fully transparent.

### VM sizing

- The largest granule (672 bodies) completes at **1024 MB**. 8192 MB was 8× oversized.
- 256 MB OOMs (`gdalwarp ... Killed`). 2048 MB is the tested-safe setting in use.

---

## 3. ⚠ Cost is UNRESOLVED and blocks the season decision

**Do not run a multi-season backfill until this is pinned.**

`flyctl` has no billing command, so $/machine-hour has only ever been *inferred*. The founder reports
the Fly bill at **$6.36 and unchanged** after a 24-granule sample — which is consistent with either a
dashboard lag or with the true rate being far below the $0.19/machine-hour assumed so far.

**The number to get:** fly.io Dashboard → org → Billing/Usage → **current-month usage** (not the last
invoice), before and after a known run. With ~148s mean and 4,485 granules, one season is ~184
machine-hours; nine is ~1,660. The rate turns that into dollars and nothing else does.

Founder's budget: *"a $40 one-time expense for all 9 seasons is acceptable… what I wouldn't want is to
run that several times and end up pushing $100."* Founder is content with **fewer seasons** — possibly
one — until the MVP proves out.

**The recurring cost matters more than the backfill.** ~6 passes/month over the region is roughly half
a season's granules every month, forever. Optimising per-granule cost is not a backfill concern.

---

## 4. The optimisation lead worth taking first

**63% of every job is `tile_visual` + `overviews_visual`,** and both scale with raster extent. Each
granule builds ONE bounding box around every body it touches — on a tile like Champlain's that is
essentially the whole 110 km granule — and **~88% of those pixels are transparent**.

Two directions, measured:

1. **`gdal raster tile` is ~6× faster than `gdal_translate -of MBTILES`** for the same base zoom
   (5.6s vs 34.0s on a real 108-Mpixel composite, comparable output bytes; both already skip fully
   transparent tiles). ⚠ **Blocked on a format gap**: `--output` is always a *directory*, and
   `pmtiles convert` only accepts MBTiles. Needs a directory→MBTiles/PMTiles step to be usable. This
   is the cheapest big win if that gap can be closed.
2. **Per-cluster cutting** — group nearby bodies and cut a small raster per cluster instead of one
   giant per-granule extent. **No resolution is lost**; only empty space shrinks. Costs: multiple
   artifacts per granule, more index entries, and PR 3 fetching several archives per date. A real
   architecture change — prototype before committing.

**Do not** reduce max zoom to save time. Our warp is 14 projected m/px ≈ 10.1 ground m/px, matching
Sentinel's native 10 m. z14 is 6.9 ground m/px (oversampled, lossless); z13 is 13.8 (lossy). The
founder is explicit that clarity over bodies is not negotiable.

---

## 5. Founder decisions already made — do not reopen

- **Cut and store everything; no cloud gate.** Hit Copernicus once, own the pixels, so re-derivation is
  free. (2026-08-24)
- **SAR: pilot one season first.** Build the S1 path, run winter 2025-26, measure cost *and* whether
  SAR is legible over our lakes, then decide on more. **Not built** — `granuleSelection` matches
  `^(S2[A-D])_…` so S1 ids are currently rejected as `unparseable`.
- **Ice classification folds into N6g**, not a new N6f/N6h. Three files still defer it to "N6f", a
  label the shipped public-access phase already holds: `plans/01-decisions.md:4688` (D150's title),
  `plans/07-roadmap.md:1349`, and several §C1/§C5 references in the N6e doc. **Not yet updated.**
- **Fewer seasons is acceptable.** One may be all we do for a while.
- **Split bodies render as a seam** — both frames, hairline border, each date on its own side. PR 3's
  job; the producer supports it via `coveragePct`.

---

## 6. Traps — every one of these cost real time

**Fly**

1. `fly machine run` **ignores `fly.toml`'s `[[vm]]`**. Pass `--vm-size` AND `--vm-memory`; they are
   independent, and `shared-cpu-4x` defaults to 1024 MB. An OOM appears as `Killed`, a generic exit.
2. `--detach` is required, or the CLI monitors each machine for minutes.
3. `--rm --restart no` — flyctl defaults to `on-failure`, which crash-loops a bad granule on the bill.
4. Never plain `fly deploy` (creates an always-on Machine). Use `--build-only --push`.
5. `fly secrets` needs `--stage`; **`Staged` is the correct permanent state**, and flyctl's advice to
   run `fly secrets deploy` is wrong for a zero-Machine app.
6. Region is **`sjc`** — `sea` is deprecated and refuses new resources.
7. **Counting only `state == started` undercounts machines.** `created`/`starting` are invisible to
   it. Use `status.sh`; it counts every row and reports UNKNOWN rather than 0 on an API failure.

**Shell / GDAL**

8. A `#` comment between backslash-continuations **eats every argument after it**. Twenty machines once
   ran with no granule id and every log line said `spawned`.
9. **zsh does not word-split unquoted parameters** like bash. `ogrinfo -spat $bbox` silently passes one
   argument; with `2>/dev/null` it reads as "zero features". This produced a false all-clear.
10. `ogr2ogr -t_srs` on a spatial filter matching nothing **fails** (`Reprojection failed`) rather than
    returning empty. Count first with `ogrinfo`, then convert.
11. FlatGeobuf has no `DeleteLayer`, so `ogr2ogr -overwrite` fails when the target exists. Unlink first.
12. `gdaladdo` needs **explicit power-of-two levels**; auto-derived factors fail on large rasters
    (`Overview factor '129' is not a power of 2`) — so only the biggest jobs break.
13. `ogrinfo` has no `-clipsrc` (that is `ogr2ogr`). Using it made all 100 tiles unreadable.
14. `pgrep` exits 1 on no match and kills a script under `pipefail`.
15. SCL is **class labels** — every resample is `-r near`. Interpolating class 8 and 10 yields class 9.

**Scale**

16. Throttle on **running machines**, not spawn calls — a detached spawn returns in under a second.
17. A spawn is not a result. Verify with `build-index`, which is built by listing the bucket.
18. The zonal stat must be **windowed**; a 237-Mpixel UInt32 zone array is 950 MB before numpy copies.

---

## 7. What is left

1. **Pin $/machine-hour** (§3) — blocks everything.
2. **Purge `frames/winter-2025-26/`** — stale, pre-dates `footprint`/`bodies[]`/`cost`.
3. **Prototype the tiling lead** (§4) — 63% of the job.
4. **S1 path** for the SAR pilot.
5. **N6g label fixes** in the three files listed in §5.
6. Then a metered single-season pilot, and only then a season-count decision.

## 8. Open questions

- Is `$6.36` stale, or is the real rate far below $0.19/machine-hour?
- Can `gdal raster tile`'s output reach PMTiles without an expensive intermediate?
- Does per-cluster cutting pay for its complexity, or does the tiler swap suffice?
- Is SAR legible over our lakes at all? §C1 warns black ice and open water both return dark.
