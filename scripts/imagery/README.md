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
