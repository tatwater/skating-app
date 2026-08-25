# `scripts/imagery` — the granule cutter and its box (N6e PR 2)

Cuts Sentinel granules down to the corpus and publishes masked raster PMTiles to R2, so the freeze-up
scrubber is an archive URL swap rather than a metered API call per lake.

Phase doc: [`plans/phase-N6e-satellite-imagery.md`](../../plans/phase-N6e-satellite-imagery.md) —
**§C2 (D148)** is the decision this directory implements, and the *Settled 2026-08-21* section is
where the hosting call and its one condition live.

> **Working end to end as of 2026-08-23.** A granule id in, a masked PMTiles archive and its manifest
> in R2, on Fly, in about twenty seconds. What is *not* here yet is granule selection and the D149
> weather gate — the cutter has to be told which granules to cut. `--smoke` still runs the plumbing
> alone (one band, no masking) when you want to prove credentials and connectivity without the work.

---

## ⚠ Five ways to get this wrong, each of which costs money

**Read this before running any `fly` command in this directory.** All five are cases where the
obvious command is the wrong one — in #2, it is the command flyctl itself recommends — the failure is
silent, and what it costs you is a recurring bill rather than an error message. They are listed here rather than left in the runbook below because the
runbook is where you look when things are going well.

### 1. `fly secrets set` needs `--stage`

```bash
fly secrets set --app skating-imagery --stage KEY=value      # ✅
fly secrets set --app skating-imagery KEY=value              # ❌ tries to deploy
```

Without `--stage`, flyctl tries to roll the change out to running Machines. This app deliberately has
none, so the command hangs or errors depending on the day. Staged secrets are applied to each Machine
at creation time, which is exactly what a per-job batch app wants.

### 2. `Staged` is the finished state — do **not** run `fly secrets deploy`

After importing secrets, flyctl says this:

```
There are 4 secrets not deployed. Deploy with `fly secrets deploy` to make them available.
```

**Ignore it.** That message assumes a conventional app with long-lived Machines that need restarting
to pick up new environment. This app has no Machines to restart, so `fly secrets deploy` — which is
a deployment, same machinery as #3 below — would create one from `fly.toml` just to deliver them.

`Staged` here means *"no running Machine has these yet,"* which is true and permanent, because there
is never a running Machine between jobs. Secrets are stored on the **app**, and every Machine created
afterward gets them injected at creation time. Since `fan-out.sh` creates a fresh Machine per granule,
each job is born with them.

```bash
fly secrets list --app skating-imagery   # STATUS: Staged, forever, correctly
```

Verified empirically by the `--smoke` run, not just believed — if a job ever dies on
`missing required secret: R2_ACCESS_KEY_ID`, that assumption is what broke.

### 3. Never plain `fly deploy`

```bash
fly deploy --build-only --push --app skating-imagery         # ✅ builds, pushes, creates nothing
fly deploy --app skating-imagery                             # ❌ creates an always-on Machine
```

Plain `fly deploy` creates a long-lived Machine and health-checks it. That is the always-on footprint
this entire architecture exists to avoid — an app with zero running Machines bills nothing, and the
meter is supposed to start when a granule job boots and stop when it exits. A stray deployed Machine
turns a per-second batch bill into a monthly one, and nothing will tell you it happened.

### 4. `--rm --restart no` is what makes a Machine a batch job

```bash
fly machine run "$IMAGE" --rm --restart no -- <granule-id>   # ✅
fly machine run "$IMAGE" -- <granule-id>                     # ❌ defaults to on-failure
```

flyctl's default restart policy is `on-failure`. For this workload that means a Machine that hits a
bad granule crash-loops forever, re-reading it, on your bill. This fan-out has no use for a retry
policy that cannot distinguish a bad granule from a bad build — a failure should be one dead job and
one log line. `--rm` then destroys the Machine when the process exits, so nothing lingers.

### 5. `fly machine run` ignores `fly.toml`'s `[[vm]]` block

```bash
fly machine run "$IMAGE" --vm-size shared-cpu-4x --rm --restart no -- <granule-id>   # ✅
fly machine run "$IMAGE" --rm --restart no -- <granule-id>                           # ❌ Fly's default size
```

