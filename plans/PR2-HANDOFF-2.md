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
| Tile packer | `scripts/imagery/tiles-to-mbtiles.py` | dir → MBTiles, 0.14s |
| Fan-out | `scripts/imagery/fan-out.sh` | machine-count throttle |
| Retry loop | `scripts/imagery/backfill.sh` | reconcile-until-converged |
| Status check | `scripts/imagery/status.sh` | **use this, not ad-hoc greps** |

**In R2 right now:** `masks/winter-2026-27.fgb` (24,831 bodies) + its sidecar. **Nothing else.**
The stale `frames/winter-2025-26/` set (2,980 objects, cut before `footprint`, `bodies[]` and `cost`
existed) and its index were purged 2026-08-24. The next backfill starts from an empty frame prefix.

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

⚠ **Measured before the §4 tiler swap.** `tile_visual` + `overviews_visual` below are the old path;
they are now one `tile_visual` stage plus a `pack_visual` of ~0.1s, at ~2.6× the speed. The table is
kept because it is what established that tiling *was* 63% of a job — the finding the swap acted on.
Re-measure on the metered sample.

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

## 3. Cost — RESOLVED 2026-08-24, and RAM was the whole story

`flyctl` has no billing command, so every figure before this was inferred and **the inference was 3×
too high**. Fly's own dashboard settles it. Lifetime spend $6.36:

| line item | total |
| --- | --- |
| Machines Shared 4x: **Additional RAM** (sjc) | **$5.19** |
| Machines Shared CPU 4x (sjc) | $1.15 |
| Bandwidth egress | $0.00 |

**RAM is 82% of everything spent.** Published `shared-cpu-4x` rates, per machine-hour: 1 GB $0.0112,
2 GB $0.0184, 4 GB $0.0329, **8 GB $0.0617**.

At ~148s mean over 4,485 granules a season is ~184 machine-hours:

| RAM | per season | nine seasons |
| --- | --- | --- |
| **1 GB** | $2.07 | **$18.64** |
| 2 GB | $3.40 | $30.59 |
| 4 GB | $6.06 | $54.54 |
| 8 GB *(what was being used)* | $11.38 | $102.39 |

⚠ **The single most valuable change in this document: stop passing `--vm-memory 8192`.** The largest
granule in the corpus (672 bodies) completes at 1024 MB. 2048 MB is the tested-safe setting and still
brings nine seasons in around $30. The founder's $40 target is comfortably reachable; at 8 GB it was
not.

This also reorders §4. Considerable effort went into hunting a 6× tiling speedup while the dominant
cost was a flag set wrong. Tiling still matters — it is the *recurring* winter cost, roughly half a
season's granules every month forever — but it is no longer what stands between us and nine seasons.

Founder is content with **fewer seasons** — possibly one — until the MVP proves out. That is now a
product-pacing choice rather than a budget constraint.

---

## 4. The tiler swap — ✅ **DONE 2026-08-24, and it was also a bug fix**

Prototyped and shipped. The format gap turned out to be shallow and the prize turned out to be
different from the one we were chasing.

### The speed half

Measured on the corpus's **largest** granule (`S2C_18TXP_20260215`, Champlain, 923 bodies,
237.7 Mpixels), pinned to 4 threads to match `shared-cpu-4x`, at `GDAL_CACHEMAX=410`:

| | old path | new path |
| --- | --- | --- |
| base tiling (`gdal_translate -of MBTILES`) | 50.6s | — |
| overviews (`gdaladdo`) | 24.3s | — |
| `gdal raster tile`, whole z7–z14 pyramid | — | 28.6s |
| `tiles-to-mbtiles.py` | — | 0.14s |
| `pmtiles convert` | 0.13s | 0.11s |
| **total** | **75.0s** | **28.9s** |

**2.6×, not the 6× §4 previously claimed** — that figure was base-zoom-only, on a smaller composite,
and probably unpinned threads. Tiling was 63% of a job, so the median job goes ~114s → ~70s, a season
7.4h → ~4.5h and ~$3.40 → ~$2.10.

