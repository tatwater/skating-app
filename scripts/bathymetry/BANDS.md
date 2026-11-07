# Filled depth bands — the tile contract (B03 §2)

The bathymetry archive used to hold only contour **lines**, and MapLibre cannot fill between lines, so
the skater map faked depth with a shallowest-band fill and banded lines. This step adds real band
**polygons** — the water between successive contours — as a second layer in the same `.pmtiles`
archive, so a client fills them directly.

Depth bands are data about the water, never a reading of the ice (D3, D82). Nothing here, and nothing
a client draws from it, says or implies that any depth is safe.

## The layer

| | |
| --- | --- |
| Archive | the existing bathymetry archive — same file, same URL env var (`VITE_BATHYMETRY_PMTILES_URL` / `EXPO_PUBLIC_BATHYMETRY_PMTILES_URL`) |
| `source-layer` | **`bathymetry_bands`** (`BAND_SOURCE_LAYER` in `@skating/core`). The lines stay on `bathymetry`. |
| Geometry | `MultiPolygon` (tiles carry polygons). One feature per band per body; bands are disjoint and together cover the body's water, with islands as holes. |
| Zooms | z9–z14, the same as the lines, so a lake never has lines without its fill. Overzoom past 14. |

### Attributes

| Attribute | Type | Meaning |
| --- | --- | --- |
| `bodyId` | string | The body's OSM `externalId` (Convex `_id` fallback) — **the same key the lines carry**, so the D81 filter (`contourFilter(bodyId)`) selects both layers. |
| `bandIndex` | integer 0–6 | Which of the seven ramp bands to color this with: the ramp band of `minDepthFt` (`depthBandIndex` in `@skating/core`). |
| `minDepthFt` | number | The contour depth bounding the band on its shallow side. `0` for the shore band. |
| `maxDepthFt` | number, **absent on the deepest band** | The contour depth bounding the band on its deep side. Absent means open-ended: nothing measured bounds it, so read it as "`minDepthFt` and deeper". |
| `lane` | `'surveyed'` \| `'interpolated'` | Whose lines the band was traced from — the same provenance claim the lines carry. Credit still comes from the lines (`contourCredit`). |

### Band edges

The ramp's lower edges are `[0, 5, 10, 20, 30, 45, 70]` ft (`DEPTH_BAND_EDGES_FT` in `@skating/core`):
band 0 is 0–5 ft, band 6 is 70 ft and deeper.

**A band edge lands only on a contour the lake actually has — never on one we interpolate.** Many
lakes are contoured more coarsely than the ramp: NH GRANIT publishes every 10 ft, so Mascoma has no
5 ft or 45 ft line. Each ramp edge therefore moves to the shallowest existing contour at or below it,
and a ramp band with no contour of its own is simply absent on that lake. Mascoma's bands:

| `bandIndex` | `minDepthFt` | `maxDepthFt` |
| --- | --- | --- |
| 0 | 0 | 10 |
| 2 | 10 | 20 |
| 3 | 20 | 30 |
| 4 | 30 | 50 |
| 5 | 50 | 70 |
| 6 | 70 | — |

So a legend or tooltip that wants to be exact should label a band from `minDepthFt`/`maxDepthFt`
("0–10 ft"), not from the ramp's edges ("0–5 ft"). Coloring by `bandIndex` is always safe: a band is
never colored deeper than its shallowest water.

A lake whose contours never reach 5 ft gets **no bands** (one band would say nothing); its lines still
draw. See `bands-dropped.json`.

### Client sketch

```ts
import { BAND_SOURCE_LAYER, contourFilter } from '@skating/core';

map.addLayer({
  id: 'bathymetry-bands',
  type: 'fill',
  source: CONTOUR_SOURCE_ID, // the archive the lines already mount
  'source-layer': BAND_SOURCE_LAYER,
  filter: contourFilter(bodyId),
  paint: { 'fill-color': ['match', ['get', 'bandIndex'], 0, c0, 1, c1, /* … */ 6, c6, c0] },
}, CONTOUR_LAYER_ID); // under the lines
```

## How the bands are made

`pnpm --filter @skating/bathymetry build-bands` reads the **line build's own output**
(`.scratch/build/contours.geojsonl`) and the cached join — not the archive — so the bands are traced
from exactly the lines drawn over them: same thinning, same clip, same lakes.

