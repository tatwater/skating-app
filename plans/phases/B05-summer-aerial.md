# Phase B05 — The summer aerial: our own NAIP archive of the region

*One photograph of the whole region, summer-flown and dated, cut once into our own tiles, so the
console's aerial opens in about a second wherever an operator looks, and seamlessly across state
lines.*

> **Status:** ⚪ **Scoped 2026-11-26** (design only, no code). Decisions **D314** (we own the summer
> aerial: one region-wide archive, rebuilt on demand and offered each July) and **D315** (the
> per-quarter-quad selection rule). Amends **D312**'s source, not its behavior. **D146** and
> **D147** are unchanged. The design waits on the founder forks in §8, max zoom first.
>
> **The token.** `B05`: the work is launch-era console infrastructure, and the `A` era (enrichment,
> `A01`–`A10`) is closed in the README's table, so it is not `A06j` even though its family is A06e's
> imagery. `B02` is spoken for (the store launch, scoped in its own tree, D228–D231), `B03` and
> `B04` are taken, and `B01-6` / `B01-7` are B01's PR sequences. It is a phase rather than a B01 PR
> because it has its own workstreams, its own decisions and its own infrastructure (Governor fork
> G-1 records the alternatives).

---

## §1 — What and why

### §1.1 — What it is

The console map's summer aerial (D312) today asks USGS's `USGSNAIPPlus` `exportImage` to render
each grid cell on demand. A cold view takes **3–45 s** (the register's Co15), its flight date often
never arrives because the identify call answers without CORS headers (Co18), and which frame we see
is USGS's choice, not ours. This phase replaces it with **one raster PMTiles archive of the whole
region**, built by us from NAIP's own cloud-optimized GeoTIFFs, with **the frames picked by the
founder's rule**, cell by cell, and a sidecar that dates every cell. The console reads it as one
`pmtiles://` raster source, the way it already reads the bathymetry and the winter passes.

Behind the archive is a pipeline that can be run whole, by stage, or for a few states, and a July
check that looks for newer summer flights and **offers** a rebuild without spending anything.

### §1.2 — The founder's rulings (2026-11-26)

Quoted where they bear; these are the inputs, not this doc's reading of them.

- **Own it.** *"I'm convinced – I want to own the imagery. Let's build it"*.
- **Region, not per lake.** *"What if we got the whole 5-state region (go ahead and get CT/RI while
  you're at it, just to complete the region) in one go, and then render from our own tiles whatever
  each lake needs? Rather than storing separate satellite layers for each of the 25,000 lakes?"* —
  *"I don't care about per-state; I want to cover the region. And I want the user to be able to
  render the layer seamlessly across state lines as they pan, or if they zoom in on a lake that
  straddles a line."* NY, VT, NH, ME and MA are the supported five (*"Yes, NY is in it"*), plus CT
  and RI: *"Yep, better to grab all the data now and we can crop it later."*
- **What a good frame is.** *"I value recency, but not if it shows dead trees and snow/ice. I value
  high resolution/quality, but only in combination with recency."* *"I'd definitely rather this NAIP
  layer be in summer months if possible"*. *"Also prioritize minimal cloud cover, if that's even an
  issue."*
- **The rule** (*"These are great rules, thanks!"*), per quarter-quad: (1) leaf-on frames only —
  1 June–30 September, plus 20 May onward south of 43.5°N; (2) among those, the newest; (3) a 0.3 m
  frame wins over a newer 0.6 m frame when it is at most two years older; (4) prefer minimal cloud
  cover. NH, MA, CT and RI: 2023 at 0.3 m over 2025 at 0.6 m (*"Agreed"*). Cells whose newer flights
  are all October or later take older summer frames (ME 2018, NY 2019), not foliage frames: *"Sure,
  let's see how it looks and re-address in the future."*
- **Resolution.** *"The higher the resolution the better, assuming it's not just upscaled for no real
  reason. But I don't necessarily see a reason to go higher-res than 1px = 1sqft"*. Asked to choose a
  maximum zoom between (a) z17 everywhere plus z18 where the source is 0.3 m, (b) z18 everywhere,
  (c) z17 everywhere, he answered *"I think 18"* — read here as ambiguous between (a) and (b), and
  put back to him as Founder fork F-1.
- **Upkeep.** *"could we run an every-July cron to reassess the available imagery and offer to
  re-build this layer if it notices a newer suitable pass for any of our region?"* and *"This should
  also become part of a standard machinery pipeline that can be called on demand or via a cron!"*
- **Cost, accepted.** The USGS service is free; owning costs roughly $50–70 a year and buys speed
  (about 1 s for a first view, against 3–45 s), control of which frames, and independence from a
  service we don't run; and it is a layer the skater app could later use (D146 unchanged: a skater
  sees only a reveal clipped to one body).

### §1.3 — Out of scope

- **A skater panning the region in aerial.** D146 stands: imagery for skaters is content clipped to
  one body. The archive could serve a region-wide view; the product doesn't.
- **Color normalization in v1.** Flights from different years, states and sensors differ in tone;
  the mosaic shows that as a quilt, most visibly at low zoom (§5.4). Matching them is later work with
  its own trigger.
- **z19.** At 44°N a z19 pixel is 0.21 m, finer than any source; it would be upscaling with no
  detail behind it. The head maps' zoom ceiling of 19 overzooms the archive's deepest level instead.
- **Canada.** NAIP is US-only and ends 0–7 km past the border; Québec, New Brunswick and Ontario
  show the basemap.
- **A hosted runner.** The heavy stages run on Fly, started from the operator's laptop; a console
  *Rebuild* button that launches them is B01's deferred *hosted ETL runner* decision (§3.4).

---

## §2 — The pipeline

Four stages, each its own run row (§2.6), one entry point (§3.1). The shape is A06e's (D148):
*what to cut* lives in TypeScript and `packages/core`; *how to cut it* in a container that takes one
unit of work; *where it runs* in one Fly-specific script.

### §2.1 — Select: the catalog, the rule, the manifest

**The catalog.** Microsoft Planetary Computer's STAC (`planetarycomputer.microsoft.com/api/stac/v1`,
collection `naip`) lists every NAIP quarter-quad as an item with `datetime`, `gsd`, `naip:year`,
`naip:state`, its bbox and a lossless 4-band COG. Reads are anonymous; asset URLs need a short-lived
SAS token from the anonymous token endpoint. Enumerating the seven states is about 70 POST pages
(1,000 items each); the scouts' snapshot holds **69,207 items** for **9,168 quarter-quads**.

**The rule lives in `packages/core`** (`naipSelection.ts`), so the select stage and the July check
(§3.3) run the same code — the A06i pattern, where granule selection moved into core for the same
reason. Per quarter-quad, with candidates from every state that lists it (319 border cells are
listed by two states, and their frames compete):

1. **Drop what isn't a candidate.** Frames coarser than 0.6 m (NY 2017's and the older 1 m flights);
   an item whose quarter-quad lies outside its labeled state's envelope (§2.1.1); an item on the
   reviewed exclusion list (§2.1.2).
