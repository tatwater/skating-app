# Working notes for Claude

Decisions are `D#` in `plans/01-decisions.md`; the build record is `plans/07-roadmap.md`; naming
and doc conventions are in `plans/README.md`. This file is only what can't be found by reading.

## Invariants

- **Safety-first, never authoritative (D3).** No copy, score, decay curve or classification may say
  or imply that ice is safe, skateable, or "good to go", or predict it. Decay is *confidence*, not
  safety; a stale hazard never reads as "all clear".
- **Tests land with the feature (D40).** The goal is 100% coverage, relaxed only where a line
  genuinely isn't worth a test — say so when that's the call. Vitest for logic, `fast-check` for
  safety-sensitive math, `convex-test` for functions. US spellings in all new text.

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

## Things that bite

- **`pnpm`, never `npx`** — the root `devEngines` blocks npm, and the error doesn't say so.
- **Tests and commits don't deploy.** Run `convex dev --once` before using the app against dev;
  `convex/_generated` is committed, so new `convex/` files need codegen before a push.
- **Prod has never been initialized.** Every "shipped" means dev. Don't `convex deploy` to prod.
- **A Convex index on an optional field is not sparse** — `undefined` sorts first, so a bare
  `lte()` range matches every row lacking the field. Schema changes go widen → deploy → backfill →
  narrow; field names must be ASCII.
- **Bound every corpus-wide read** — pass `marginMeters` to `listedBodiesNearCoord`; without it one
  ETL load read 105 GB and disabled the deployment.
- **Declare every direct dependency.** The linker is hoisted, so a phantom import works locally
  and CI won't catch it.
- **Device testing** is Android via EAS `preview` builds (standalone, not the dev client), with env
  vars in EAS environments. Clerk sign-in on dev is email-code only; password can never complete.