Per lake (`src/bandChain.ts`; the decisions are in `src/bands.ts`):

1. **A harmonic surface** (`gmt surface -T1`) through every contour vertex at its depth and the
   shoreline (islands included) at 0 ft, on a ~5 m grid (200–1,000 cells across). Tension 1 means no
   maxima or minima away from the data, so the surface **cannot invent an isoline**: an edge appears
   only between data that straddles its level, and runs along the contour at that level.
2. **Pits and shoals.** A closed ring with nothing inside it is flat to a harmonic surface. Where that
   ring sits on a band edge, the surface just outside it says which way it faces — shallower outside
   is a pit, deeper outside is a shoal — and the inside is seeded half a foot past the ring's depth
   before a second solve. A ring whose outside does not say is left alone and counted (`ambiguousRings`).
3. **`gdal_contour -p`** traces the isobands at the boundary levels (with a sentinel either side, or
   the shore and deepest bands would not be traced).
4. **Specks** under two grid cells are dropped — exterior and interior rings together, so the speck's
   area passes to the band around it and the bands still tile the lake.
5. **Clipped** to the body's polygon (`ogr2ogr -clipsrc`, `-makevalid`).
6. **Bays** (`alsoCovers`) get their parent lake's bands re-clipped, the rule the lines follow.

### Why a surface rather than stitching the lines

79% of the surveyed lane's lines arrive **open** — the agency's shallow isobath runs outside OSM's
shoreline and the line build's clip cuts it into pieces (Mascoma's 10 ft line is 20 of them).
Stitching polygons from open lines means guessing, per piece, which side is deep. The surface makes
that decision from the data around it, and handles islands, nesting and broken rings the same way.

### The checks every lake must pass (`src/bandCheck.ts`)

Run on every body before it is written. A body that fails is **dropped and named**, never published
half-right:

- **The bands tile the water** — on a 64×64 lattice over the body: ≥ 97% of water points in exactly
  one band, ≤ 0.5% in two, ≤ 0.5% of dry points (islands) in any; summed band area 97–101% of the
  body's.
- **They are in depth order** — ascending `minDepthFt` is ascending `bandIndex`, `bandIndex` matches
  the ramp, no band's floor is below the next band's ceiling.
- **They agree with their lines** — ≥ 90% of sampled contour vertices sit in a band whose range holds
  that contour's depth (either band beside it, on a boundary level). This is the check that catches
  inverted depths, which tiling alone cannot see.

Outputs: `.scratch/build/bands.geojsonl` (the features), `bands-dropped.json` (every body with no
bands, and why), `bands-check.json` (every body's measurements).

## Rebuild

```bash
pnpm --filter @skating/bathymetry build-contours   # only if the lines changed
pnpm --filter @skating/bathymetry build-bands      # [--only=<bodyId>,…] [--states=NH] [--concurrency=8]
scripts/bathymetry/tile.sh                         # -> .scratch/build/bathymetry.pmtiles (both layers)
```

Prerequisites: GMT, GDAL, tippecanoe (with `tile-join`), pmtiles — see the README.

## Upload — a NEW key every time

The public R2 URL is CDN-cached, so overwriting a key clients already hold is how a fix "doesn't
work". Always a new key; a second build the same day takes `-2`:

```bash
scripts/bathymetry/tile.sh --upload dev/bathymetry-20261107.pmtiles
```

Then point `VITE_BATHYMETRY_PMTILES_URL` / `EXPO_PUBLIC_BATHYMETRY_PMTILES_URL` (and the EAS
environment) at the new key's public URL. The archive still carries the `bathymetry` line layer
unchanged, so a client that does not yet draw bands is unaffected by the switch.

## Local file, for a dev override

The archive this was built into, before any upload:

```
<package>/.scratch/build/bathymetry.pmtiles
```

A `pmtiles://` source range-reads the file, so it must be served by something that honors HTTP
`Range` (Python's `http.server` does not). The simplest is the web app's own dev server: copy the file
into a gitignored static directory the app serves (e.g. `apps/web/public/dev-tiles/`) and set
`VITE_BATHYMETRY_PMTILES_URL=http://localhost:<port>/dev-tiles/bathymetry.pmtiles` in `apps/web/.env`.
