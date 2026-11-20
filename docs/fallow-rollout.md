# Fallow: first non-app review

This is the initial Fallow 3.43.2 review, not a CI baseline or a target count. The web and mobile apps
stay in the dependency graph so their imports count, but app findings aren't being triaged yet.

## Reproduce the reports

From the repo root, after `pnpm install --frozen-lockfile`:

```bash
pnpm fallow -w scripts/etl --format json --output-file .fallow/etl.json
pnpm fallow -w 'packages/*,scripts/*' --format json --output-file .fallow/non-app-workspaces.json
pnpm fallow exports --format json --output-file .fallow/exports.json
```

Replace `scripts/etl` with any workspace path. The JSON and cache stay in the checkout that ran the
command and are Git-ignored. `scripts/basemap` and `scripts/lib` have no JS/TS workspace; the two
workspace-discovery warnings are expected. Their shell and Python files, along with those in the
other pipelines, were syntax-checked separately, not executed.

## Results after the first cleanup

| Scope | Unused exports and cycles | Clone groups touching scope | Health findings |
| --- | ---: | ---: | ---: |
| `packages/convex` | 21 cycles | 106 | 204 |
| `packages/core` | 0 | 12 | 94 |
| `packages/design` | 0 | 0 | 6 |
| `packages/email` | 0 | 0 | 0 |
| `packages/extraction` | 0 | 0 | 7 |
| `packages/guards` | 0 | 0 | 4 |
| `scripts/admin-areas` | 1 export | 13 | 9 |
| `scripts/bathymetry` | 11 exports | 28 | 46 |
| `scripts/etl` | 42 exports | 42 | 87 |
| `scripts/imagery` | 0 | 0 | 10 |
| `scripts/lake-depth` | 1 export | 19 | 35 |
| `scripts/run-log` | 0 | 1 | 4 |
| `scripts/seed-destinations` | 0 | 8 | 10 |
| `scripts/wind-climate` | 3 exports | 5 | 6 |
| **Combined workspaces** | **58 exports, 21 cycles** | **194** | **522** |
| `exports/` (separate path-scoped run) | 0 | 0 | 5 |

The final workspace report had no unused files, unresolved imports, or dependency findings. Clone
counts don't add up across rows: a clone can touch more than one workspace, and five groups in the
combined report have an app as one of their partners. Health used estimated coverage, not Vitest
coverage data; 207 workspace findings were triggered only by the coverage-weighted score.

## What we changed and what to do next

- **Fixed:** Declared Convex's `fast-check` and GeoJSON type dependencies in the owning manifest,
  removed extraction's unused `fast-check` declaration, and trimmed 15 unused `run-log` re-exports
  without deleting their implementations. Removed the unused `bodyPoint` alias and made its live
  replacement module-local. Moved bathymetry's `//snapshot` pseudo-script into its README.
- **Modeled, not deleted:** React Email loads template defaults through its preview server. The
  `exports/` builders are hand-run. Pipeline binaries come from the host or container. Guards
  imports core vocabulary by source path but deliberately declares the workspace dependency.
  Generated design tokens are excluded only from duplication analysis, not from the import graph.