**The format gap was not a wall.** MBTiles is SQLite: a `tiles(zoom_level, tile_column, tile_row,
tile_data)` table plus a `metadata` table. `tiles-to-mbtiles.py` is ~30 lines and costs 0.14s. And
`--min-zoom/--max-zoom` builds the *whole pyramid*, so it replaced `gdaladdo` too — the win was
against 63% of the job, not the 43% the base-zoom comparison implied.

### ⚠ The half nobody was looking for: the archive was rendering lakes as solid black

The old path wrote 3,213 tiles for that granule; the new one writes 2,369. All 844 of the difference
were checked: **843 are pure black under fully-opaque alpha.** One held 27 pixels of a swath-edge
artifact at 245 brightness.

**Cause:** alpha is burned from *mask geometry*, which knows nothing about where the satellite was
looking. The raster is the bounding box of every body the granule touches; the acquisition swath is a
rotated quadrilateral inside it. Every lake in a corner the swath misses got `gdalwarp`'s nodata black
under an alpha saying opaque — including **the northern third of Lake Champlain as a black
lake-shaped blob**. It reads as "this lake is black" rather than "this lake was not photographed",
which is the exact confusion `footprint` and §C4 exist to prevent.

**Why the new tiler fixes it on principle, not by luck:** `scene.tif` inherits `NoData=0` from
Sentinel's TCI, and `gdal raster tile` honours per-band nodata **per pixel**, so out-of-swath pixels
come out transparent even inside tiles it keeps. `gdal_translate -of MBTILES` reads band 4 as alpha
and consults nothing else.

**Two things that limit the blast radius, both verified:**

- **The per-body statistics were never wrong.** `zonal-clear.py` excludes SCL class 0, so an
  out-of-swath body already reported `coveragePct: 0.0` and `clearPct: null`.
- **Nothing in R2 carries it** — the stale frame set was purged before this was found.

### A dead end worth recording, so nobody rebuilds it

An explicit alpha-clipping stage (`gdalwarp -dstalpha` + a windowed numpy `min`) was built and then
deleted. It clipped 13.2M pixels — but that is *the same region* the tiler already drops
(843 z14 tiles ≈ 13.7M source pixels), and a pixel-level diff of the two builds found **zero pixels
different**. It was a redundant stage. The reasoning lives in `cut-granule.sh` step 7 instead, because
the property it protects is real even though the code was not.

⚠ **Also do not re-derive this:** a "black fringe" of ~26,000 pixels appears to survive on the swath
edge. It is not an artifact — it is **dark water and dark ice against snow**, which is precisely what
the product exists to show. A `rgb.max <= 2` heuristic measures lakes, not bugs.

### Still open: per-cluster cutting

Group nearby bodies and cut a small raster per cluster instead of one giant per-granule extent
(~88% of the current extent is transparent). No resolution lost; only empty space shrinks. Costs:
multiple artifacts per granule, more index entries, PR 3 fetching several archives per date. **Now
much weaker** — the tiler swap took the stage it would have optimised.

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
- **Fewer seasons is acceptable.** One may be all we do for a while. **Settled 2026-08-24: the first
  real backfill is winter 2025-26 only**, then decide.
