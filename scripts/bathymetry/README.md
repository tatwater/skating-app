# @skating/bathymetry — state-agency bathymetry ETL (N6b)

Turns five states' published bathymetry into (a) an isobath **PMTiles** overlay drawn inside an open
lake's drawer, and (b) measured **rung-1 depths** for the D68 ladder. Manual and run-on-demand, like
[`scripts/etl`](../etl/README.md) and [`scripts/lake-depth`](../lake-depth/README.md) — **not** built
or deployed with the apps.

Phase doc: [`plans/phase-N6b-bathymetry-layer.md`](../../plans/phase-N6b-bathymetry-layer.md).

---

## The two caches, and why the split is a directory boundary

Every other ETL here keeps its downloads in a `.scratch/` a person is expected to `rm -rf`, with
provenance recorded by hand in a README line reading *"record the download date and md5 in your run
notes."* That is provenance by human memory. This phase needs better, because **the transform is the
part we iterate on** — interpolation, density gates, contour intervals, tiling parameters — and if
each iteration costs a refetch from five state portals, we iterate less.

| | `.raw/` | `.scratch/` |
| --- | --- | --- |
| Holds | exactly what the agency served, plus a manifest | reprojected GeoJSON, interpolation grids, `gdal_contour` output, `.pmtiles` |
| Rebuilt by | a network fetch from a third party | one local command, no network |
| Deleted | **never** — mirror it, don't remove it | freely, any time |
| Gitignored | yes | yes |

Both are gitignored, so the distinction would evaporate as a convention. It is a directory boundary
because a convention does not survive the first `rm -rf` typed at 1am.

### What the manifest carries that the payload doesn't

`.raw/<key>/manifest.json` records the source URL, fetch timestamp, sha256 + byte count per file,
record count, and the **full ArcGIS service descriptor**. That last one matters more than it sounds:
`copyrightText` is where an agency's required credit wording actually lives, it is what §5 renders in
the lake drawer, and it changes without notice.

```bash
pnpm --filter @skating/bathymetry verify        # two cheap requests per source, no payload
```

`verify` diffs today's service against the stored manifest and grades what it finds:

- **breaking** (exit 2) — a field we read has gone, or changed type, or the geometry type changed.
  A transform written against the archive is now wrong for the live source.
- **notable** (exit 0) — the record count moved, or the licence wording changed. One changes what we
  render; the other changes what we *may* render. A human looks.
- **cosmetic** — a field was added, or an HTTP validator moved with nothing else to corroborate it.

The severity split exists because these failures are silent by nature: a renamed column reads zero
contours and reports success. N6a's transform already fails loudly on a header rename; this is that
discipline moved one stage earlier, to where the change is observable.

### The committed record: `PROVENANCE.md`

`.raw/` is gitignored, so on a fresh clone the repo would know nothing about what we hold. [
`PROVENANCE.md`](./PROVENANCE.md) is the committed half — **generated, never hand-edited**:

```bash
pnpm --filter @skating/bathymetry provenance
```

Per source it records where the data came from, **when we captured it**, how many records and bytes, a
content **fingerprint**, the agency's own `copyrightText` *as captured*, the vertical datum, and the
field notes for the traps in that dataset. It is organised **per state**, because agencies republish
independently and so "our records are out of date" is a per-state judgement.

Two details that matter:

- **The fingerprint ignores the fetch timestamp**, so re-capturing identical data compares equal. It
  answers "is my archive the one that produced the current tiles?", which a manifest hash could not.
- **The agency's copyright and the credit we render are shown as two separate rows.** They are
  different things — what they say today vs. what we agreed to display — and a drift between them is
  for a human to read, not for the tool to auto-resolve.

The renderer takes its date as an argument rather than reading the clock, so re-running it on an
unchanged archive produces no diff.

### Refreshing a single state

Staleness is per-state, so refreshing is too. Check first; re-capture only what moved.

```bash
pnpm --filter @skating/bathymetry verify --state=NH             # cheap: no payload pulled
pnpm --filter @skating/bathymetry snapshot --state=NH --refresh # re-capture just NH
scripts/bathymetry/mirror-r2.sh push                            # mirror it
pnpm --filter @skating/bathymetry provenance                    # regenerate the record
```

`--state=` is repeatable and comma-separated, and it **throws on a state with no sources** rather than
matching nothing — a typo'd `--state=NY` silently selecting zero sources would make `verify` report
*"all sources unchanged"*, which is true and completely misleading.

A refresh **replaces** a snapshot. If the old one still matters, `mirror-r2.sh pull` it first — the
mirror is `rclone copy`, never `sync`, so a previous push survives a local overwrite.

