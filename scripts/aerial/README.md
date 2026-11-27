# `scripts/aerial` — the summer aerial (B05)

One region-wide raster PMTiles archive of NAIP's summer photographs, cut by us, so the console's
aerial opens in about a second anywhere and seamlessly across state lines. Phase doc:
[`plans/phases/B05-summer-aerial.md`](../../plans/phases/B05-summer-aerial.md) — §2 is the pipeline,
§3.1 the entry point, §7.4 the pilot. Decisions D314–D318.

The shape is the winter cutter's (D148): **what to cut** is TypeScript (`src/`, core's
`naip*.ts`), **how** is one container (`Dockerfile`, `cut-aerial.sh`, `assemble-aerial.sh`), **where
it runs** is one file (`spawn.sh`). The winter cutter's image, scripts and `FLY_IMAGE` are never
touched: the aerial has its own image, pushed to the same Fly app under its own label.

---

## ⚠ Read before any `fly` command

The imagery README's [*Seven ways to get this wrong*](../imagery/README.md#-seven-ways-to-get-this-wrong-each-of-which-costs-money)
all apply here — each costs money silently. The six that bite this directory:

1. **`fly secrets set` needs `--stage`**, and **`Staged` is the finished state**: never `fly secrets
   deploy`. The app's R2 secrets are staged already; a new one is a founder task.
2. **Never plain `fly deploy`.** It creates an always-on Machine. Only `fly deploy --build-only
   --push` (below), which builds, pushes and creates nothing.
3. **`--rm --restart no` on every Machine** (`spawn.sh` always passes them): flyctl's default
   `on-failure` crash-loops a failing work tile on the bill.
4. **`fly machine run` ignores `fly.toml`'s `[[vm]]` block, and `--vm-size` sets CPUs, not memory.**
   `spawn.sh` passes both: `shared-cpu-4x` with 2048 MB for a work tile, 4096 MB for the assembler
   (its region layout measured ~1.4 GB RSS, ~2 GB with buffers).
   ⚠ **A `shared-cpu-4x` throttles a work tile** (the pilot, 2026-11-26): its burst balance drained in
   about three minutes and it ran at ~0.44 of a core after. The pilot's tiles ran on
   `FLY_VM_SIZE=performance-4x` with `FLY_VM_MEMORY=8192` (performance sizes need 2 GB a CPU): 256 s a
   work tile, no throttling, under 0.6 GB used. Which size the full run takes is the founder's go.
5. **No comment between backslash-continuations** — it ends the command and drops every argument
   after it, silently (twenty winter Machines once ran with no granule).
6. **The live-Machine cap is shared with the winter pump.** `spawn.sh` counts every live Machine on
   `skating-imagery` against `MAX_PARALLEL` (25), the pump's included, so a sixteen-hour build holds the
   winter pump's spawns back while it runs. Run the full build when the season can wait a night.

And one that is the aerial's own:

7. **Planetary Computer's anonymous SAS tokens live 15 minutes, and the endpoint hands out the
   current one however little is left** (measured 2026-11-25: minted 03:23:19, expiring 03:38:20,
   served at 03:26 with 12 minutes left). A token fetched once per work tile dies mid-tile.
   `cut-aerial.sh` checks before every read (`AERIAL_SAS_MARGIN`, 180 s), waits out a dying token,
   and tiles a z13 chunk at a time so each run outlives its token. GDAL's error lines quote the
   signed URL; the worker's stderr is filtered so a signature never reaches `fly logs`.

`fly machine list --app skating-imagery` is **empty between runs** (or shows only the winter pump's
`granule-*` Machines): anything named `aerial-*` while no build runs is on the bill —
`fly machine destroy <id> --force`.

---

## The stages

```text
run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]
              [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>] [--dry-run]
              [--old <key>]
```