- **Store the RESULTS, not the raw granules** (2026-08-24, closing §8's first open question). Raw is
  ~600 GB–1.2 TB per season → ~$9–18/month *per season, forever* in R2, against ~$0.20/month for the
  cut frames. Re-cutting from AWS is free — Sentinel-2 COGs are open data with no egress charge — so
  raw storage would buy only insurance against AWS deleting the open-data bucket.
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

Done 2026-08-24, all on the branch and unpushed — `pnpm --filter @skating/imagery test` 75/75 green,
`check-types` clean:

- ✅ **Tiler swap + black-lake fix** (§4) — `cut-granule.sh` step 7, `tiles-to-mbtiles.py`.
- ✅ **`FLY_VM_MEMORY` now defaults to 2048**, with `GDAL_CACHEMAX=410` pinned in the Dockerfile so
  the block cache does **not** shrink with the RAM (8192 × 5% = 2048 × 20% = 410 MB — the founder's
  arithmetic, confirmed; the whole benchmark above ran at it).
- ✅ **`FLY_VM_SIZE_LABEL` is finally passed** by `fan-out.sh`. It had never been, so every manifest
  ever written recorded `cost.vmSize: "unknown"` — the one artifact built to compare cost across
  Machine sizes was blind, right as the most expensive setting was about to change.
- ✅ **A frame with no SCL no longer claims zero bodies.** `bodies.json` fell back to `[]` while
  `bodyCount` still said 672, which would make every one of those lakes silently invisible to PR 3's
  membership lookup. Now emits ids with `clearPct: null, coveragePct: null`.
- ✅ **`coveragePct` added to `FrameManifest`** — `zonal-clear.py` has always emitted it and the type
  never declared it, on the exact field the split-body seam depends on.

Left:

1. **Rebuild and push the image**, then a **~20-granule metered sample across size buckets** — mirrors
   the existing 23-granule sample so the numbers are directly comparable. Confirms 2048 MB holds on
   the 923-body worst case and gives a real per-job cost before the season runs.
2. **Then the single-season backfill** (winter 2025-26), ~4,485 granules, ~$2 and ~4.5h.
3. **S1 path** for the SAR pilot — but **spike before building** (§8).
4. **N6g label fixes** in the three files listed in §5.

⚠ **`MAX_PARALLEL` is the cheapest untried lever on wall clock.** 25 was chosen after the 2026-08-23
flood, but that flood was an *unthrottled spawn-rate* bug, not a Fly ceiling — and per-second billing
with no barrier between jobs means concurrency is free. A bounded test at 50 would halve a season's
wall clock for no code.

## 7b. Is the architecture flexible? Yes, and in the direction that matters

A founder question worth recording, because the answer is load-bearing for PR 3 and beyond.

**Imagined pipeline:** store the whole region's raw imagery → cut a chunk per body (bbox + feather) →
mask each into a body-shaped blob.

**Built pipeline:** read granule COGs directly from AWS (never stored) → cut ONE raster per granule
covering every body it touches → bake alpha → PMTiles per granule.

Per-body would be ~24,831 bodies × ~90 passes ≈ **2.2 million artifacts a season** against 4,485.
Better pixel efficiency, far worse file count. Per-cluster (§4) sits between them.

**On "what if imagery should reveal every body in the viewport, not just the selected lake?"** — the
current design already does this and the per-body design would fight it. The archive is **region-wide
and pre-masked**: every body a granule touches is in that granule's PMTiles with alpha baked in, so
revealing a viewport is rendering the archive over that area. No per-body fetch, no tile math — which
is exactly what D148 chose it for (*"scrubbing is swapping an archive URL"*).

The per-lake restriction is **D146, a product decision about where the control lives**, not an
architectural limit. Lifting it is a client change. Under the per-body design, showing 50 lakes in a
viewport would mean 50 fetches. The one thing to watch: a viewport spanning several granules needs
several sources, which MapLibre handles.

## 8. Open questions

Three of the four are now closed:

- ~~Did "cut & store all imagery" mean the RESULTS or the RAW granules?~~ **Results** — see §5.
- ~~Can `gdal raster tile`'s output reach PMTiles without an expensive intermediate?~~ **Yes**, 0.14s
  — see §4.
- ~~Does per-cluster cutting pay for its complexity?~~ **Not now.** The tiler swap took the stage it
  would have optimised; revisit only if the recurring winter cost ever stops being ~$0.57/month.

Still open:

- **Is SAR legible over our lakes at all?** §C1 warns black ice and open water both return dark.
  ⚠ **Spike before building the S1 path.** Cut one S1 granule over Champlain in a week we know was
  frozen and look at it — that is about two cents and an afternoon, against building a whole separate
  collection, id grammar and single-band transform toward a picture that may be unreadable.
  Relevant to the season question either way: **S1B failed in Dec 2021 and S1C did not launch until
  Dec 2024**, so the middle seasons of any nine-season SAR backfill have 12-day revisit, not 6.
- **Is `MAX_PARALLEL=25` leaving wall clock on the table?** See §7.