### The mirror

An archive on one laptop is not an archive.

```bash
scripts/bathymetry/mirror-r2.sh push      # after a fetch
scripts/bathymetry/mirror-r2.sh pull      # on a second machine
scripts/bathymetry/mirror-r2.sh status
```

⚠ **A different, private bucket from the basemap.** `skating-basemap` has r2.dev public access on so
browsers can range-read the `.pmtiles`; mirroring third-party state data there would republish it as
a side effect of backing it up. `mirror-r2.sh` also uses `rclone copy`, never `sync` — a backup must
not propagate a local deletion.

---

## Prerequisites

| Tool | Install | Role |
| --- | --- | --- |
| [GDAL](https://gdal.org/) | `brew install gdal` | `ogr2ogr` reprojection, `gdal_grid` interpolation, `gdal_contour` |
| [tippecanoe](https://github.com/felt/tippecanoe) | `brew install tippecanoe` | GeoJSON → vector tiles |
| [`pmtiles`](https://docs.protomaps.com/pmtiles/cli) | `brew install pmtiles` | mbtiles → `.pmtiles` |
| [rclone](https://rclone.org/) | `brew install rclone` | the raw mirror + the tile upload |

---

## Sources — what each state actually publishes

Verified live 2026-07-31. **Four of the phase plan's premises were wrong**, and the corrections are
in `src/sources.ts` as `notes` on each entry, because the person who re-runs this will be standing
there rather than in a plan doc.

| State | Agency | Lane | Records | Lakes |
| --- | --- | --- | --- | --- |
| **NH** | NH GRANIT (NHDES + Fish & Game) | **contours** | 9,285 lines | 558 |
| **MA** | MassGIS / MassWildlife | **contours** | 27,989 lines | — |
| **VT** | VT ANR (BioBase sonar) | **soundings** | 2,442,512 points | 66 |
| **VT** | VCGI / NOAA (Champlain) | **soundings** | 104,910 points | 1 |
| **ME** | Maine DEP + IF&W | **soundings** | 147,755 points | 5,000+ |
| **NY** | — | *none published* | — | — |

Two lanes, and the difference is a **provenance claim**, not a file format:

- **contours** — the agency surveyed the lake and published isobaths. We reproject and tile. We invent
  nothing, and the UI says *state-surveyed*.
- **soundings** — the agency published measured depth points. **We** fit the surface, so the UI says
  *interpolated from state soundings*. This lane needs a density gate: a lake with too few points gets
  no contours at all, and every dropped lake is logged.

### The corrections worth knowing before you touch this

- **Vermont publishes points, not isobaths.** The plan's source table said otherwise, which inverted
  the phase's sequencing argument — VT is the *hardest* lane, not the easiest. Its density makes the
  interpolation defensible anyway: the sparsest VT lake carries 5,034 soundings.
- **Maine's IF&W depth maps have already been digitised by the state.** The plan calls them "PDFs, a
  digitisation project, not an ETL." They are the `FMSRC=depthmap` rows.
- **Maine's layer is two datasets in one schema**, and `FMSRC` separates them: digitised IF&W map
  soundings vs. Maine DEP GPS depth-sounder tracks.
- **Maine's metre column was computed with a 3.3 ft/m constant**, so the published `DEPTHF` is
  systematically **0.58% shallow**. Recover feet as `DEPTHM * 3.3` for the depthmap rows.
- **Contour interval is per lake, not per state.** The plan's example label — *"NH GRANIT, 10 ft
  contours"* — describes a uniformity that does not exist in any of the three contour sets.
- **Everything is feet.** D83 assumed a VT-metres / NH-feet seam at a state line. There isn't one.

---

## 1. Probe — before adding a state

```bash
pnpm --filter @skating/bathymetry probe <layer-url> [--save=<key>]
```

Answers the three questions that decide which lane a state is in: lines or points, how much, and what
we are required to say. This exists as its own command because the plan got the first question wrong
for Vermont, and a probe is thirty seconds.

## 2. Fetch — fill the archive

```bash
pnpm --filter @skating/bathymetry snapshot                     # every source lacking a snapshot
pnpm --filter @skating/bathymetry snapshot nh-granit-contours  # one
pnpm --filter @skating/bathymetry snapshot --refresh           # re-pull, overwriting
```

**An existing snapshot is never overwritten without `--refresh`.** Pages are stored byte-faithful and
gzipped, one file per page, zero-padded so a directory listing sorts into fetch order. A snapshot that
comes up short of the reported count warns loudly rather than reporting success.

Then mirror it: `scripts/bathymetry/mirror-r2.sh push`.