| Stage | Runs on | What | Run row |
| --- | --- | --- | --- |
| `select` | laptop | the frame rule over the whole catalog (cloud and foliage reviews applied) → `.scratch/<campaign>/manifest.json`, the snapshot in `inventory/` | `aerial_select` |
| `tiles` | laptop → Fly `ams` | uploads the manifest and snapshot, writes a unit per work tile, spawns, drains, reconciles by done record, three rounds | `aerial_tiles`, a heartbeat every 25 landed |
| `assemble` | laptop → one Fly Machine | the streaming PMTiles writer, the overviews (tile zooms 7–10), the date index | `aerial_assemble` |
| `verify` | laptop | counts, spot reads from the public URL, coverage, dates, seams, the viewer page | `aerial_assemble` (label `verify …`) |
| `cleanup` | laptop | deletes an old archive, never the newest, never within a week | — |

`all` is select → tiles → assemble → verify, stopping at the first refusal. **Every argument is
checked first** (`src/tilesRunArgs.ts`, through the same `parseStageArgs` every stage reads): a
pilot (`--pilot`, a `naip-pilot-<YYYYMMDD>` campaign) writes its rows to a throwaway local backend
only and is refused against dev or prod; nothing writes prod's (F-4 a).

**It logs itself and refuses to be piped** — `| tee` reports `tee`'s status, not the run's
(`run-corpus.sh`'s trap). Every line is stamped into `scripts/aerial/.scratch/run-<campaign>.log`.
From a process runner whose stdout is a pipe or socket (an agent's shell), send the output to a
file and read the status: `scripts/aerial/run-aerial.sh … > /dev/null 2>&1; echo $?`, then the log.

The laptop orchestrates for the build's wall time: run under `caffeinate -i`. Every stage resumes —
a done record whose input hash is the manifest's is landed, anything else is re-spawned. The one
exception is an assembly that stops after its archive (or index) went up but before its manifest,
the last write: the published keys are never overwritten, so it refuses again, naming what it left —
nothing names those objects, nothing has served them; `rclone deletefile` them and assemble again.

### Before a full build: the foliage review (D319)

```bash
pnpm --filter @skating/aerial foliage naip-<YYYYMMDD> [--threshold 0.6]
```

Not a stage, and no run row: it reads the campaign's walk (walking the catalog if there is none),
scores every candidate flown from 1 September from its thumbnail (`src/foliage.ts`, cached in
`.scratch/foliage-scores.json`), and writes to `.scratch/<campaign>/report/foliage/`: the review
sheet (`index.html`, by flight day), the proposal (`proposed.json`, every entry
`reviewedBy: 'proposed'`), and the select stage's dry run with the proposal applied
(`manifest-proposed.json`, its cloud sheet in `cloud/`). **The founder confirms by flight day; only
confirmed entries go into core's `NAIP_FOLIAGE_STRIKES`** (`reviewedBy: 'founder'`), by a reviewed
commit. The select stage refuses to build — anything but a dry run — with an unconfirmed entry.
New picks the proposal makes are not cloud-reviewed: read the applied cloud sheet before the build.

### The worker, one work tile (`cut-aerial.sh`)

A z11 work tile in, a shard out (`shard.ts`: the pack, its index, then the done record). Per cell,
every frame of its stack is warped to the counts' grid (pixel zoom 16, the 256-px z16 grid) and
counted in the rule's order — the pick first, each fallback only where everything above it is
empty (`aerial-counts.py`); only the frames that supply a pixel are warped at full resolution, so a
fallback under a pick that covers its cell is never read. Each frame is cut to **exactly its cell's
pixels** (`tiles.ts`' `pixelExtent`: the pixels whose centers are in the cell), not by a cutline: a
cutline is applied on each source's own grid, and two frames on different grids disagreed about the
edge pixel (measured). The mosaic composes them pick last; `gdal raster tile` writes WebP q80 at
512 px a z13 chunk at a time; the zooms above the chunks are built from the chunks' tiles. Every
shallower zoom is a 2×2 average: cubic read past the window's edge and left a translucent rim and a
one-pixel spill at every work tile's edge (measured).

### ⚠ Changing how a pixel is drawn means bumping `NAIP_TILING_VERSION`

A rebuild re-cuts only the work tiles whose input hash changed (core's `naipWorkTileInputHash`: the
rule's version, `NAIP_TILING_VERSION`, each cell's pick, stack, `partial` and the frames it cuts —
core's `naipFramesToCut`, which also reads whether the cell is on a state line). The worker's GDAL
arguments and `tiles.ts`' `TILE_SETTINGS` aren't in it. Change one so the same stack draws
different pixels, and bump `NAIP_TILING_VERSION` in core in the same commit — or a
`--from-current` build copies stale tiles beside new ones. `tiles.test.ts` fingerprints both and
fails until the bump and the new fingerprint land together.

---

## Where it runs, and which bucket (G-6)

- **The work tiles: `ams`.** NAIP's COGs are in Azure West Europe (Amsterdam); a work tile reads
  2–9 GB in and writes ~100–500 MB out. Reads from a Machine in the same metro are what make a
  work tile minutes rather than the laptop's half hour.
- **The assembler: `iad`** (`FLY_ASSEMBLE_REGION`). It reads nothing from Azure: it range-reads the
  shards from R2 and streams the archive back, the whole archive each way, with many small ranged
  reads — so it should sit nearest the bucket. R2 places a bucket near where it was created unless
  hinted, and the team works from the US east; but the bucket's location has **not** been read
  (Cloudflare's dashboard shows it). If it says Western Europe, set `FLY_ASSEMBLE_REGION=ams`. Fly
  bills outbound transfer at the same rate in both.
- **The winter cutter's `sjc`** is beside AWS `us-west-2`, its source; nothing here reads AWS.
- **The bucket: `skating-imagery`** (G-6, checked 2026-11-25 by hosts and names only). The web's
  `VITE_IMAGERY_ARCHIVE_URL` is served from an `r2.dev` public host of its own — not the bathymetry's
  and basemap's host (`skating-basemap`) — at the bucket's root, where it serves the winter
  `index/*.json` that the cutter writes to `R2_BUCKET` (default `skating-imagery`). So
  `skating-imagery` is public, and the archive goes there under `dev/naip/`; the app's staged R2
  token is the one the winter cutter writes that bucket with. No new credential.

---

## The gated steps (each only on the governor's go)

Credentials, by name only (never display a value — `grep -o '^[A-Z_][A-Z0-9_]*=' <file>` lists
names; `set -a; source <file> >/dev/null 2>&1; set +a` loads them):

- `flyctl`'s own login on this machine (or the app's scoped `FLY_API_TOKEN`);
- the Fly app's staged secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`,
  `R2_BUCKET`, read only on the Machines;
- on the laptop, in `scripts/aerial/.env.local` (gitignored): `AERIAL_IMAGE` (the pinned digest,
  step 1), `R2_BUCKET=skating-imagery`, `R2_REMOTE` (default `r2`, the laptop's rclone remote, which
  must reach `skating-imagery` to read the done records and upload the manifest — unverified);
- `CONVEX_DEPLOYMENT` pointing at a throwaway local backend for a pilot.

**1. The image**, under its own label; never re-pin `FLY_IMAGE`:

```bash
scripts/aerial/bundle.sh                       # the two bundles → scripts/aerial/.scratch/image/
fly deploy . --config scripts/aerial/fly.toml --dockerfile scripts/aerial/Dockerfile \
  --ignorefile scripts/aerial/Dockerfile.dockerignore --remote-only \
  --build-only --push --image-label "aerial-$(date +%Y%m%d)"
```

`--ignorefile` names the context's allow-list outright (the pilot's context was 324 kB), and
`--remote-only` keeps the build on Fly's builder — never a local Docker. The digest to pin is in the
build's own output (`pushing manifest for registry.fly.io/skating-imagery:aerial-<date>@sha256:…`);
the registry confirms it without Docker: a `HEAD` of `/v2/skating-imagery/manifests/aerial-<date>`
on `registry.fly.io` with the flyctl token answers `docker-content-digest`. Pin it as
`AERIAL_IMAGE=registry.fly.io/skating-imagery@sha256:<digest>`.

**2. The pilot** (§7.4, `champlain-nhma-me-ny`, ~63 cells), from the integrated branch:

```bash
caffeinate -i scripts/aerial/run-aerial.sh naip-pilot-<YYYYMMDD> --pilot champlain-nhma-me-ny \
  --cells scripts/aerial/pilots/champlain-nhma-me-ny.txt > /dev/null 2>&1; echo $?
```

**3. The full region** — the founder's go, from main after the merge and the run kinds' widen are
deployed, and after his foliage review is committed (above): `caffeinate -i
scripts/aerial/run-aerial.sh naip-<YYYYMMDD>`. Its select stage logs the off-season cells by name
(`noLeafOn`, `allTurned`); the manifest keeps them for the July check.

**Publish and clean up** are §2.5's: `VITE_NAIP_PMTILES_URL` set by the founder, the build prefix
deleted once verify passes, an old archive by `--stage cleanup --old <key>` after a week.

---

## A local end-to-end run, no cloud

The integration's recipe (2026-11-26), for a change that crosses stages: every stage CLI for real
on one pilot work tile, with Planetary Computer, R2 and Fly stood in for locally.

1. **Select and tiles** through `run-aerial.sh <naip-pilot-…> --pilot <name> --cells <file> --stage
   select --dry-run`, then `--stage tiles --dry-run`: the manifest and the units under `.scratch/`.
   Copy a kept walk (`.scratch/<campaign>/inventory/`) and `scores.json` first, and nothing is read.
2. **The cut**: `cut-aerial.sh <unit> --local <bucket dir>`, with `PC_STAC` and `PC_SAS` as
   `file://` URLs (a STAC item per frame, a token file), `CPL_AZURE_ENDPOINT=http://127.0.0.1:<port>`
   and `CPL_AZURE_USE_HTTPS=NO` over `rclone serve http` of a directory of synthetic COGs, a fake
   `AERIAL_IMAGE` digest, and `AERIAL_PACK="node .scratch/image/tiles-pack.mjs"` (the bundle).
3. **Assemble**: copy the manifest to its build key, then `AERIAL_LOCAL_BUCKET=<bucket dir> node
   .scratch/image/assemble.mjs <campaign> --pilot <name>`.
4. **Verify** through `run-aerial.sh … --stage verify --dry-run`, with `RCLONE_CONFIG` holding a
   `type = local` remote named by `R2_REMOTE`, `R2_BUCKET` the bucket dir's absolute path, and
   `R2_PUBLIC_BASE_URL` a static server over it that answers ranges and serves the gzip-bodied
   `-cells.json` with `Content-Encoding: gzip`, as R2 does.

What it can't stand in for: the run rows (a dry run writes none), the Machines, R2 itself and real
frames — the warp proof below covers the frames, the pilot the rest.

## The local warp proof

```bash
scripts/aerial/proofs/warp-proof.sh            # three z14 windows of real frames, ~7 minutes
```

The worker run for real on the laptop (GDAL 3.13.2, Homebrew's Python 3.14 for the bindings) over
three hand-written manifests (`proofs/windows.json`): Champlain's VT/NY line, the 72°W UTM seam on
the NH/MA strip, and a Maine 2023 pick with an unflown strip. `proofs/warp-proof.py` asserts the
cells partition each window, no frame paints a neighbor, no pixel inside the cells is transparent,
the pick shows wherever it has pixels and its fallback fills its holes, the counted frames are
exactly the visible ones, and the two flights at each join register within a pixel. Planetary
Computer is read anonymously; nothing is written but `.scratch/warp-proof/`.

Measured 2026-11-25 (laptop in the US, so network-bound; a Machine in `ams` reads ~10× faster):

| Window | Frames shown / in stacks | Source read | Wall | 512-px tiles at the deepest zoom, mean |
| --- | --- | --- | --- | --- |
| Champlain, NY 2024 0.6 m \| VT 2025 0.3 m | 2 / 9 | 142 MB | 77 s | 42.7 KB |
| 72°W, NH 2023 0.3 m, UTM 18 \| 19 | 2 / 16 | 321 MB | 130 s | 80.0 KB |
| Maine 2023 0.3 m partial → 2021, \| 2018 | 3 / 4 | 135 MB | 71 s | 75.5 KB |

Seams: 72°W registers at 0.00 px both ways (the zone seam is exact); NY 2024 | VT 2025 at 0.00 /
−0.24 px; the Maine forest join at −0.51 px along it (no edge crosses it to register the other
axis). The image itself was built locally and ran the Champlain window to the same counts.
