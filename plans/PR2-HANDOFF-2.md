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

## 4b. The 50-granule run — ✅ **2026-08-24**: concurrency answered, and a latent bug caught

Run on Fly against the rebuilt image. Two questions asked, three answered.

### `MAX_PARALLEL=50` is safe — raise it

The throttle held at **exactly 50** live Machines and drained cleanly. **50/50 frames landed**, no
drops. The 2026-08-23 flood that motivated the cap of 25 was an *unthrottled spawn-rate* bug, not a
Fly ceiling, and per-second billing with no barrier means concurrency is free.

**A season's wall clock: ~7.4h → ~1.7h** (4,485 ÷ 50 × 67s). `.env.local` now carries `MAX_PARALLEL=50`.

### ⚠ Five granules failed, and they were the five worth having

The first pass landed 45 of 50. The five missing were **not** empty — they held **1,767–2,277 bodies
each**, the largest in the sample, while the contrast granule that succeeded held 370. Re-running them
at `MAX_PARALLEL=5` reproduced the failure, which ruled out concurrency.

The cause was `--argjson bodies "$(cat bodies.json)"` in the manifest build. **Linux caps a single
argument at `MAX_ARG_STRLEN` = 128 KiB** — a different and far lower ceiling than the ~2 MB total
`ARG_MAX`. At 98 bytes per body entry that breaks above **~1,342 bodies**, which is precisely where the
sample split. Fixed with `--slurpfile`; 50/50 now land.

**Three reasons this was nearly missed, all worth remembering:**

- It hides from small samples. The earlier 23-granule cost profile peaked at 923 bodies.
- **It does not reproduce on macOS**, where a 255 KB argument passes cleanly.
- It fails *loudly per job* but *silently in aggregate* — a backfill would have reported success on 82%
  of granules and quietly lost the densest frames, over the regions with the most lakes.

### The metered numbers, from 50 real manifests

`cost.vmSize` is populated on **50/50** — the label fix works, and the archive can now be costed from
its own artifacts.

| | old (23-granule sample, pre-swap) | new (50 granules) |
| --- | --- | --- |
| median job | 114s | **66.9s** |
| mean job | 148s | 63.9s |
| s/Mpixel | 1.53 | **0.65** |
| tiling share | 63% (`tile` + `overviews`) | **30%** (`tile_visual` 19.9s) |
| pack | — | 0.1s (0.2%) |

**A season now extrapolates to ~79.6 machine-hours ≈ $1.46**, against the $3.40 §3 projected and the
$11.38 it would have cost at 8 GB. Nine seasons ≈ $13.

Verified end to end: `build-index` reads all 50, and 130 z13 tiles probed from the 2,277-body frame
carry real imagery with **zero** black tiles.

---

## 4c. SAR spike — ✅ **2026-08-24**: legible, but not the way §C1 assumed

Answered locally for about two cents, before building any S1 path. **Champlain, winter 2025-26, one
track (2242/2243 ascending), 14 VV passes, all at 100% coverage.**

**SAR is markedly more legible over our lakes than optical — on a snow-covered day, decisively so.**
Lake-vs-land separation on 2026-02-13, measured inside the corpus masks:

| sensor | lake | land | Cohen's *d* |
| --- | --- | --- | --- |
| **S1 VV** | 39.10 dB | 43.27 dB | **1.33** |
| S2 true colour | 248.0 DN | 223.0 DN | 0.49 |

The optical frame nearly loses the lake among snowy fields; SAR renders it crisply. **2.7× better
separation.**

**But §C1's warning is confirmed by measurement.** Same platform, same track: November open water
reads **38.85 dB** and January ice reads **39.52 dB** — 0.67 dB apart. **VV alone cannot tell smooth
ice from calm open water.** The only unambiguous excursion in the whole season is a ~3 dB brightening
on 2026-03-09/15 (both platforms agree), which is ice *decay* roughening the surface — the wrong end
of the winter for a freeze-up alert.

**⚠ And the S1 path is not "gdalwarp with a different band".** Raw GRD DN is uncalibrated: across the
season S1A reads **+1.01 dB (VV) and +2.17 dB (VH)** above S1C on the same track. VH — the standard
ice/water discriminator — is *swamped* by that offset. A multi-platform timeline built on raw DN would
render an instrument difference as an ice change. Real work needs sigma0 calibration (the per-granule
`calibration-iw-vv.xml` LUT that Earth Search already exposes) or an RTC product.

**Other findings that change the plan:**

- **Revisit is far better than S2**: 13 passes over Champlain in Feb 2026 alone, vs S2's 2–4 usable.
- **It is free on AWS after all.** `sentinel-s1-l1c` reads anonymously over HTTPS — the README's
  "not free on AWS in the same shape" was wrong about access, right about the transform.
- **Geocoding needs no SNAP.** GRD carries GCPs; `gdalwarp -tps` geocodes a window in ~2.7s, and
  terrain correction matters little over a flat lake.
- **⚠ Polarization is mixed across passes** — some HH/HV, some VV/VH. An archive must not mix them,
  which cuts the usable pass count for any single-polarization series roughly in half.

**Recommendation: SAR is worth a pilot, but scope it as calibrated sigma0, not a band swap** — and do
not expect it to date freeze-up on its own. Its clear strength is delineation under snow, where optical
is weakest.

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

Also done 2026-08-24 (see §4b, §4c):

- ✅ **Image rebuilt and pushed** — `deployment-01M0V0M19S7WJACE0S53EPGF7B`, pinned in `.env.local`.
- ✅ **50-granule metered run** — 50/50 frames in R2, `cost.vmSize` populated on all of them.
- ✅ **`MAX_PARALLEL=50` proven safe** and adopted; a season's wall clock is now ~1.7h.
- ✅ **`MAX_ARG_STRLEN` manifest bug found and fixed** — it would have silently dropped ~18% of a
  season, specifically the densest granules.
- ✅ **SAR spiked before building.** Legible and better than optical under snow, but VV cannot
  separate ice from calm water, and raw GRD DN is uncalibrated across platforms.

Left:

1. **The single-season backfill** (winter 2025-26). ⚠ **Re-run `select-granules` first** — the list in
   `.scratch/granules-2025-11-01-to-2026-05-05.txt` holds 2,560 ids and predates the ungating; the
   real figure is **4,485**. At the measured 66.9s and `MAX_PARALLEL=50` that is **~1.7h and ~$1.46**.
2. **S1 pilot**, scoped as calibrated sigma0 rather than a band swap (§4c).
3. **N6g label fixes** in the three files listed in §5.
4. Consider whether `MAX_PARALLEL` should go higher still — 50 was proven, 100 was never tried.

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

- ~~Is SAR legible over our lakes at all?~~ **Yes, and better than optical under snow** — but VV
  cannot separate ice from calm water, and the path needs calibrated sigma0. See §4c.
- ~~Is `MAX_PARALLEL=25` leaving wall clock on the table?~~ **Yes** — 50 is proven, see §4b.

Still open:

- **Can SAR date freeze-up at all, or only delineate?** §4c found the only unambiguous seasonal
  excursion is March ice *decay*. Whether calibrated VH separates November open water from January ice
  is the question a pilot has to answer, and it is the one that decides if SAR earns a place in the
  timeline or stays a delineation aid.
- **Does `MAX_PARALLEL` go higher than 50?** Untested. Each doubling halves a 1.7h season.
- **S1B failed Dec 2021, S1C launched Dec 2024** — so any nine-season SAR backfill has 12-day revisit
  through the middle seasons, not 6. Bears on whether earlier seasons are worth the S1 spend at all.