2. **Leaf-on only.** Acquired 1 June–30 September, or from 20 May south of 43.5°N (the
   quarter-quad's middle).
3. **The newest**, by acquisition date. In the snapshot `naip:year` equals the acquisition year for
   every leaf-on frame (the four mismatches — NH and VT 2018 flown in January 2019, NY 2021 flown in
   April and May 2022 — are all leaf-off), so the two-year window is measured in program years and
   ties break by date.
4. **A 0.3 m frame within two years of the newest beats it.**
5. **No leaf-on frame at all.** Six quarter-quads in one north–south strip in Maine's western
   mountains, at 70.53°W from 44.6°N to 45.0°N (running north from Rumford: `4407028ne`, `4407020se`,
   `4407020ne`, `4407012ne`, `4407004se`, `4407004ne`), were flown only in October (2018, 2021,
   2023); their only summer frames are 1 m (July 2015). The founder's October ruling doesn't
   reach them: Founder fork F-7.

**The fallback stack.** The pick's alternates, in the order the rule would choose them if the pick
were struck — every other leaf-on candidate. A frame that doesn't cover its whole cell (a state's
flight ending at a state line or the border, 134 of the Maine picks per the scouts' thumbnails)
lets the next one show through (§2.2). Stack depth in the snapshot: 718 cells have one leaf-on
frame and no fallback; the median cell has three.

**What the rule picks today** (re-run on the snapshot for this doc, identical to the scouts'
`picks_T2.json`):

| State (by the pick's label) | Pick | Cells |
| --- | --- | --- |
| VT | 2025, 0.3 m | 812 |
| NH | 2023, 0.3 m · 2025, 0.6 m | 688 · 2 |
| MA | 2023, 0.3 m | 692 |
| CT | 2023, 0.3 m · 2025, 0.6 m | 385 · 1 |
| RI | 2023, 0.3 m | 85 |
| ME | 2023, 0.3 m · 2021, 0.6 m · 2018, 0.6 m | 1,650 · 807 · 258 (+6 October, F-7) |
| NY | 2024 · 2022 · 2021 · 2019, all 0.6 m | 2,474 · 385 · 132 · 791 |

Before the cloud step (§2.1.2), which moves about twenty.

#### §2.1.1 — The mislabeled Maine 2025 items

The catalog's 744 *"Maine 2025"* items (`me_m_4207239_sw_18_060_20250920`, …) sit at 42.x°N —
Massachusetts quarter-quads, with Massachusetts 2025's own dates — under a `me_` prefix. They are
excluded by **a geometric rule, not by name**: an item whose quarter-quad (decoded from its id, §2.2)
falls outside its `naip:state`'s envelope plus a margin is dropped and reported in the run's counts.
A rule by name (`state = me and year = 2025`) would also drop a genuine future Maine 2025 item,
silently.

#### §2.1.2 — Cloud and glare: a reviewed exclusion list

The catalog has **no cloud property**: NAIP's "≤10% per tile" is an acceptance allowance, not a
measurement. Step (4) of the rule is therefore its own step, applied as **exclusions before the
season step**, so a struck frame falls back to the next leaf-on one:

- **Scoring.** The select stage scores each chosen frame from its 200-px catalog thumbnail
  (neutral-white pixels as a share of valid ones), as the scouts did: of the 9,168 picks, 9,070
  score under 2%, 44 between 2% and 3%, 54 over 3%.
- **Review, not a threshold.** Anything over ~3% is a **candidate**, written to a contact sheet;
  most are false positives (cities, dunes, beaches). A person confirms which are cloud or glare, and
  only those join `naipExclusions.ts` in core — committed, each with its item id, the reason
  (`cloud` / `glare`), and who reviewed it when. The real cases the scouts found: 17 Long Island
  quarter-quads of 2024-07-02 (glare over Great South Bay; they fall back to NY 2022 summer) and 2–3
  Aroostook quarter-quads of 2023-09-22 (to ME 2021). About 20 picks change.
- **Who reviews** is Founder fork F-8.
- **New frames** (the July check, §3.3) are scored at the next select stage; until a person has
  reviewed a new pick's score, the offer says it is unscored.

#### §2.1.3 — The manifest

The select stage writes, per build, two files next to the archive (§2.4), both immutable under the
build's dated key:

- **`…-manifest.json`** — the build's record: the rule's version, the catalog snapshot it read
  (archived to the private bucket, `naip/inventory/<date>/<state>.jsonl.gz`, about 5 MB), the
  exclusion list's hash, and per quarter-quad: its key, the states that list it, the pick (item id,
  acquisition date, gsd, `naip:year`), the fallback stack (ids in order), whether the pick covers its
  cell (`partial`), its cloud score, and the work tiles it touches. Per work tile (§2.2): its input
  hash. About 1.5 MB raw.
- **`…-cells.json`** — what the browser needs for the credit: per quarter-quad, the pick's date and
  gsd and a `mixed` flag when a fallback shows through. About 100 KB raw.

The run's counts say how many cells picked by each step, how many fell back to October, how many
items each exclusion dropped, and assert the rule's invariants on the whole catalog (every cell has
a pick; no candidate beats its pick under the rule) — the full-inventory proof that CI's fixture
can't carry (§7.3).

### §2.2 — Tile: the work tiles, the warp stack, the shard

**The unit of work is a z11 Web Mercator tile** — 1,769 of them touch a quarter-quad (z10 would be
488, z9 135; measured from the quarter-quad outlines). At z11 each is about 220 MB of output and,
at the scouts' ~220 machine-hours for the region, about 7 minutes on a `shared-cpu-4x` Machine: small
enough that a failure costs minutes, large enough that boot time (seconds) is noise.

**The quarter-quad grid is computed, not read.** A key like `4407236se` is a 3.75′ cell: 1° block
(44°N, 72°W), 7.5′ quad 36 of 64, quadrant SE. Its nominal outline in NAD83 is exact from the key
(core, `quarterQuadCell(key)`, with a test against the catalog's footprints). Real images carry about
300 m of overlap past it.

**The warp stack, per work tile.** Inputs mix UTM zones 18 and 19 (the line is 72°W), so a VRT of
the raw COGs can't mosaic them. Instead:

1. For each quarter-quad touching the work tile, for each frame in its stack (pick and fallbacks),
   a **warped VRT** (`gdalwarp -of VRT`): to EPSG:3857 on the archive's pixel grid (`-tap`, the
   deepest zoom's resolution), cut to **its own cell's outline** (`-cutline`), alpha from the
   source's nodata, RGB only (NAIP's fourth band is near-infrared), `-r cubic`.
2. One **mosaic VRT** of those, ordered bottom to top: each cell's oldest fallback first, its pick
   last. Since every input is cut to its own cell, neighbors abut exactly and the 300 m overlaps are
   discarded — no frame from one cell paints its neighbor, and within a cell the pick wins wherever it
   has pixels, its fallbacks wherever it doesn't. A state's flight that ends at a state line falls
   through to the other state's frame of the same cell.