`fly.toml` sizes machines created by `fly deploy` — and this app never deploys, so **that `[[vm]]`
block has never applied to a single job**. A machine spawned without an explicit `--vm-size` gets
Fly's small default.

Found the hard way on 2026-08-23, and the failure mode is the reason it is listed here: the first real
transform died with

```
/usr/local/bin/cut-granule: line 161: 676 Killed    gdalwarp -q -t_srs EPSG:3857 ...
```

**`Killed` is an OOM wearing a generic exit code.** Nothing says "out of memory," nothing says "wrong
machine size," and the same granule warps comfortably in 8 GB. `fan-out.sh` now always passes
`--vm-size` (`FLY_VM_SIZE`, default `shared-cpu-4x`); the danger is a hand-typed `fly machine run`
that forgets it and reads as a GDAL bug.

**But do not answer an OOM by reaching for 8 GB — RAM is the bill.** Fly's dashboard, 2026-08-24,
against $6.36 of lifetime spend: **$5.19 was "Machines Shared 4x — Additional RAM"**, $1.15 CPU,
$0.00 egress. Per machine-hour, `shared-cpu-4x` costs $0.0112 at 1 GB, $0.0184 at 2 GB, $0.0329 at
4 GB and $0.0617 at 8 GB, so at ~148s mean over 4,485 granules a season lands at:

| RAM | one season | nine seasons |
| --- | --- | --- |
| 1 GB | $2.07 | $18.64 |
| **2 GB** *(the default now)* | **$3.40** | **$30.59** |
| 4 GB | $6.06 | $54.54 |
| 8 GB *(what it had been running at)* | $11.38 | $102.39 |

The largest granule in the corpus (Champlain, `S2C_18TXP_20260215`, 923 bodies, 237.7 Mpixels)
completes in 1024 MB. `FLY_VM_MEMORY` defaults to **2048**, which is tested-safe with headroom and
brings nine seasons inside the founder's $40 ceiling. Dropping the RAM does **not** shrink the GDAL
block cache with it — see the `GDAL_CACHEMAX` note in the `Dockerfile` for why that is pinned in
absolute megabytes.

### How to check you did not do any of these

```bash
fly machine list --app skating-imagery
```

**Empty between runs is the whole cost model in one command.** If anything is listed while no backfill
is in flight, one of the five above happened. `fly machine destroy <id> --force` to fix it.

### Three more Fly flags that are not optional

- **`--detach`**, or the CLI sits and monitors each Machine for minutes. On a fan-out of fifty that is
  the difference between a spawn loop and a stall.
- **`--region sjc`.** `sea` is deprecated and refuses new resources. It is also the closest live region
  to the AWS bucket the granules are read from.
- **`fly machine run` needs `--vm-size` AND `--vm-memory`** — they are independent, and
  `shared-cpu-4x` defaults to 1024 MB regardless of the size flag. See trap 5 for why `Killed` is how
  that surfaces.

---

## ⚠ Thirteen ways a tool reports success and means nothing of the kind

The section above is about money. **This one is about silence** — every entry here is a command that
exits 0, prints something reassuring, and leaves you with wrong data. They are collected because each
one cost real debugging time at least once, and because the failure mode is always the same shape: the
thing that should have screamed said `spawned`, or `0 features`, or nothing at all.

### Shell

**1. A `#` comment between backslash-continuations eats every argument after it.**

```bash
fly machine run "$IMAGE" \
  # the granule id follows          ← ❌ everything below is silently dropped
  --rm -- "$GRANULE_ID"
```

Twenty Machines once ran with no granule id at all, and every log line said `spawned`. There is no
warning; the continuation simply ends at the comment.

**2. zsh does not word-split unquoted parameters the way bash does.**

`ogrinfo -spat $bbox …` passes the whole bbox as **one** argument in zsh. Paired with `2>/dev/null` it
reads as *"zero features"* — which is a perfectly plausible answer for a granule over open ocean, so
it produced a confident all-clear across an entire tile sweep. Quote and split explicitly, and be
suspicious of any `2>/dev/null` sitting next to a count.

**3. `pgrep` exits 1 when nothing matches, which kills a script under `pipefail`.** "No jobs running"
is the normal state of a reconcile loop, so this fails exactly when things are going well.