- **Investigate separately:** The [Convex undo dependency cycle](../packages/convex/convex/lib/undo.ts#L25)
  is a real source-code cycle. Break it in a focused change with the undo tests. The other 20 cycle
  reports connect test files whose broad `import.meta.glob` patterns include one another; they are
  not 20 runtime cycles. Check the Convex test module-discovery contract before narrowing those globs.
- **Defer:** Most remaining script export findings would only make live definitions private. Do that
  when touching those modules, rather than changing 58 exports at once. Use health and clone results
  to choose a target with a concrete maintenance problem, not as a refactor quota. For example,
  add coverage around the run-log CLI and archive backfill before extracting their deployment guard.

## Follow-up: runtime cycles and shared logic

- The moderation undo mutation now supplies its existing write helpers to the undo engine.
  History can still read undo eligibility, but the engine no longer imports moderation at runtime.
  `pnpm fallow architecture -w packages/convex --production --cycles` now reports zero cycles.
  The normal report still includes the 20 test-discovery cycles.
- Wind snapshot and derive now share `collectWindTargets` in `scripts/wind-climate/src/targets.ts`.
  Both must use the same fetch floor, pagination, and grid; a divergence could make derive require
  cells that snapshot never downloaded. Tests exercise the shared rule without running the loaders.
  Fallow no longer reports that clone, and the cognitive complexity of both entry points fell
  from 39 to 27.
- The same non-app score is now **75.9 (B)**, with 193 clone groups instead of 194. The score has
  no duplication penalty at this level, so count useful clone removals separately. Leave unused
  exports alone when upcoming features are likely to use them.
- For health triage, prioritize authored runtime functions above both branching thresholds, and
  test-coverage risk backed by actual coverage. In the core pilot, feeding Fallow a Vitest JSON
  coverage map reduced coverage-risk-only findings from 19 to 9; files that don't map to coverage
  can still use estimates.

## First ETL batch

- **Consolidated:** The access, trail, and classification passes now share one streaming GeoJSON
  sequence reader. Record framing and malformed JSON detection are shared; access and trails
  still count malformed records, while the classification census skips them.
- **Simplified:** Canonical body serialization now delegates geometry preparation. The OSM
  path and the merge share the minimum ring-size rule without moving it behind the OSM area
  floor. Source statistics are still measured before simplification.
- **Deferred:** The archive download loops look similar, but their checksum, cleanup, and
  publication behavior needs a separate pass. The admin-area and water-body loaders share a
  byte/count batching rule worth testing and extracting separately from their different write
  and failure policies. No payoff from centralizing log prefixes, argument parsing, or reporting
  boilerplate in this batch.
- **Remaining above both branching thresholds:** Ten command entry points still mix
  orchestration with I/O; choose one and add fixture or mocked-boundary tests before splitting
  it. Five data-rule functions also remain: `buildMasterList`, `osmLandmarkKind`, `applyCorpus`,
  `overrideGeometryForContainedBays`, and `matchLandmark`. Keep ordering explicit when breaking
  these into testable steps. Start with the landmark classifier, not a rewrite of the master list.
- With the same scope and settings, ETL went from 42 to 40 clone groups, from 87 to 86
  health findings, and from 16 to 15 non-test functions above both branching thresholds.
  The non-app score stayed at 75.9. A run with the ETL Vitest coverage map still used
  estimates for the coverage-risk-only findings, so those aren't measured test gaps.

## After syncing main at `a3d7e8f5`

With the same Fallow version, config, and workspace filters, the non-app score rose from
**75.9 to 77.3 (B)**. Clone groups rose from 191 to 238, but the duplication share in the
combined report fell from 1.25% to 1.20% as the analyzed corpus grew. Health findings rose
from 521 to 666 across 22,080 → 29,616 analyzed functions. All 27 additional non-test
functions above both branching thresholds were in Convex. ETL still has 15, including
`osmLandmarkKind` at 27 cyclomatic and 29 cognitive.

The direct undo-handler import of moderation is still gone. The production-only cycle check
now reports a different path already present on main: `admin → moderation → lib/undo →
lib/undoHandlers → lib/undoHandlersCorpus → admin`. Treat that as a separate Convex follow-up,
not part of the landmark classifier change.

## Landmark classifier

The OSM classifier now lists its rules in precedence order. Geometry is checked after the first
tag match, so a bay polygon or town boundary cannot fall through to an establishment rule.
Regression tests cover overlapping tags, geometry vetoes, and tag coercion.

`osmLandmarkKind` went from 27 to 8 cyclomatic and from 29 to 7 cognitive complexity. ETL now
has 14 non-test functions above both thresholds, down from 15. The non-app score stayed at 77.3;
no thresholds or exclusions changed.

## Role undo and canonical import batching

- The undo mutation now supplies the existing admin role writers along with the moderation
  writers. Undo still uses the same guards and side effects, and the eligibility code no longer
  imports `admin.ts` at runtime. The production-only non-app check reports zero cycles; the
  ordinary report still shows the 20 test-discovery cycles.
- The water-body and admin-area loaders now share `batchNdjson` in `@skating/run-log`. It preserves
  the 150-record and 512 KiB input budgets and the oversized-single-record behavior. Each loader
  still owns its write and failure policies. The non-app report went from 238 to 237 clone groups
  and from 77.3 to **77.8 (B)**.
- The next Convex candidate is `resolveFlagTarget` in `moderation.ts`: 32 cyclomatic, 40 cognitive,
  and 34% measured statement coverage in the local Vitest run. First pin the queue's behavior
  by target kind, including invalid or deleted IDs and the authorless water-body case. Then
  separate loading a typed target from formatting its queue summary, without adding reads.

## Moderation queue target resolution

Each supported flag kind now has a typed table lookup and a pure summary formatter. Invalid or
deleted targets still show as `(deleted)`. Attribution still takes at most one extra profile read,
and a flagged water body still has no author. Queue tests cover all eight target kinds and distinguish
a missing target from an existing target whose author is gone.

`resolveFlagTarget` went from 32 to 3 cyclomatic and from 40 to 2 cognitive complexity. The
non-app score stayed at **77.8 (B)**; clone groups fell from 237 to 236.