3. `gdal raster tile` over the mosaic, clipped to the work tile: WebP quality 80 (A06e's setting; the
   scouts measured ~8–21 KB a 256-px land tile, under 1 KB water), `--skip-blank`, the work tile's
   zooms (z11 to the archive's maximum, F-1).
4. **Packed into a shard**: the tiles ordered by zoom and then by PMTiles tile id, with a small index
   (tile id, length, hash), uploaded to the private build prefix
   `naip/build/<campaign>/shards/11/<x>/<y>.{pack,idx.json}` with a done record naming the work
   tile's input hash, the image digest, and per-stage timings — the manifest-per-frame record the
   cutter keeps (A06e's lesson: a run records the code that produced it).

**Fallbacks are read only where needed.** A cell whose pick covers it (`partial: false`) contributes
the pick alone; its fallbacks enter the stack only when the pick is partial or the cell sits on a
state line or the border. That holds source reads near the picks' own size rather than the stack's
(the scouts' 9–10 TB counted whole stacks; the pilot measures the real figure).

**Where.** The COGs are in Azure West Europe, so the Machines run in **`ams`** (or `fra`), not the
cutter's `sjc`. Each Machine fetches its own SAS token (they expire; refresh per work tile).

**Idempotent and resumable.** A shard's keys are a function of the campaign and the work tile; a
re-run overwrites them. "Landed" means a done record whose input hash matches the manifest's for
that work tile — **never presence alone** (A06e's `--recut` lesson: a reconcile by presence reports
4,485 of 4,485 landed for a recut that spawned nothing).

**Retries.** `backfill.sh`'s shape: spawn the outstanding work tiles, drain, ask the bucket what
landed, re-spawn the difference, three rounds; whatever is left is reported as failed by work tile,
with its Machine's last log lines. A failing work tile never blocks assembly of the rest — but an
incomplete set is never published (§2.5).

**The container** is the existing GDAL image (`ghcr.io/osgeo/gdal:ubuntu-small-3.13.2`, rclone,
`pmtiles`) with a second entrypoint beside `cut-granule`; every Machine is spawned with A06e's
non-optional flags (`--rm --restart no --detach`, explicit `--vm-size` and `--vm-memory`, the image
pinned by digest, the live-Machine cap counted on every live state). Same Fly app
(`skating-imagery`), whose staged secrets already carry R2 credentials — but see Governor fork G-6 on
which bucket they reach.

### §2.3 — Overviews

Zooms below the work tiles (z8–z10) are built from the shards' z11 tiles by the assembler (each
level a quarter of the one above — a few hundred tiles in all). The floor is z8: the console
is fenced to one body, and the widest body (Champlain) frames at about z9. Below z8 the aerial draws
nothing and the basemap shows.

### §2.4 — Assemble and upload

**The archive can't be patched.** A PMTiles v3 file is a header and root directory in its first
16 KB, leaf directories, then tile data; R2 objects are written whole. Any change is a new archive.
What can be avoided is re-tiling.

**The old archive is the shard cache.** A rebuild re-tiles only the work tiles whose input hash
changed; the assembler copies every other work tile's tiles **out of the current archive** by range
reads (in a clustered archive each work tile's tiles at a zoom are one contiguous run, because the
Hilbert order keeps an aligned block's descendants together). Keeping a separate shard cache would
double storage (~$70 a year) to save work the old archive already holds (Governor fork G-4).

**A streaming writer, not `pmtiles convert`.** `pmtiles convert` wants the whole input as an MBTiles
on local disk and spools its output too — over a terabyte for an archive this size, past what one
Fly volume is understood to hold (unverified, §9). The assembler (`assemble-pmtiles.py`) instead:

1. reads every shard's index (and, for unchanged work tiles, the old archive's directory entries) —
   tens of millions of small entries, a few hundred megabytes;
2. lays the archive out **clustered** (zoom by zoom, work tiles in Hilbert order, tiles by id),
   deduplicating identical tiles by hash, and builds the root and leaf directories;
3. streams header, root, metadata, leaf directories and then the tile data, in that order, into
   `rclone rcat` — a multipart upload with 128 MiB parts (64 MiB × the 10,000-part cap is ~625 GiB,
   too close to the high estimate), so no step needs the archive on disk;
4. hashes the bytes as they pass (SHA-256 into the manifest; a multipart ETag is not a checksum).

It uses the protomaps Python package's serialization helpers, not its `Writer`, which spools to local
disk (unverified names, §9). It runs on one Fly Machine in the Machines' region; R2 has no egress
charge, but Fly bills outbound transfer (§6.2).

**Keys** (the bathymetry archive's convention, `dev/<name>-YYYYMMDD.pmtiles`, immutable — the public
URL is CDN-cached, so a key is never overwritten):

- `dev/naip/naip-summer-<YYYYMMDD>.pmtiles` — the archive
- `dev/naip/naip-summer-<YYYYMMDD>-cells.json`, `…-manifest.json` — §2.1.3

Prod has never been initialized; when it is, prod points at the same dated object (Founder fork F-4).

### §2.5 — Verify, publish, clean up

**Verify** (the operator's laptop, after assembly; refuses to call a build good on any miss):

- **Counts.** The header's addressed tiles against the shards' indexes plus what was copied; every
  work tile in the manifest present; every zoom present.
- **Spot reads.** A few hundred tiles fetched from the **public URL** by HTTP range, byte-compared to
  their shard source; the header and directories read by the same `pmtiles` JS library the web uses.
- **Coverage.** Per quarter-quad, the share of its outline with alpha at z14; anything under 100%
  listed. Expected: only cells cut by the coast or the Canadian border.
- **Seams.** For every quarter-quad edge whose two sides differ in flight (year or gsd), a sampled
  tile pair rendered into a contact sheet; and a low-zoom (z9–z11) overview of the region, so the
  quilt is looked at before anyone else sees it.
- **The report** lands in `.scratch/aerial/<campaign>/report/` (gitignored) and its counts in the
  run row.

**Publish** is by hand, the bathymetry way: set `VITE_NAIP_PMTILES_URL` in both local web checkouts
and on Vercel (Preview and Production), redeploy; set `NAIP_MANIFEST_URL` on Convex dev (§3.3).

**Clean up.** The build prefix (shards, indexes) is deleted once verify passes and the URL is live.
The previous archive is deleted no sooner than a week after the new one is live on Vercel — never
by the build itself, and never the newest key (`run-aerial.sh cleanup <old-key>` refuses both).

### §2.6 — The run record (D218, D310)

Every stage writes an `importRuns` row through `RunLogger`, with a scope stated at start and a
heartbeat as it reports progress, so Machinery can draw a build whole by its campaign id
(`naip-<YYYYMMDD>`). Widen-only additions to `IMPORT_RUN_KINDS` (and `@skating/run-log`'s
`ImportRunKind`, kept in step by `importRunVocabulary.test.ts`):

| Kind | Stage | Scope (`pass`, `states`, `complete`) | Progress (the heartbeat) |
| --- | --- | --- | --- |
| `aerial_select` | §2.1 | `archive`, the seven, `true` (a `--states` run: those, `false`) | per state enumerated |
| `aerial_tiles` | §2.2 | `archive`, the states its work tiles touch, `true` only for a full build | every 25 work tiles landed |
| `aerial_assemble` | §2.3–§2.5 (assembly, upload, verify) | `archive`, the seven, `true` | per zoom written, then per verify check |
| `aerial_reassess` | §3.3 | `survey` (new), the seven, `true` | at start and finish |

**`survey`** is a ninth scope (widen-only): *reads a third-party catalog to learn what changed and
writes nothing but the finding*. None of the eight fit — `derived` is computed from data already
held, `archive` acquires data. `states` carries `CT` and `RI`, which `KNOWN_STATE_CODES` doesn't hold;
the validator takes any string, but anything that renders a run's states by that list must not drop
them (the build checks).

The widen deploys before the first run that writes those kinds (widen → deploy → use).

---

## §3 — On demand and by cron

### §3.1 — One entry point

`scripts/aerial/run-aerial.sh` — a new package, `@skating/aerial`, beside `scripts/imagery` (whose
container and Fly app it reuses), shaped like `run-corpus.sh`: it logs itself with timestamps to
`.scratch/aerial/run-<campaign>.log`, refuses to be piped, and carries one campaign id across every
stage.

```text
run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]
              [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>] [--dry-run]
```

- **`all`** runs select → tiles → assemble → verify, stopping at the first refusal.
- **One stage** re-runs that stage against the campaign's stored manifest.
- **`--states` / `--cells`** narrow what is *considered changed*, not what is selected: the rule is
  always applied to the whole catalog (a cell's pick can come from a neighboring state's flight), and
  then only cells in those states (or listed) whose stack differs from the current archive's are
  re-tiled. **`--from-current`** is the partial rebuild: diff against the current manifest, re-tile
  the changed work tiles, copy the rest from the current archive (§2.4).
- **`--pilot <name>`** writes under `dev/naip/pilot/…` and never touches the production key names.

### §3.2 — What "on demand" honestly means

- **The heavy stages run on Fly**, spawned from the operator's laptop with `flyctl` and the local
  `FLY_API_TOKEN`, as A06e's backfills are. The laptop runs the orchestration for the build's
  wall time (about 9 h for the region on 25 Machines; a pilot minutes), so it must stay awake
  (`caffeinate`) — but every stage is resumable, so a laptop that sleeps costs a re-run of the
  reconcile, not the work done.
- **Convex can launch Fly Machines** — the live imagery pump does (`imageryLive.ts`, `lib/fly.ts`,
  `FLY_API_TOKEN` and `FLY_IMAGE` on Convex dev since 2026-10-09). So a console *Rebuild* is
  technically reachable. It is not built here: a nine-hour campaign with its run rows written through
  `RunLogger` (the `convex run` CLI with a deploy key) and a long-lived assembler is B01's deferred
  *hosted ETL runner* decision, not a button. Governor fork G-5 weighs a Fly "conductor" Machine as
  the step between.
- **So in this phase**, the console's side of "on demand" is D218's: it **shows the exact command**,
  with the campaign id and flags filled in.

### §3.3 — The July reassessment

A Convex job, `aerialReassess`, on the recurrence rollover's shape: **a daily tick with a month
gate** (a no-op outside July, and a no-op again once the year's check succeeded), so a failed
1 July is retried on 2 July rather than next year. Admins can also run it at any time (a Machinery
*Trigger*, D218, with nothing to dry-run because it writes only its finding).

What one check does, in one action:

1. **Reads the current manifest** from `NAIP_MANIFEST_URL` (public, immutable, ~1.5 MB).
2. **Enumerates the catalog** — the same ~70 STAC pages the select stage reads, against a deadline
   inside the action limit; items held as compact candidates per quarter-quad (a few MB), not raw
   STAC JSON.
3. **Applies the core rule** with the committed exclusion list.
4. **Diffs** picks and stacks against the manifest: per state, the changed cells and the newest
   leaf-on flight; the count of new picks with no reviewed cloud score.
5. **Writes one row** to a new table, `aerialReassessments` (the year, when, the manifest compared,
   `unchanged | changed | failed`, per-state counts, at most 500 changed cell keys — the full diff
   is recomputed by `--from-current`, so the row never approaches Convex's 8,192-item array cap),
   and an `importRuns` row (`aerial_reassess`, scope `survey`).
6. **Offers, never spends**: when `changed` and no offer is open, the offer opens (below) and one
   email goes to admins through the existing `operatorAlerts.broadcastToStaff` (roles `admin`, at
   most once per offer). Nothing starts a Machine.

**Bounded.** No document read scales with the corpus: the manifest and catalog are fetched, not
stored; the mutations read and write one or two rows. Convex's 1 s limit binds queries and
mutations, not the action; the action's own limit binds the catalog walk, which is why it has a
deadline and a page count.

**Failure-reporting.** A new `FAILING_JOBS` member, `summerAerial`: the tick is all-or-nothing, so
like `seasonWatch` it is counted, never parked; a failed check leaves a `failed` row and Machinery's
health read shows it; the July gate retries daily. A catalog answering short (fewer items for a
state than the manifest's snapshot held) is a failure, not "unchanged".

**The offer** (where it appears is Founder fork F-2; the recommendation): an **Overview card** for
admins — *"Newer summer flights are available for NH (771 cells, flown Aug 2027). The aerial can be
rebuilt for those cells."* — with the command to copy, the unscored count when there is one, and
*Dismiss until next July*. It is the console's own pattern for a machine finding that waits on a
person (Overview counts what needs someone; the Inbox is what a *person* filed, §5.2 of B01's
design). The email links to it. Accepting is running the command; the card closes when a build
whose manifest postdates the check is published.

**Copy holds to D3**: the card and the email speak of a *summer photograph* and its flight date,
never of ice or conditions.

---

## §4 — The app

### §4.1 — The console's aerial becomes one raster source

`consoleAerial.ts` keeps its contract with the map and the rack and changes its source:

- **One `pmtiles://` raster source** on the shared protocol handler (`mapCanvas.ts`, refcounted),
  `url: pmtiles://<VITE_NAIP_PMTILES_URL>`, so MapLibre reads the zoom range and bounds from the
  archive's header. Tile size per Governor fork G-2.
- **D312's behavior kept**: the *Summer aerial* rack row on every Body console tab, for any console
  staffer, remembered per viewer, never reset by a tab; on, without a switch, under Class conflicts'
  head map; dimmed by mode (`AERIAL_PAINT`); placed by `consoleAerialAnchor` (under any winter pass,
  else the console's raster band — over the body's fill, under hazard fields and every line).
- **Added only to the live map** (`liveMap()`, the theme-switch lesson), and re-added with the new
  mode's paint after a switch.
- **Overzoom.** The head maps' ceiling of 19 is past the archive's deepest level; MapLibre overzooms
  a raster past its source's `maxzoom` natively, so no code is needed.

**Loading and failed** keep their words and the credit's dock:

- `loading` from the switch on until the source reports its view's tiles loaded (`sourcedata` for
  this source id with `isSourceLoaded` — never `idle`, which doesn't fire after a late `addSource`).
- `failed` when the archive's header can't be read (a 404, a CORS refusal, no network): nothing
  draws; *Try again* drops and re-adds the source.
- `partial` when some tiles errored (MapLibre's `error` events for this source); *Try again* reloads
  the source.
- The *"no timeout, because an abandoned cold render isn't cached"* rule goes: tiles are static.

**Blank URL ⇒ the layer never mounts** (the bathymetry rule): no rack row, and the head map draws
without it. D312's "never disabled" holds for a row that exists.

### §4.2 — The credit from the manifest

The credit reads the quarter-quad under **the view's center** (updated on `moveend`), not the frame's
box: `quarterQuadAt(lat, lng)` in core gives the key; `…-cells.json`, fetched once a session when the
aerial first goes on (immutable, so the browser caches it; ~20–30 KB compressed), gives the date and
gsd. *"Aerial · NAIP Jun 2023"* as today; *"Aerial · NAIP Jun 2023 and earlier"* for a `mixed` cell
whose pick doesn't cover it (copy for the founder's pass); *"Aerial · NAIP"* where the center has no
cell (past the coverage). No call to any service — Co18 closes.

### §4.3 — The USGS path is deleted

Once tiles ship, nothing draws from `imagery.nationalmap.gov`, and its code goes in the same PR
(D305's rule for a replaced path):

- **Web:** `useImageryReveal.ts` and its test; `lib/imageryCache.ts` and `lib/imageryCanvas.ts` and
  their tests; the exportImage and identify halves of `consoleAerial.ts` (`aerialDate`,
  `creditPoint`, the reveal call, `aerialMasks`); `useImageryReveal.test.ts`'s entry in
  `src/test/domTests.json`. **The old lake editor** (`LakeEditorMap.tsx`, `/admin/water/$id`) is the
  hook's only other caller (it draws NAIP unmasked under the editor, A06e §5); it switches to the same
  archive layer — a few lines — so the hook has no caller left.
- **Core:** `aerialImagery.ts` (`aerialExportUrl`, `aerialIdentifyUrl`, `parseAerialScene`, the
  scene-name parsers and formatters) and `imageryTiles.ts` (the grid-snap), with their tests, once a
  search shows no other reader (this doc's search found none outside the reveal).
- **What stays:** the constants and helpers other code imports from `useImageryReveal.ts` —
  `FREEZE_UP_LAYER_PREFIX` and `insertBeforeLayerId` (the winter passes, `useFreezeUpFrame`,
  `useFreezeUpSeam`) and `IMAGERY_LOADING_LAYER_ID` (the skater map's layer list) — move to a small
  module of their own; whatever of `imageryLayers.test.ts` tests a survivor moves with it.
  `imageryMask.ts` in core stays (the winter passes' mask bake and `landmarks.ts` use it;
  `AERIAL_MASK_METERS` goes if nothing else reads it).
- **What the skater reveal keeps: nothing, because it is already gone.** The brief this doc was
  written from assumed the skater reveal still uses the hook. It doesn't: B03-4 (#98) deleted the old
  `MapView`, which was its only skater caller; the skater web's imagery is the winter passes alone
  (`ImageryPane` → `useFreezeUpFrame`), and mobile never had an aerial tier. So deleting the hook
  changes nothing a skater sees. Whether a body-clipped summer photograph comes back for skaters,
  from this archive, is Founder fork F-5.

### §4.4 — The env var

`VITE_NAIP_PMTILES_URL` — the archive's public URL. Named for the source, not the rack's label
(which F-6 may change). The sidecar's URL is derived from it (`.pmtiles` → `-cells.json`). Set, as
the bathymetry archive is: both local web checkouts (`apps/web/.env`), Vercel Preview and
Production, `apps/web/.env.example` (blank), the web README's table, and
`05-accounts-and-credentials.md` § 2c. Not EAS: mobile has no console. Convex dev gets
`NAIP_MANIFEST_URL` (§3.3), registered in § 2a.

---

## §5 — Risks and rules

### §5.1 — D3: a summer photograph, with its date

The layer is a photograph flown in summer, two to three years apart per state (D147); it can never
show ice and nothing may imply it does. The credit names the program and the flight month; the July
offer speaks of flights and cells. No word anywhere calls it current, live, or satellite "of today".

### §5.2 — D48 takedowns: the lever is display

D48's takedown is a soft-delist of **a water body** (`listed: false`), so the body leaves the map;
it says nothing about imagery and needs nothing from it. The archive is a public-domain mosaic of the
region, not tied to any body, so a landowner's request has nothing in it to remove — and the
console, the only surface drawing it, is staff-only (D312). If a skater reveal returns (F-5), it is
drawn only for a listed body, so a delisted body gets none. Confirmed against D48's text.

### §5.3 — The public URL

The archive is public on R2 like the basemap and bathymetry, and its URL is in the web bundle every
skater downloads, so anyone can read it — NAIP is public domain, so the exposure is cost, not
license. Cloudflare's edge won't cache an object this large, so every tile is an R2 Class B read:
10 million free a month, $0.36 per million after. Staff use is far below that. **The trigger**: the
cost ledger (D219) showing R2 reads past the free tier, or Class B reads not explained by staff
sessions; the answer then is a Worker in front of the archive caching per tile (the protomaps
serverless pattern), or a token on the read.

### §5.4 — Seams and the quilt

Adjacent cells from different flights differ in color and in leaf-out. The cutlines make the seams
straight and exact (§2.2), but at low zoom the region reads as a patchwork of state flights and
years. In the console, fenced to one body and usually zoomed in, it is mostly invisible; the verify
report shows it before anyone else does. Color matching is out of scope (§1.3).

### §5.5 — The Maine North Woods and other old cells

Maine 2023 didn't fly 565 quarter-quads in the North Woods; they fall back to ME 2021 (807 cells) or
ME 2018 (258) at 0.6 m. That is a recency gap, not a hole: every cell has a summer frame except the
six October-only cells in the western mountains (F-7). The credit's date says how old each is.

### §5.6 — Coast and border nodata

Past the last quarter-quad there are no tiles (`--skip-blank`): the map shows the basemap's ground
and water, which is honest — no photograph there. Inside a cell, pixels no frame covers (a border
flight's edge with no fallback) are transparent the same way. The photograph stops 0–7 km into
Canada with a hard edge.

### §5.7 — Convex's limits

The July action fetches and diffs in memory; its mutations read and write one or two rows; its row
holds at most 500 keys. No `.paginate()`, no corpus-wide read. The Overview card's query reads one
row.

### §5.8 — Credentials

What exists (the register, 05 § 1): the Fly app `skating-imagery` with R2 credentials staged,
`FLY_API_TOKEN` locally and on Convex dev; R2 tokens scoped per bucket; Planetary Computer needs no
account (anonymous STAC and SAS). **What may be new, a founder task:** if the archive lives in a bucket
the app's staged R2 token can't write (G-6), a token scoped to that bucket, staged on the app; and
`NAIP_MANIFEST_URL` on Convex. The founder sets both; no brief displays a value. Every brief that
touches them carries CLAUDE.md's rule verbatim.

---

## §6 — Sizes

### §6.1 — The archive

From the scouts' measurements (6.59 M z17 tiles over ~324,000 km², WebP q80 at 8–21 KB a 256-px land
tile), not re-measured here; ±30%:

| | z18 everywhere (F-1 b) | z17 + z18 where 0.3 m (F-1 a) |
| --- | --- | --- |
| Archive | ~387 GB | ~273 GB |
| R2 storage | ~$5.80 / month | ~$4.10 / month |
| Fly compute, a full build | ~220 machine-hours, ~$4 at `shared-cpu-4x`/2 GB | ~145 machine-hours, ~$2.70 |
| Wall time on 25 Machines | ~9 h | ~6 h |
| Pixel at 44°N | 0.43 m (1.4 ft) | 0.86 m where 0.6 m, 0.43 m where 0.3 m |

Plus, per full build: Fly's outbound transfer for the shards (to R2) and the assembled archive (to
R2), roughly 2× the archive at Fly's North America / Europe rate (about $0.02/GB, unverified: ~$15
for (b)); R2 operations, pennies. A partial rebuild costs its share.

### §6.2 — The code

Estimated per piece against the nearest measured analogue in this repo, then multiplied. **These are
design estimates** — written from the design, anchored on analogues, not from briefs; the Corpus
wave's design estimates ran ~4× low and its briefs ~1.0×, and A06e's cutter grew from 154 lines at
its first commit to 1,569 hardened.

| Piece | Analogue (measured) | Estimate, lines with tests |
| --- | --- | --- |
| Core rule (`naipSelection.ts`: candidates, leaf-on, newest, 0.3 m window, envelope, exclusions, stacks, the cell grid, work tiles, input hashes, the diff) and properties | `granuleSelection.ts` 309 + 214, `stacSearch.ts` 139 + 83 | 1,400–1,800 |
| Select stage (catalog walk, thumbnail scoring, contact sheet, manifest, run row) | `selectGranules.ts` 346, `publishSearchPlan.ts` 81, `bakeMasks.ts` 304 | 900–1,300 |
| Worker (`cut-aerial.sh`, the stack, tiling, the pack) | `cut-granule.sh` 154 → 1,569; `tiles-to-mbtiles.py` 163 | 700–1,100 |
| Orchestrator (`run-aerial.sh`, spawn, reconcile, retries) | `fan-out.sh` 307, `backfill.sh` 238, `status.sh` 107, `run-corpus.sh` 243 | 700–1,000 |
| Assembler (streaming PMTiles writer) and its round-trip tests | `tiles-to-mbtiles.py` 163 (simpler) | 700–1,000 |
| Verify (counts, spot reads, coverage, seams report) | `buildIndex.ts` 129 | 400–600 |
| Container, Fly, README, run-kind widen | `Dockerfile` 114, imagery README 741 | 500–800 |
| Convex: the reassessment (action, table, cron, Trigger, email, `FAILING_JOBS`, queries) and tests | `clerkReconcile.ts` 588 + 1,016; `seasonWatchEmails.ts` 267 + 256 | 1,800–2,600 |
| Web: the source swap, the credit, the lake editor, the Overview card, stories and tests | B01-7a's aerial slice: `consoleAerial.ts` 286 + 212, `AerialCredit` 78 + 88 + 85, `aerialSwitch` 42 + 86 | 1,200–1,800 added; ~3,600 deleted |
| **Sum** | | **~8,300–12,000 new** |
| **Honest range** (×1.5–2 for design estimates anchored on analogues) | | **~12,000–20,000 new; ~3,600 deleted** |

### §6.3 — The PR plan

**Two PRs**, because the web swap can't merge before an archive exists on dev:

1. **B05-1 — the pipeline** (core rule, `scripts/aerial`, the container's second entrypoint, the run
   kinds' widen in `enums.ts` and `@skating/run-log`): ~7,000–12,000 lines. Over CLAUDE.md's ~5,000,
   for a reason: the rule, the worker, the assembler and the run record are one review boundary — a
   reviewer can't judge the warp stack without the manifest or the assembler without the shards'
   layout. It merges after the pilot (§7.4) and before the full run, so the full run is from main.
2. **B05-2 — the app side** (the console's swap and the USGS path's deletion, the credit, the lake
   editor, the July reassessment and its Overview card): ~5,000–8,000 added, ~3,600 deleted. It merges
   once the full archive is on dev and `VITE_NAIP_PMTILES_URL` points at it; the July job belongs here
   because it reads a published manifest and offers through the console.

Governor fork G-7 records the alternative (one PR, or three).

---

## §7 — Build model

### §7.1 — Builders and territories

| Builder | Territory | Owns |
| --- | --- | --- |
| **S** (selection) | `packages/core/src/naip*.ts`, `scripts/aerial/src/select*`, `scripts/aerial/src/score*` | the rule, the cell grid, the exclusion list's shape, the manifest and cells schemas, the select stage, the inventory fixture |
| **T** (tiles) | the rest of `scripts/aerial/**`, the container's entrypoint, `fly.toml` if touched, `IMPORT_RUN_KINDS` and `ImportRunKind` | the worker, orchestrator, assembler, verify, README, the run rows |
| **C** (Convex, PR 2) | `packages/convex/convex/aerialReassess*.ts`, its schema table, `crons.ts`, `recurringJobs.ts`'s table row, `FAILING_JOBS`, `IMPORT_RUN_SCOPES` (`survey`), the email | the July check and its queries |
| **W** (web, PR 2) | `apps/web/**`, the core deletions (`aerialImagery.ts`, `imageryTiles.ts`) | the swap, the credit, the lake editor, the deletions, the Overview card |

### §7.2 — Seams and order

- **Day one, S publishes the types** (`NaipManifest`, `NaipCells`, the work-tile input list) in core;
  T builds against hand-written manifests for the pilot cells until S's select stage lands.
- **T ↔ W:** the archive's tile size and zoom range (G-2, F-1), the cells file and the env var.
- **S ↔ C:** `selectNaipPicks(candidates, exclusions)` and `diffNaipManifests(current, next)` in
  core; C never re-implements the rule.
- **C ↔ W:** the reassessment's one query (`aerialReassess.current`) and its row shape.
- **Order:** S and T in parallel → the local proofs (§7.3) → the pilot (§7.4) with W's swap running
  locally against the pilot key → B05-1 opens → merge → the full run (the founder's go) → C and W
  finish → B05-2 opens → merge.

### §7.3 — What is proven how

- **The rule: properties on the real inventory.** `fast-check` over generated candidate sets (a pick
  is leaf-on whenever any candidate is; no leaf-on candidate is newer than the pick unless the pick is
  0.3 m within two years; an excluded item is never picked or stacked; the stack is every other
  leaf-on candidate in rule order; the answer doesn't depend on input order) **and** on a committed
  slice of the real inventory (~2,000–3,000 rows chosen to hold every edge class: the six October
  cells, the Long Island glare cells, Aroostook, the 319 two-state cells' kind, NY's April and
  October 2021–2024 frames, VT's and NH's January 2019 frames, the mislabeled Maine items, the 72°W
  line). The full 69,207-item catalog is checked by the select stage itself, each run (§2.1.3).
- **The grid.** `quarterQuadCell(key)` against every catalog footprint in the slice: the nominal cell
  sits inside the footprint with ~300 m to spare on each side.
- **The warp stack on real COG windows, locally** (GDAL on the Mac over `/vsicurl/` with a SAS token):
  a z14 window across the VT/NY line on Champlain and one across 72°W; asserted: alpha 100% inside the
  union of cells, no pixel painted by a neighbor's frame, a straight feature (a road) continuous
  across the cutline to a pixel, a partial frame falling through to its fallback.
- **The assembler:** round-trip from synthetic shards plus an old archive: every tile read back by the
  `pmtiles` JS reader byte-equal, clustered order checked, `pmtiles verify` clean.
- **The Convex job:** `convex-test` under the suite's harness, with the catalog and manifest fetches
  faked: unchanged, changed, short catalog (`failed`), the July gate, the offer opening once and one
  email, `FAILING_JOBS` counted.
- **The web:** the source added only to the live map, re-added on a theme switch, the states'
  transitions from MapLibre's events, the credit by the view's center, the lake editor on the same
  layer, no request to `nationalmap.gov` anywhere (a guard-style test over the source).

### §7.4 — The pilot, then the region

**A pilot**, built end to end to dev's bucket under `dev/naip/pilot/…` with its run rows, and looked
at in the console from a local web checkout running B05-2's swap. What it must show: a state line, the
72°W zone seam, a 0.3 m / 0.6 m join, a partial frame falling through, the Canadian border's edge, and
the archive loading in about a second. What it measures: seconds per work tile, bytes per tile at
each zoom (to firm §6.1), source bytes read, outbound transfer, the assembler's throughput. Which area
is Founder fork F-3.

**The full region run** (~9 h, ~25 Machines, a few terabytes read, ~$20 all told for F-1 b) is **the
founder's go/no-go**, given the pilot's numbers.

### §7.5 — Definitions of done

- **B05-1:** every gate green (`pnpm check-types`, lint, the suites); `/code-review xhigh --fix`
  over the PR's range; the pilot built, verified and looked at by the founder; its numbers in
  *What the build found (B05)* below; CI green including Convex's codegen-verify step.
- **The full run:** verify clean (counts, spot reads, coverage limited to coast and border, the seams
  sheet looked at); the archive and sidecars at their dated keys; the run rows read back.
- **B05-2:** the same gates; the console drawing the full archive on dev in both themes on a Body
  console tab and Class conflicts' head map; Co15, Co18 and Co19 closed in B01's register; the July
  job's dry tick on dev reading `unchanged`; no `nationalmap.gov` request in the web app.

---

## §8 — Forks

Founder forks are marked F, governor forks G. Each stands alone.

### Founder forks

**F-1 — The maximum zoom.** You answered *"I think 18"* to (a) z17 everywhere plus z18 where the
source is 0.3 m, or (b) z18 everywhere. At 44°N a tile pixel is 0.86 m (2.8 ft) at z17, 0.43 m
(1.4 ft) at z18, 0.21 m (0.7 ft) at z19. For the 0.3 m sources (VT, NH, MA, CT, RI, and 60% of
Maine) z18 is the ceiling without upscaling, under both options. The difference is the 0.6 m sources
(all of New York and about 40% of Maine, about half the region): under (a) they stop at z17, which
throws away about half of what the camera recorded; under (b) they get z18, a 1.4× upscale that
shows all of it — so (b) is not upscaling "for no real reason". (a) is ~273 GB (~$4.10/month,
~145 machine-hours a build); (b) ~387 GB (~$5.80/month, ~220 machine-hours, ~$4 of compute). (a) also
needs two raster layers stacked in the map, because a tile missing inside a source's zoom range is
drawn blank rather than letting the coarser one show (checked in this repo's MapLibre 6.19 and
`pmtiles` 4.5 code); (b) is one source. **Recommendation: (b), z18 everywhere** — all of every
source's detail, one source, for about $1.70 a month more.

**F-2 — Where the July offer appears.** When the July check finds a newer summer flight for any part
of the region, it can: (a) open a card on the Overview for admins, with the cells and flight date and
the command to run, plus one email to admins linking to it; (b) file an Inbox item; (c) send the email
only. **Recommendation: (a).** The Inbox is for what a person filed; the Overview is where the console
counts what needs someone, and the email makes sure a July finding isn't missed.

**F-3 — The pilot area.** Before the ~9 h region run, one small area is built end to end and looked
at in the console. Options: (a) Lake Champlain's north end where Vermont, New York and Québec meet
(~24 quarter-quads: the state line, Vermont's 2025 0.3 m against New York's 2024 0.6 m, the Canadian
edge, big water) **plus** a few cells straddling 72°W on the New Hampshire–Massachusetts line near
Jaffrey and Winchendon (~16: the UTM zone seam and another state line), ~40 cells, pennies; (b) all of
Rhode Island (~116 cells: one flight, the coast and its nodata, no zone seam, no mixed resolution);
(c) both. **Recommendation: (a)** — it puts every hard join in front of you in one look.

**F-4 — Dev only, or dev and prod, now.** Prod has never been initialized. Options: (a) build to
`dev/` only; at the prod cutover, point prod at the same dated object (no second copy); (b) also
copy it to a `prod/` key now (another ~$5.80/month for an archive nothing reads). **Recommendation:
(a).**

**F-5 — A summer photograph for skaters.** The skater web app no longer shows NAIP at all: the old
map that drew the per-lake summer reveal was deleted in B03-4 (#98), and the phone never had one.
Today a skater sees only the winter satellite passes. The new archive could bring the summer
photograph back for one lake at a time, clipped to it (D146 unchanged). Options: (a) not in this
phase — add it to B04's running list; (b) build it in this phase. **Recommendation: (a)** — it needs
its own design (how a raster is clipped to one body in MapLibre on both clients, what the sheet
says), and this phase is the console's.

**F-6 — What the rack calls the two imagery rows.** The Body console's rack reads *Aerial* (the
winter Sentinel pass, from the Imagery tab) and *Summer aerial* (this layer), which read as one thing
twice (the register's Co7). Options: (a) *Winter satellite* and *Summer aerial*; (b) *Satellite pass*
and *Summer photo*; (c) keep both as they are. **Recommendation: (a)** — it names each by its season
and its kind (one is a satellite, the other a photograph from a plane), and keeps *Summer aerial*,
which you named.

**F-7 — The six Maine cells with no summer frame.** Six quarter-quads in a north–south strip in
Maine's western mountains (70.53°W, 44.6°N–45.0°N, running north from Rumford) were flown only in
October (2 Oct 2023 at 0.3 m; 7 Oct 2021 and 5 Oct 2018 at 0.6 m); their only summer frames are 1 m,
from July 2015. Your October ruling (older summer frames over foliage) doesn't reach them, because
they have no summer frame at 0.6 m or better. Early October there is likely near peak color, so this
is a real foliage frame, not merely a late one. Options: (a) the 2 October 2023 frame at 0.3 m —
newest and sharpest, in autumn color; (b) July 2015 at 1 m — summer green, but eight years older,
over three times coarser, and a visibly blurrier stripe among 0.3 m neighbors. **The
recommendation: (a)**, with the credit showing its date — but (b) if you'd rather hold the
no-foliage line without exception; it is six cells either way, and the July check revisits them.

**F-8 — Who reviews the cloud and glare candidates.** NAIP publishes no cloud measure, so the build
scores each chosen frame from its thumbnail; about 98 score high, mostly cities, dunes and beaches,
and only about 20 are real (Long Island glare, a few Aroostook clouds). Options: (a) the builder
pre-screens with a contact sheet and you confirm only the ones that would change a pick; (b) you
review all of the flagged; (c) the builder decides alone. **Recommendation: (a)** — a few minutes of
your time on the ~20 that matter.

### Governor forks

**G-1 — The phase token.** (a) `B05`, its own phase; (b) `A06j`, beside A06e's imagery; (c) a B01 PR
(`B01-8`). **Recommendation: (a)** — the `A` era is closed, `B02`–`B04` are taken, and the work has
its own workstreams, decisions and infrastructure, which is a phase by the README's rule.

**G-2 — Tile size.** (a) 512-px tiles, read by MapLibre at `tileSize: 512`, so the deepest level is
z17 in tile numbers while its pixels are z18's; (b) 256-px tiles. Same pixels either way. **The
recommendation: (a)** — a quarter of the tile requests (R2 Class B reads), directory entries and
WebP headers. F-1 is worded in pixel terms so it doesn't depend on this.

**G-3 — Assembly.** (a) a streaming PMTiles writer from the shards and the old archive into a
multipart upload, no local copy; (b) a Fly volume and `pmtiles convert` (needs the MBTiles, a spool
and the output on disk — over a terabyte, past one volume, unverified); (c) the laptop (a 387 GB
download and upload, and the disk). **Recommendation: (a)**, proven on the pilot; (b) split by zoom
band as the fallback if the writer fails its round trip.

**G-4 — The shard cache.** (a) The old archive is the cache: a rebuild re-tiles changed work tiles
and copies the rest from the live archive; (b) keep every build's shards in R2 (doubles storage,
~$70 a year). **Recommendation: (a).**

**G-5 — Who runs the heavy stages.** (a) The laptop orchestrates Fly Machines, as A06e's backfills
do (it must stay awake about 9 h; every stage resumes); (b) a "conductor" Fly Machine runs the
whole build so the laptop can close (it needs a Fly token and a Convex deploy key staged on the app —
new credential placements, a founder task); (c) Convex launches it from a console button. **The
recommendation: (a)** now; (b) or (c) is B01's hosted-runner decision.

**G-6 — Which bucket.** The archive must be publicly readable; the Fly app's staged R2 token is scoped
to `skating-imagery`, while the basemap and bathymetry are public in `skating-basemap` (the register
and the imagery README disagree on where the winter frames live). (a) `skating-imagery` under
`dev/naip/` if it already serves `VITE_IMAGERY_ARCHIVE_URL` publicly (no new credential); (b)
`skating-basemap`, with a new token scoped to it staged on the app (a founder task). **The
recommendation: (a), checked at build start.**

**G-7 — How many PRs.** (a) Two: the pipeline, then the app side (above); (b) one, held until the
full archive exists (one review, ~17,000–28,000 lines); (c) three, splitting the July check from the
web swap. **Recommendation: (a)** — the pipeline must merge before the full run is from main, and the
app side can't merge before the archive exists.

**G-8 — The pilot's run rows.** The run kinds are new, and a deploy of an unmerged branch's Convex to
dev can drop another branch's indexes (the shared-deployment rule). (a) The pilot writes its rows to
a throwaway local backend and dev gets rows from the full run on; (b) merge the widen alone first.
**Recommendation: (a).**

**G-9 — Splitting the archive by zoom band.** (a) One archive; (b) two or three by zoom band (only
forced if F-1 is (a), which makes two by construction). **Recommendation: (a)** unless F-1 goes (a).

---

## §9 — Not verified

Relied on from the scouts or from memory, not re-checked for this doc:

- The **sizes**: 6.59 M z17 tiles, ~387 GB / ~273 GB ±30%, 8–21 KB land and <1 KB water tiles,
  ~220 / ~145 machine-hours, ~9 h on 25 Machines, 9–10 TB of source reads (and this doc's claim that
  reading fallbacks only where needed cuts that).
- **Planetary Computer**: lossless 4-band COGs, anonymous SAS tokens and their lifetime, blobs in West
  Europe; the STAC's paging behavior from Convex; whether NAIP COGs carry a nodata value or a mask
  (the stack's alpha depends on it; a dark-water pixel must not read as nodata).
- **Ground facts**: ME 2023's 565 unflown North Woods cells (consistent with the counts here: 2,189
  items against 2,754), NAIP ending 0–7 km past the border, the ~300 m quarter-quad overlap, the
  Long Island and Aroostook cloud and glare cases, the 134 partial Maine picks (thumbnail-based).
- **Infrastructure**: R2's 5 GiB single-PUT cap and 10,000-part multipart limit; Cloudflare not
  caching an object this size at the edge; R2's free 10 M Class B reads and $0.36/M; Fly's outbound
  transfer rate and its volume size limit; the Fly Machine's ephemeral disk size; `ams` and `fra`
  being the right regions for West Europe.
- **Tools**: `gdal raster tile`'s tile-size option; the protomaps Python package's serialization
  helpers (names); `pmtiles verify` on a streamed archive; `rclone rcat` with 128 MiB parts.
- **Which bucket** serves `VITE_IMAGERY_ARCHIVE_URL` publicly (G-6).

Checked for this doc: the inventory's composition by state, year, gsd and month; the mislabeled
Maine items (744, at 42.x°N, a `me_` prefix); the rule's picks re-run (identical to the scouts'); the
six October-only cells; the cloud scores' distribution; the 1,769 / 488 / 135 work tiles at
z11 / z10 / z9; that MapLibre 6.19 draws a missing `pmtiles` raster tile transparent rather than
falling back to its parent; that Convex already launches Fly Machines; that the skater web no longer
calls `useImageryReveal`.

---

## What the build found (B05)

*Empty until the build starts.*
