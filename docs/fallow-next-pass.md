# Non-app Fallow cleanup plan

**Scope:** the 15 TypeScript workspaces under `packages/` and `scripts/`, the TypeScript builders
in `exports/`, and a separate manual review of shell and Python. Keep web and mobile in the
dependency graph as consumers, but do not edit their code or triage their findings in this pass.
Fallow stays local and advisory: no CI job, hook, merge gate, or score threshold.

## Starting point

The [rollout record](./fallow-rollout.md) from PR #164 (`aa58a91b`) is the starting point:
77.8 (B), 236 clone groups touching non-app workspaces, and zero production import cycles.
Re-measure on the actual starting revision of each batch; these numbers describe the rollout,
not a gate. Get approval before merging, and do not automatically deploy anything.

## One workspace at a time

1. **Inventory.** Read the workspace manifest, tests, callers, entry points, and runbook. Capture
   the before report with the pinned CLI, normal dependencies installed, and the same configuration
   and scope planned for the after report. Capture a fresh coverage map and test timings for this
   workspace where Vitest measures coverage. Audit existing exclusions and assertions before
   writing new tests.
2. **Triage.** Review every default-mode clone group that touches the workspace. Mark each
   `consolidate`, `keep separate`, `tooling/false positive`, or `defer`, with a reason and owner.
   Review every authored non-test function above both branching thresholds, then the highest
   measured coverage-risk findings and frequently changed code. Counts alone do not decide what to
   edit. A targeted semantic clone pass is useful after the obvious clones are understood; don't
   use a repo-wide semantic scan to generate a second untriaged backlog.
3. **Refactor.** Consolidate copies of the same rule, not just similar syntax. Put the rule in the
   smallest module that already owns the concept; do not create a generic utilities package to
   reduce a count. For cross-workspace clones, agree on an owner and update both call sites in one
   reversible change. Keep differing write, failure, and rollback policies at their call sites.
   Break real import cycles. Keep generated code and framework-discovered entry points correctly
   modeled, and do not remove exports prepared for upcoming features without confirming intent.
4. **Validate and push.** Compare before/after fixture output and side effects at the boundary.
   Run the workspace tests and coverage, affected consumers' tests, type checks, lint, and the
   relevant workflow smoke check below. Rerun the same Fallow commands; summarize what moved and
   what did not. Commit and push the validated workspace slice before moving on. Keep any
   import-only sweep separate from behavioral refactoring, so either can be reverted without the
   other. Bundle related slices into a few PRs rather than one PR per workspace; don't hold
   completed slices until the entire rollout is done.

Use explicit domain words in names (`waterBodyId`, `failedBatchCount`, `readFlagTarget`, not `id`,
`n`, `handle`, or `data` when several meanings are possible). Preserve established domain terms
such as OSM and GNIS. A new contributor should be able to find where a rule lives, what it reads or
writes, and how to test it without following a chain of wrappers. Split a complex function at real
decisions or I/O boundaries, not just to make its score disappear.

### Local report recipe

Example for the pilot, run from the repo root after a frozen install using the repository's
pinned Node and pnpm versions. Repeat with the affected workspace and separate before/after
output names.

```bash
pnpm fallow list scripts/run-log --entry-points
pnpm fallow -w scripts/run-log --format json --output-file .fallow/run-log-before.json
pnpm --filter @skating/run-log test --coverage.reporter=json \
  --coverage.reportsDirectory="$PWD/.fallow/run-log-coverage"
pnpm fallow health -w scripts/run-log --coverage .fallow/run-log-coverage/coverage-final.json \
  --report-only --format json --output-file .fallow/run-log-measured-before.json
pnpm fallow health -w 'packages/*,scripts/*' --score --hotspots --report-only
pnpm fallow architecture -w 'packages/*,scripts/*' --production --cycles
```

Use `-w` from the root so sibling consumers still count. Use `--production` for the cycle
cross-check, not as the only dead-code pass: manual and test entry points still matter. Distinguish
measured coverage from estimates where Fallow cannot map statements. At each PR boundary, do the
combined non-app scan and a separate `exports/` scan, run the standard repo checks, and use
`fallow review --base <base-ref>` locally to review the diff. Track the score alongside clone
families, duplication share, cycles, complex functions, measured coverage gaps, and test time. Don't
tune thresholds to improve the number.