**4. `MAX_ARG_STRLEN` truncates a large `jq` argv, and only on Linux.** Every granule on a 1,000+ body
tile failed to write its manifest, while all the smaller ones succeeded — so ~18% of a season would
have vanished, specifically the densest frames over the regions holding the most lakes. **It does not
reproduce on macOS**, where a 255 KB argument passes cleanly, so anyone testing locally concludes the
path works. `cut-granule.sh` now uses `--slurpfile`; see the note there.

### GDAL / OGR

**5. `ogr2ogr -t_srs` on a spatial filter that matches nothing *fails*** with `Reprojection failed`
rather than returning an empty layer. Count with `ogrinfo` first, then convert.

**6. `ogrinfo` has no `-clipsrc`** — that is `ogr2ogr`. Passing it anyway made all 100 tiles in a
sweep unreadable.

**7. FlatGeobuf has no `DeleteLayer`, so `ogr2ogr -overwrite` fails** the moment the target exists.
Unlink first.

**8. `gdaladdo` needs explicit power-of-two levels.** With none given it derives factors from the
raster's own size and the MBTiles driver rejects them — `Overview factor '129' is not a power of 2`.
Small granules never hit it, so this breaks **only the biggest jobs**, which are the ones a backfill
can least afford to lose.

**9. SCL is class labels, so every resample is `-r near`.** This applies to the overview pyramid
exactly as it applies to the warp, which is why `--overview-resampling` is set explicitly rather than
left at its default of `average`. Interpolating class 8 against class 10 invents class 9 — a different
category, silently.

**9b. L2A reflectance is `DN * scale + offset`, and the offset changed mid-archive.** Processing
baseline **04.00 (2022-01-25)** introduced `BOA_ADD_OFFSET = -1000`, so `offset` is `-0.1` on recent
granules and `0` on older ones. In a normalised index the scale cancels and **the offset does not**:
on the synthetic snow pixel used to verify `zonal-ndsi.py`, the same DN pair yields **NDSI 1.000 under
the new baseline and 0.778 under the old** — either side of the 0.4 threshold the snow literature
uses.

A nine-season backfill spans January 2022, so a hardcoded offset puts a **step change at the baseline
switch that is indistinguishable from a climate signal**, in a series whose whole purpose is comparing
seasons. Both values are read per granule from STAC's `raster:bands`, and `measure_ndsi` skips NDSI
entirely rather than assuming them — `null` is recoverable, a plausible wrong number is not.

### Scale

**10. Throttle on *running* Machines, not on spawn calls.** A detached spawn returns in under a second,
so counting spawns counts nothing.

**11. Counting only `state == started` undercounts.** `created` and `starting` are invisible to it.
Use `status.sh`, which counts every row and reports UNKNOWN rather than 0 when the API call fails —
a 0 from a failed API call reads exactly like a finished run.

