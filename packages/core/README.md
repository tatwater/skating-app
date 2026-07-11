# @skating/core

Shared, framework-agnostic domain logic for both apps (mobile + web) — pure TypeScript,
no I/O, no UI. This is where the correctness- and safety-sensitive rules live, so they
can be tested once and reused everywhere (D7/D40).

## Modules

- **`types`** — shared enums/unions mirroring the data model (visibility, roles, ice
  types, surface tags, hazard types, …).
- **`units`** — metric↔imperial conversions + imperial display formatters (D25).
- **`visibility`** — report/comment visibility resolution (D13) and default-visibility
  derivation (D41). Property-tested — a bug here can leak a private spot.
- **`hazards`** — hazard freshness lifecycle derivation (D15).
- **`weather`** — the "weather since report" reducer (D19), descriptive only (D3).
- **`geometry`** — pure geospatial primitives (D5/D36): `bboxIntersects` (viewport
  prefilter), `polygonBBox`, `pointInPolygon`, `polygonIoU` (area dedup), and
  `bufferedLineOverlap` (river dedup). Turf-backed but framework-free, so they're
  unit-tested here and reusable from a Convex query later. `polygonIoU` truncates
  coordinates first to survive the clipper's near-coincident-edge failure — the very
  near-duplicate case dedup targets.

Consumed as raw TypeScript source (no build step) via the workspace; the apps'
bundlers transpile it.

## Scripts

```bash
pnpm --filter @skating/core test         # Vitest + coverage
pnpm --filter @skating/core test:watch   # watch mode
pnpm --filter @skating/core check-types  # tsc --noEmit
```