## Import style

Prefer standalone `import type` declarations, followed by value imports, with a blank line
between the groups. Different lines from the same source are intentional. Within each group,
let the formatter sort imports. Keep directives first and preserve side-effect import boundaries
and runtime initialization order; type-only imports are not a substitute for an intentional
side-effect import. If a binding is used at runtime and as a type, import it as a value once.

```ts
import type { ImportRecord, ImportResult } from './importRecords';

import { parseImportRecord, writeImportRecord } from './importRecords';
```

Biome 2.6.8 supports `useImportType` with `style: "separatedType"` and type-first organizer groups.
The pilot override applies only to `scripts/run-log`. It keeps bare imports unsorted; they can
split organizer groups. Check that both rules agree after formatting, and verify type checking
and the affected runtime workflow before expanding it. No repo-wide rewrite or style enforcement
change. Leave apps and generated files alone.

## Coverage and runtime sign-off

Follow [D40](../plans/01-decisions.md#d40--testing--ci-vitest-everywhere-layered-strategy): aim for
100% of testable logic, not literal coverage of generated output or uninteresting glue. Never lower
existing floors or hide uncovered logic in broad exclusions. Identify the contract or failure a
test protects: malformed input, boundaries, ordering, permission checks, privacy, retries and
idempotency, partial failures, or an invariant. For safety-sensitive math, keep property tests;
for Convex behavior, use `convex-test`. Prefer one small fixture or table of genuinely different
cases over repeated setup or duplicating a unit test end to end. Remove redundant tests only after
showing the surviving tests still protect the same risks. Compare cold test timings before and
after; don't claim a coverage improvement from Fallow's estimates.

Use small, scrubbed fixtures or documented dry runs. For writes, use a throwaway local Convex or
a local service stub; don't assume `--dry-run` is network-free. Confirm command inputs and targets
before execution. Stop and ask if real inputs, paid quota, large downloads, or any shared writes
would materially improve confidence. Compare exit behavior and relevant artifacts, not just whether
the command finished. Never publish or deploy to production during the cleanup.

| Order | Workspace or scope | Minimum workflow evidence |
| --- | --- | --- |
| 1 | `scripts/run-log` | Run logger and batching fixtures; exercise a receipt, including a failed write, against a stub or throwaway Convex. Pilot import style and the report template here. |
| 2 | `scripts/archive-io` | Download against a local HTTP fixture; verify cleanup after interruption and size mismatch, a fresh retry, and the returned SHA-256 on success. This helper discards interrupted staging and computes a hash; it does not resume or compare a published checksum. |
| 3 | `scripts/admin-areas` | Transform a boundary fixture, then load it into local Convex; check state stamping and replay. |
| 4 | `scripts/wind-climate` | Derive from a tiny archived grid fixture; check missing-cell refusal without contacting WTK. |
| 5 | `scripts/seed-destinations` | Exercise matching and seeding paths with local fixture candidates; keep writes off shared deployments. |
| 6 | `scripts/lake-depth` | Transform a small cached survey and validate provenance and local load results. |
| 7 | `scripts/bathymetry` | Build or verify a small fixture artifact with the documented geospatial tools; no R2 publishing. |
| 8 | `scripts/imagery` | Use local imagery fixtures and exercise the selected workflow's artifact contract; don't launch a remote fan-out. |
| 9 | `scripts/etl` | Use the Vermont fixture for transform and local import; use lane-specific fixtures for archive, access, merge, or landmark changes. Review one workflow at a time. |
| 10 | `packages/extraction` | Exercise the extraction pipeline with stubbed responses; verify malformed output and fallback behavior without paid model calls. |
| 11 | `packages/email` | Render HTML and text, and smoke-test the local preview if template wiring changed; don't send mail. |
| 12 | `packages/design` | Run token generation and check expected output and consumer builds; don't hand-edit generated tokens. |
| 13 | `packages/core` | Validate one domain at a time with property and unit tests; run the affected downstream suites, including app consumers when needed. |
| 14 | `packages/convex` | Use measured coverage and churn to pick a single workflow at a time. Check auth, writes, reads, and public result shapes with `convex-test`; run local deploy/codegen verification. |
| 15 | `packages/guards` | Verify representative positive and negative fixtures, the uncached task, and a cold full guard run. Keep guards running throughout, not only in this slice. |
| 16 | `scripts/lib`, `scripts/basemap`, and `exports/` | Review shell and Python manually and use syntax checks plus fixture/stub workflows; run the Fallow path scan for TypeScript export builders separately. Don't write to R2. |

Move a shared owner earlier if a confirmed clone requires it. For a large workspace, finish
one cohesive workflow at a time rather than make a single package-wide rewrite; verify each
workflow before starting the next.

## Governor and subagents

- **Governor:** owns the queue, holds the current baseline and worktree frontier, assigns paths and
  precedence for shared code, and records decisions. Ask the maintainer before changing semantics,
  public contracts, thresholds, or the smoke-test safety boundary.
- **Read-only scouts:** investigate several independent workspaces ahead of the writer. Return
  exact clone locations, whether callers share a rule, measured coverage gaps, dependency impact,
  candidate tests, and an end-to-end check. Split by workspace, not by cleanup goal; clone,
  complexity, naming, and test work overlap in the same files.
- **One active writer:** owns the workspace slice and its tests. No simultaneous changes to shared
  modules, config, lockfile, or generated files. For a cross-workspace extraction, explicitly
  reserve both call sites under the same assignment. Check for upstream drift before integration.
- **Reviewer:** independently verifies behavior, coverage value, dependency direction, import
  ordering, and reversibility. Governor integrates, reruns validation on the resulting checkout,
  and pushes only the authorized branch. No automatic merge.

Each handoff should state the revision, workspace and changed paths, findings fixed or retained,
checks actually run, timing and coverage deltas, any unverified real-input behavior, and the
commit(s) to revert. The workspace is done when the useful clones have one owner, the risky paths
are clear and tested, and remaining findings have an explicit disposition—not when the report is
empty.

## Pilot record: `scripts/run-log`

Baseline `aa58a91b`. `record` and `backfill-archives` now share one finished-receipt writer.
`record` warns after a failed receipt write and exits successfully; the backfill still fails
on a write error and never treats a partially filed receipt as complete. Archive discovery,
manifest interpretation, and receipt writing each have a separate boundary. The backfill's
existing replay check still only sees recent run history; it is not a database uniqueness rule.

| Check | Before | After |
| --- | ---: | ---: |
| Fallow check issues | 0 | 0 |
| Default clone groups | 1 | 1 |
| Health findings, estimated coverage | 4 | 1 |
| Health findings, Vitest coverage supplied | 4 | 0 |
| Vitest tests | 73 | 91 |
| Statement / branch coverage | 99.42% / 93.37% | 99.29% / 99.17% |
| Function / line coverage | 98.07% / 100% | 100% / 100% |
| Uncached workspace test command, one sample | 1.43 s | 1.25 s |

The after coverage denominator includes the two CLI entry points, receipt writer, and Convex
subprocess adapter. Only the two process entry guards remain uncovered by in-process Vitest;
both were exercised with the actual `pnpm` commands. The timing samples show comparable runtime,
not a measured speedup. Production cycle check is clean.

- **Keep separate — deployment preflight:** `dup:56ffa976` matches the opening guard in ETL
  `pruneFloor` and `backfillArchives`. Both resolve the target with `resolveDeployment`. Keep
  consent and refusal at the command boundary: prune's dry run can still call Convex; the archive
  backfill's dry run is entirely local. Revisit with the ETL owner if the broader preflight
  policies can be modeled consistently without conflating those meanings of dry run.
- **Keep separate — semantic matches:** the extra matches mostly pair unrelated record shapes or
  common optional-field patterns. OSM and NHD deliberately make different checksum claims, even
  though their provenance records have some fields in common.
- **Retain — estimated bathymetry health finding:** `bathymetryRun` went from 21 cyclomatic /
  16 cognitive to 12 / 7. The remaining estimate is not a branching-threshold violation and
  disappears when Fallow maps the fixture coverage. No threshold change or suppression.

Before/after command smoke checks used only a local subprocess stub and synthetic manifests.
Receipt traces and diagnostics matched for live and historical records and an injected finish
failure. Backfill traces and exit behavior matched for dry run, writes, non-dev refusal, and an
injected restamp failure. Real archive files and shared Convex deployments were not used.

## `scripts/archive-io`

No production refactor. No default clone groups, check issues, or production cycles. Fallow
flags `transfer` on estimated coverage only (14 cyclomatic / 12 cognitive); the finding does
not appear with measured coverage, before or after. Keeping the streaming loop and writer
cleanup together makes the interruption and close ordering visible.

11 tests, up from 9. Branch coverage rose from 93.75% to 100%; statements, lines, and functions
remain at 100%. The loopback HTTP test verifies that both an interrupted transfer and a size
mismatch leave the published archive alone and remove staging. A fresh request starts at byte
zero, publishes the full replacement, and returns its SHA-256. A separate fixture checks that
ordinary CLI errors retain their diagnostic and release the signal handlers. No source hosts
or shared storage were contacted. Vitest reported 0.75 s before and 1.28 s after in separate
runs; these are wall-clock samples, not a controlled benchmark.

## `scripts/admin-areas`: transform and load

Baseline `ea291ef8`. Admin-area and water transforms now use one OSM identity rule and one
D48 polygon-storage policy. The shared simplifier is a core subpath, not part of the app-facing
barrel. Each transform still owns its classification, derived fields, and skip handling.
The admin-area loader now separates batch execution from run finalization; its state stamping,
dev-first guard, progress cadence, failure streak, and exit policy are unchanged.

| Check | Before | After |
| --- | ---: | ---: |
| Fallow check issues | 1 | 0 |
| Default clone groups touching this workspace | 11 | 5 |
| Health findings with Vitest coverage supplied | 8 | 6 |
| Workspace tests | 31 | 39 |
| Workspace branch coverage | 90% | 95.55% |
| Workspace function / line coverage | 100% / 100% | 100% / 100% |

The coverage denominator now includes the loader. Some direct tests moved to the shared owners;
the package totals do not include them. The new core polygon module has 100% measured coverage.
Non-app production cycle check remains clean. An uncached workspace test command took 1.21 s
before and 1.69 s after in separate runs; these are single samples, not a benchmark.

- **Consolidated** the shared OSM ID and adaptive storage rules; removed the unused admin-only
  tolerance export. The boundary and water transforms still exercise how those rules are applied.
- **Keep separate for now:** The load-loop and transform error-collection matches are control flow
  around different receipts and skip policies. Water imports attach additional counters and
  identify failures by the first body in a batch; boundary imports apply a state stamp.
- **Defer to the ETL pass:** The transform CLIs share record-separator cleanup, the loaders share
  initial NDJSON framing, and canonical mutation replies have identical inserted/updated checks.
  Trace other consumers before extracting a parser; preserve input ordering, parse-failure
  boundaries, and each loader's diagnostics. Batch sizing itself already shares `batchNdjson`.
- **Verify the acquisition and region-build lane separately:** At this point six health findings
  remained, all estimates in the transform CLI, `fetchStates`, `tiger`, and `buildRegion`.
  The cached TIGER/GDAL workflow was verified separately below.

The actual transform command produced byte-identical NDJSON and matching diagnostics before and
after for a synthetic town, classification drop, and invalid boundary. The water ETL also produced
identical NDJSON and diagnostics for its checked-in Vermont fixture. The actual admin load
command wrote to throwaway loopback Convex: the first load inserted one `VT` boundary, the replay
updated that same row, and both runs filed successful receipts. No shared deployment or live
inputs were used.

### Acquisition and region artifacts

The shared archive helper now downloads refreshes beside the cached zip and renames only after
size and digest checks pass. A failed transfer or verification leaves the previous archive and
manifest in place. Local `curl` fixtures cover those failures, successful refresh, and cache
reuse. The workspace went from 39 to 47 tests; `tiger.ts` is now measured at 100% coverage and its
estimated health finding no longer appears. The five remaining health findings are estimates in
the three command entry points, not measured gaps in the verified archive helper.

Both `fetch-states` and `build-region` ran with real GDAL against cached synthetic shapefiles in
scratch. Only the size and digest pins in the scratch copy were changed to match the fixtures;
`curl` was blocked for this check. All 12 output files matched before and after, including the
five state-specific NDJSON files, the downstate mask, and the two generated app modules. No live
sources were contacted and no app files in the checkout were rewritten. The remaining
orchestration was kept intact; separating the mask builder into a new workflow is not necessary
to fix archive publication.