**12. A spawn is not a result.** Verify against the bucket with `build-index`, which is built by
listing R2 rather than by remembering what was launched. This is the same reasoning `backfill.sh`
encodes; see [because a spawn is not a result](#backfillsh--because-a-spawn-is-not-a-result).

⚠ **Related, and not a trap so much as a memory ceiling:** the zonal statistic must be **windowed**.
A 237-Mpixel UInt32 zone array is 950 MB before numpy copies it, which is an OOM on any Machine size
this workload should be paying for.

---

## The three-part shape, and why it is three parts

| | Lives in | Knows about |
| --- | --- | --- |
| **What to cut** | `src/` — the mask bake, the granule selection, the D149 weather gate | the corpus, the season, STAC |
| **How to cut it** | `Dockerfile` + `cut-granule.sh` | one granule id, GDAL, R2 |
| **Where it runs** | `fly.toml` + `fan-out.sh` | Fly |

That split is the condition attached to choosing Fly at all. From the phase doc: *"Lock-in is low if
orchestration stays host-neutral — make the container's entrypoint take one granule id and keep
'which granules, when' outside Fly's Machines API."* `fan-out.sh` is the **only** file here that
mentions Fly. Leaving is rewriting it; it is about ninety lines.

## Why Fly, restated honestly

The original tie-break was self-hosted ORS, which is still sitting in *Later/deferred* and may never
be built — thin ground, and the phase doc says so. What actually justifies it is **parallel fan-out
during backfill**: one season is ~750 granule jobs, five days serial, a few hours across 25 per-job
Machines, **at the same total cost** because billing is per-second and the jobs share nothing.

The operational edge to know going in: **Fly volumes are host-pinned with no multi-attach.** Which is
why nothing here uses one. Every job works on the Machine's ephemeral root disk and dies with it.

---

## The mask bake — why the geometry is not computed in the container

```bash
pnpm --filter @skating/imagery bake-masks --limit=40    # smoke: a few bodies, never uploaded
pnpm --filter @skating/imagery bake-masks --upload      # the real artifact
```

The reveal is a **shape** (D146): the lake, the walk in, and the parking, each buffered and unioned.
That shape comes from `revealShape` in `@skating/core` — the same function the web client uses — and
it is TypeScript, which the GDAL container is not.

Putting Node in the image to call it would be the wrong trade twice over. The masks depend on body
polygons and access points, which change rarely, while **~1,000 granules a season clip against the
identical shapes** — so computing them per granule repeats the expensive half of the job a thousand
times. Baking once per season and staging the result also keeps geometry out of the container, which
is what keeps D148's host-neutrality claim true rather than aspirational.

### FlatGeobuf, and the design it replaced

The corpus is ~25,000 buffered shapes — call it 150 MB as GeoJSON — and each granule job needs only
the handful of bodies its own granule covers. GeoJSON gives a reader no way to ask that question: it
would download and parse the lot to find sixty lakes, once per job.

FlatGeobuf carries a packed Hilbert R-tree **inside the file**, and GDAL uses it over HTTP range
requests. So a job runs `-spat` against a `/vsicurl/` URL, fetches the index, and reads only the
intersecting features. Verified locally before it was built on: a two-feature file with a spatial
filter returned exactly the intersecting one.

The alternative was one mask file per Sentinel MGRS tile, keyed off the granule id
(`S2C_`**`18TXP`**`_20260215`). It works, and it costs a tiling scheme, a naming convention, and a
story for bodies that straddle two tiles. The spatial index answers the same question with none of it.

### ⚠ Two artifacts, because the picture and the measurement are different shapes

A bake writes **`masks/<season>.fgb`** (the reveal — lake ∪ walk ∪ parking, each +60 m, island holes
dropped) and **`masks/<season>-water.fgb`** (the body polygon exactly as the corpus holds it, holes
intact). The first is burned into alpha; the second is burned into the zone grid every per-body
statistic joins on. The sidecar's `waterMasks: true` is what tells the container the pair exists, and
`fetch_masks` **refuses to run against a bake that predates it** rather than falling back.

**Until 2026-08-25 there was only the reveal, and it was used as the zone grid.** So `clearPct`,
`coveragePct`, `snowIcePct`, `waterPct`, `vhDb` and `vvDb` were all measured over a lake *plus* a 60 m
ring of shore, *plus* its islands, *plus* a trail corridor and a car park.

The error is a fixed-width ring, so its share scales with perimeter over area. **Measured on the first
40 bodies of the real corpus**, comparing the two artifacts a bake now writes:

| body size | n | median share of the old zone that was **not lake** |
|---|---|---|
| under 10 acres | 8 | **70%** |
| 10–100 acres | 19 | 47% |
| over 100 acres | 13 | 23% |
| **all** | **40** | **44%** |

Worst case in that sample is Skylight Pond, 1.3 acres, at **86% land** — which matches the arithmetic
for a circular 1-acre pond exactly. Seymour Lake at 1,747 acres is 13%. Two consequences worth stating
plainly:

- **N6g Lane 2** eliminates bodies on *"never observed frozen"*, and the size class it targets is the
  one where the surrounding woods were casting the vote.
- **Radar is worse.** Forest is the classic bright `VH` target at ~−13 dB against smooth ice near −22,
  a ~10 dB contaminant on the ~2 dB separation the archive exists to detect. The 2 dB was measured
  *through* the contamination, so the real separation is larger than the recorded figure.

Nothing errored, because a contaminated percentage is still a percentage. The corroboration was in the
repo the whole time: `zonal-clear.py` recorded Mascoma at 98% clear reporting **82.5% water**, and a
60 m ring on ~16 km of shoreline is about the missing 17.5%.

### The interior statistics, and why the count matters more than the percentage

`build_interior` runs one `gdal_proximity` pass over the zone grid so each statistic also reports what
it looked like with the shoreline eroded off. ⚠ **`EROSION_M` is a centre-to-centre distance, so it
erodes one ring fewer than it reads**: a threshold of *k* pixel widths removes *k−1* rings. Verified on
a synthetic 20×20 lake — at 20 m (≈2 grid pixels) the interior came out **18×18, not 16×16**. Optical
uses 20 m (one ring, the mixed-pixel fix); radar uses 60 m (two rings, because a bank pixel there is a
10 dB target whose energy spreads further than one pixel).

**The point is the denominator, not the cleaner number.** N6g Lane 2 warns that a body too small to
classify reads exactly like a body that never froze. On the same fixture a **3×3-pixel pond comes out
with exactly one interior pixel** — so `interiorPixels` and `interiorTotalPixels` put that caution in
the manifest, where an operator confirming a removal can see it, instead of in a footnote.

### The radar geocode, and how much of the jump it actually removes

A GRD is geocoded at **one average scene height**, so a lake above or below it lands displaced along
range by `(h − h_ref)/tan θ` — and because Sentinel-1 is right-looking, ascending and descending
displace a lake in nearly opposite ground directions. That is the islands-jumping effect.

`sar-deshift.py` moves each body's **pixels** back under its own polygon before anything else reads
them, so the alpha, the zones, the statistics and the tiles all work at true positions. It is a
per-body block copy at whole-pixel offsets — no resampling — and it must be per body: on one
ascending pass a sea-level lake needs 429 m and a 600 m lake needs 298 m *the other way*, a 750 m
spread inside one scene.

**Measured on a real pair 24 h apart over Mascoma** (ascending `…20260213T224345`, descending
`…20260212T105656`), scanning for the offset at which the mask covers the darkest pixels:

| | ascending | descending |
|---|---|---|
| error before | 150 m | 150 m |
| error after | **80 m** | **30 m** |
| asc-vs-desc gap | **291 m (10.4 px) → 107 m (3.8 px)** | |

✅ **The direction is confirmed and it is the load-bearing half** — both passes measured positive
along their own range, in nearly opposite ground directions, which is the signature of a height effect
rather than a polygon error. Applied backwards it would land ~270 m out, worse than not correcting.

⚠ **The magnitude is approximate and consistently over.** The flat-lake model predicts more
displacement than is there (162 m and 129 m against ~108 m of ground truth). One lake on two passes
cannot say why; the candidates are the corpus height, the scene-*average* reference height, and
mid-swath incidence standing in for the lake's own. Interpolating the geolocation grid at the lake was
tried and did not clearly win — it improved one pass and worsened the other.

**So a timeline mixing orbit directions still shows ~4 px of movement, not zero.** Whether that is
good enough is a product call; the statistics improve either way, because a zone 30–80 m off samples
far more actual lake than one 150 m off.

⚠ **`elevationM` must reach the mask file or none of this happens.** On 2026-08-25 a bake produced
**0 of 40** bodies with an elevation, because `listForImageryMask` returned the field in source while
the deployed dev function predated it — every job would have exited 0 and built a nine-season archive
with the correction silently disabled. `bake-masks` now **refuses** below 50% coverage (the corpus is
at 99.5%) and prints the figure on every run. `pnpm convex-dev --once` is the fix.

### What the bake does *not* produce

**The feather.** `SENTINEL_MASK_METERS` is `{solid: 60, feather: 240}`; only the 60 m solid core is
geometry. The 240 m ramp is applied in the container as a distance transform against the rasterised
mask, where ground distance is measurable in pixels and a ramp is one operation. Baking it into
geometry would mean either a second ring (a step, not a ramp) or dozens of them — which is the
stacked-opacity approach `imageryMask`'s own module note records as tried and abandoned.

### The six GDAL steps, and the two that are not obvious

Every one of these was run against a real granule before it was written down —
`S2C_18TXP_20260215_0_L2A`, Champlain, 7.6% cloud, nine bodies under it.

1. **Read only the intersecting masks** — `ogr2ogr -spat` over `/vsis3/`, using the R2 credentials the
   job already holds rather than a public URL. The frames archive will need public access eventually;
   the masks never will, so requiring it here would widen exposure to buy nothing.
2. **Warp to EPSG:3857** at 14 m/px, over the mask extent only. 14 projected metres is ~10 ground
   metres here — Sentinel-2's native sample, so we neither invent detail nor discard it.
3. **Rasterize the masks** onto exactly that grid.
4. **Distance transform** (`gdal_proximity`) — this is the feather, and it is a true ramp by ground
   distance rather than a blur.
5. **Distance → alpha** via a `gdaldem color-relief` two-stop ramp.
6. **Tile, pack and convert** — `gdal raster tile` writes the whole z7–z14 pyramid as a WEBP tile
   directory, `tiles-to-mbtiles.py` packs it into MBTiles, `pmtiles convert` finishes.

**⚠ The feather is measured in projected metres, and they are not ground metres.** Web Mercator
inflates distance by 1/cos(φ) — ~1.39× at 44°N. Handing `gdal_proximity` a bare 240 would ramp over
240 *projected* metres, which is **173 m on the ground**: a 28% error that reads as a slightly tight
edge rather than as a units bug. `groundMetersPerPixel` carries the identical correction on the
client; step 4 is the server's copy of it.

**⚠ Step 6's tiler is load-bearing for correctness, not only for speed.** It replaced
`gdal_translate -of MBTILES` + `gdaladdo` on 2026-08-24, and the swap did two things.

*It is 2.6× faster.* On the largest granule in the corpus, at four threads to match `shared-cpu-4x`:
75.0s (50.6 base + 24.3 overviews + 0.1 convert) against 28.9s (28.6 pyramid + 0.1 pack + 0.1
convert). Tiling was 63% of a job, so the median job goes ~114s → ~70s.

*And it stopped the archive rendering lakes as solid black.* The alpha is burned from **mask
geometry**, which knows nothing about where the satellite was looking: the raster is the bounding box
of every body the granule touches, while the acquisition swath is a rotated quadrilateral inside it.
Lakes in the corners the swath misses got nodata black under a fully-opaque alpha — **843 of 3,213
tiles on that granule, 26% of its output**, including the northern third of Lake Champlain as a black
lake-shaped blob. `gdal raster tile` honours the source's per-band nodata (`scene.tif` inherits
`NoData=0` from Sentinel's TCI) and applies it **per pixel**, so out-of-swath pixels come out
transparent even inside tiles it keeps. Verified against a build with the alpha explicitly clipped to
a `-dstalpha` validity band: zero pixels differed, which is why no separate clipping stage exists.

**So do not swap the tiler back without restoring that property.** `gdal_translate -of MBTILES` reads
band 4 as alpha and consults nothing else — exactly how the black lakes got written.

Two flags in step 6 that fail quietly if dropped. **`--convention tms`**: MBTiles numbers rows from
the bottom and the tiler defaults to `xyz`, so packing without it yields a vertically mirrored
archive — every tile individually correct, the map upside down, and no error anywhere.
**`--min-zoom 7 --max-zoom 14`**: z14 is 9.55 projected m/px against our 14 m/px warp, so it keeps
everything we paid to fetch where z13 (19.1) would throw it away — the founder's "no zoom floor" call
cuts the same way. The range is coupled to step 2's `-tr`; change one and the other has to move.

This also retired an old trap: `gdaladdo` needed explicit power-of-two levels because it derived a
factor of 129 on large extents and the MBTiles driver rejected it, so only the biggest granules
failed. Stating the zoom range directly leaves no derived factor to be wrong.

Two smaller notes. `gdaldem color-relief` is used instead of `gdal raster calc` because calc needs
muparser (*"Dialect 'muparser' is not supported by this GDAL build"*) and `gdal_calc.py` needs Python
bindings the `-small` image may not ship — color-relief is core C++ with neither dependency. And
rclone logs one `NotImplemented` failure against R2 before succeeding on its retry; it is benign and
self-correcting, but it is noise worth eventually silencing rather than learning to skip past.

### A granule with nothing under it is a success

Plenty of granules over five states cover only land, or Québec, or ocean. Those exit **0** with
"nothing to cut". Exiting non-zero would light up a fan-out with red for jobs that did exactly the
right thing, and that noise is how a real failure gets missed.

### Two failure directions, and which one this takes

`revealShape` returns `null` when a union collapses, and core is explicit that this means *"do not
reveal"* rather than *"reveal everything"* — a reveal that fails open is a photograph of the whole
Northeast with no way to tell which lake you were looking at. So a body that fails is **omitted**, and
the archive simply never shows it.

That is the safe direction and it is also a silent one, which is why the bake **counts and prints
every omission** by reason and refuses to write an empty artifact at all. Silent truncation across
25,197 bodies reads as "covered everything" when it did not.

`--limit` runs are marked PARTIAL and refuse `--upload`, for the same reason: a partial bake published
under the season's real key is indistinguishable from a good one, and every granule cut against it
would quietly drop most of the region.

---

## One-time provisioning

Everything below assumes `brew install flyctl` (done) and a Fly account.

### 1. Log in — this step cannot be automated

```bash
fly auth login
```

flyctl refuses a non-interactive terminal (`Error: fly auth login requires an interactive terminal`),
so this one runs in your own shell. Confirm with `fly auth whoami`.

### 2. Create the app

```bash
fly apps create skating-imagery --org personal
```

No deploy, no Machine, no bill yet. An app with zero running Machines costs nothing — the meter starts
when a job boots and stops when it exits.

### 3. Stage the R2 secrets

Use `import`, not `set` — it reads `NAME=VALUE` pairs from **stdin**, so the values never appear in
`argv`, in `ps` output, or in your shell history. Type it interactively and end with `Ctrl-D`:

```bash
fly secrets import --app skating-imagery --stage
R2_ACCESS_KEY_ID=<paste>
R2_SECRET_ACCESS_KEY=<paste>
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_BUCKET=skating-imagery
^D
```

`--stage` is load-bearing — see
[Five ways to get this wrong](#-five-ways-to-get-this-wrong-each-of-which-costs-money).

Values come from the **bucket-scoped** R2 API token (Cloudflare dashboard → R2 → Manage API Tokens).
The account endpoint and key pair are the same ones the basemap uses; they are recorded locally in
`scripts/basemap/RCLONE_SETUP.md`, which is **gitignored and must stay that way**.

Bucket-scoped tokens 403 on the account-level `HeadBucket` probe rclone runs by default, which is why
every rclone call in `cut-granule.sh` passes `--s3-no-check-bucket`.

Confirm without revealing anything — `fly secrets list` prints names and digests, never values:

```bash
fly secrets list --app skating-imagery
```

> **`skating-imagery` is its own bucket, not a prefix in `skating-basemap`.** Retention differs: D149
> turns the archive over on the first frame of a new season, and you do not want that lifecycle rule
> anywhere near the basemap. Budget ~1.2 GB per season (§C2) — nine seasons of backfill is ~11 GB.

### 4. Mint a scoped token for anything non-interactive

```bash
fly tokens create deploy --app skating-imagery --expiry 8760h
```

Scoped to this one app, so a leak cannot touch the rest of the org. Export it as `FLY_API_TOKEN`
wherever a cron or CI job needs to spawn Machines — that is also the supported path for the headless
environments where `fly auth login` will not run.

### 5. Build and push the image

```bash
fly deploy --build-only --push --app skating-imagery
```

**Never plain `fly deploy`.** That would create a long-lived Machine and health-check it — the exact
always-on footprint the cost model is avoiding. `--build-only --push` builds, pushes to
`registry.fly.io/skating-imagery`, and creates nothing. Pin the ref it prints into `FLY_IMAGE`.

---

## Running it

```bash
cp .env.example .env.local          # then set FLY_IMAGE (step 5) and MASK_SEASON

# One granule, plumbing only — proves the box reads COGs and writes R2.
fly machine run "$FLY_IMAGE" --app skating-imagery --region sjc --rm --restart no \
  -- S2B_18TXP_20260115_0_L2A --smoke

# A whole pass, MAX_PARALLEL Machines alive at a time.
./fan-out.sh granules.txt

# The same pass, run to completion: spawn, drain, ask the bucket what landed, re-run the difference.
./backfill.sh granules.txt winter-2025-26
```

`--rm --restart no` is what makes a Machine a batch job. flyctl defaults to `on-failure`, which for
this workload means a crash-looping Machine re-reading the same granule on your bill; the phase's
fan-out has no use for a retry policy that cannot tell a bad granule from a bad build.

Watch with `fly logs --app skating-imagery`. Jobs run detached — `fan-out.sh` returns when the spawn
calls return, not when the cutting finishes (pass `--drain` to make it wait, which is what
`backfill.sh` does between rounds).

**For "how many are still running", use `status.sh` and not an ad-hoc `fly machine list | grep`.** It
counts every row rather than only `state == started`, and it reports UNKNOWN instead of 0 when the API
call fails — see traps 11 and 12, both of which are ways a hand-rolled count reads as "finished".

### ⚠ `MASK_SEASON` is required, and it is not the frame's season

`cut-granule` clips against `masks/$MASK_SEASON.fgb` and dies in its first second without it, so an
unset one spawns the whole list, every Machine exits 1, and every line still says `spawned`.
`fan-out.sh` refuses up front for that reason (except under `--smoke`, which reads no mask).

Set it to whichever season `bake-masks` last uploaded — normally the newest, because today's corpus
is the best shape of those lakes we have. The season a frame is *filed* under is a different thing,
derived from its own capture date: a backfill of winter 2025-26 is cut against `winter-2026-27`
masks and lands in `frames/winter-2025-26/`. `backfill.sh`'s `<season>` argument is that second one.

### `backfill.sh` — because a spawn is not a result

A few thousand jobs against any cloud provider will lose a small fraction in ways that leave nothing
behind. Rather than diagnose each, `backfill.sh` reconciles: list the bucket, re-run the difference,
repeat until a round adds nothing new. The miss set never reaches zero — roughly 40% of a five-state
granule list is ocean, Québec or dry land, and those jobs correctly produce nothing — so the plateau
*is* the empty-granule count.

## Verifying the bill is what you think

```bash
fly machine list --app skating-imagery   # empty between runs
fly status --app skating-imagery
```

See [Five ways to get this wrong](#-five-ways-to-get-this-wrong-each-of-which-costs-money) for what
a non-empty list means and how to clear it.

## Local development, no Fly involved

The container's contract is `docker run <image> <granule-id>` and nothing in it imports Fly, so:

```bash
docker build -t skating-imagery .
docker run --rm -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... -e R2_ENDPOINT=... \
  skating-imagery S2B_18TXP_20260115_0_L2A --smoke
```

If that ever stops working, the host-neutrality claim has quietly stopped being true.

---

## Open, and deliberately so

- **Granule source.** `cut-granule.sh` defaults to AWS Earth Search (`sentinel-2-l2a`, anonymous, no
  credentials) because it needs none and `sjc` is the closest live Fly region to it. Copernicus CDSE serves both S2 and
  S1 from one place but needs an account and sits in Europe. Sentinel-1 SAR is in scope (§C1) and is
  *not* free on AWS in the same shape, so this may end up split by band — which the per-job `--region`
  flag already accommodates.
- ~~**VM sizing.** `shared-cpu-4x` / 8 GB is a guess, not a measurement.~~ **Settled 2026-08-24:**
  measured against Fly's billing dashboard, `FLY_VM_MEMORY` now defaults to 2048 and `GDAL_CACHEMAX`
  is pinned so the block cache does not shrink with it. See
  [Five ways to get this wrong](#-five-ways-to-get-this-wrong-each-of-which-costs-money). `fly.toml`'s
  `[[vm]]` block was moved to `2gb` to match, and is still ignored by `fly machine run` — see trap 5.
- **Where buffered geometries come from.** A Convex read per job, or a pre-baked GeoJSON the caller
  stages. The second keeps this container's only network dependencies the granule store and R2, which
  is worth something.
