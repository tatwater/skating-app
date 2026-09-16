# Gli — working notes for Claude

Map-first peer ice-reporting app for Nordic (wild) skating. The product is in `plans/00-vision.md`,
every decision is a `D#` in `plans/01-decisions.md`, and the build record is `plans/07-roadmap.md`.
This file is what has to be true in every session; it points at the record rather than repeating it.

## Invariants — every change, every phase

- **Safety-first, never authoritative (D3).** The app never says ice is safe, skateable, or "good to
  go", never predicts it, and never lets a score, decay curve or classification imply it. Reports are
  named peers' observations at a time and place. Decay is *confidence*, not safety; a stale hazard
  never reads as "all clear". Any copy, model or feature that erodes this is wrong however well built.
- **Reports are always public (D13); minors are read-only (D41).** A block hides a person, never
  their safety observations. Trust is boost-only and cosmetic (D50): nobody is penalized for
  conditions changing.
- **Privacy by default:** `homeCoord` and raw GPS are private (D11, D58's publish-is-consent), EXIF
  stripped and geotag opt-in (D42), profile privacy is the user's (D13).
- **Tests land with the feature (D40)** — Vitest for logic, `fast-check` property tests for
  safety-sensitive math, `convex-test` for functions. Metric internally, imperial on display (D25).
  Accessibility and dark mode as UI is built (D34). US spellings in all new text.

## Starting a new phase

Read, in this order: `plans/README.md` (conventions), the phase doc, its `07-roadmap.md` entry. Then:

1. **Interrogate the plan before touching code.** What's unclear, what looks wrong, what's missing,
   which of the founder's assumptions and which of yours haven't been checked against the code and
   the data? Ask — the founder would rather answer ten questions now than review a wrong build.
   Start only when confident; if the plan needs a founder call, that call comes first.
2. **Commit in whatever chunks make sense; bundle into the fewest sensible PRs.** Greptile reviews
   are metered. Keep a PR under ~5,000 lines / ~100 files unless there's a reason, and say the
   reason. Sub-workstreams are commits, not PRs, unless a review boundary genuinely wants its own.
3. **Check your own work before a PR opens:** `/code-review xhigh --fix`, `pnpm check-types`,
   the test suites, lint. The goal is one round from open to merge.
4. **Fly without check-ins — except at forks.** No progress reports. Do stop and ask at a decision
   point where the founder's input changes the build (a trade-off, a scope question, a surprise
   in the data); don't assume what they'd want. Weighing pros and cons together is welcome.
5. **The roadmap entry is part of the phase's PR.** Write it at scoping (⚪), flip it at build start
   (🟡), close it at merge (🟢), from the template at the top of `07-roadmap.md`;
   `roadmapShape.test.ts` enforces the shape. Record what the build found in the phase doc, not the
   roadmap. New decisions get a `D#`.

## Repo mechanics that bite

- **`pnpm`, never `npx`** (root `devEngines` blocks npm). Convex: `pnpm convex-dev` / `pnpm
  convex-deploy`; the package is `packages/convex`, the mobile app `apps/mobile`.
- **Push functions before running the app** — `convex dev --once`. Tests and commits don't deploy.
  `convex/_generated` is committed and must stay in sync (new `convex/` files need codegen before
  push).
- **Prod has never been initialized.** Every "shipped" means dev. Don't `convex deploy` to prod.
- **Convex indexes on optional fields aren't sparse**: `undefined` sorts first, so a bare `lte()`
  range matches every row lacking the field. Field names must be ASCII. Schema changes go
  widen → deploy → backfill → narrow.
- **Any corpus-wide read needs a bound** — pass `marginMeters` to `listedBodiesNearCoord`; the N6d
  load without it cost 105 GB and disabled the deployment. `waterBodies.centroid` is a point *on the
  shoreline*, not a centroid; use `interiorPoint` for anything that must be inside the lake.
- **Relative TS imports stay extensionless** (`moduleResolution: Bundler`). Declare every direct
  dependency (the linker is hoisted; CI won't catch a phantom).
- **The Convex MCP server** (`.mcp.json`) answers "what's in the table" questions — use
  `runOneoffQuery` / `logs` instead of deploying a throwaway query.
- **Device testing** is Android via EAS `preview` builds (standalone, not the dev client); env vars
  live in EAS environments. Clerk sign-in on dev is email-code only.
