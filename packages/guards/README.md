# `@skating/guards`

Repo-wide invariants. Nothing here is a unit test of a package — each test reads the repository
itself and fails when a document and the code it describes have drifted apart:

| Test | Holds |
| --- | --- |
| `credentialsRegister.test.ts` | every env var the backend, pipelines and both clients read is a row in `plans/05-accounts-and-credentials.md` § 2 |
| `dataModelRegister.test.ts` | every `defineTable` in `schema.ts`, and every vocabulary constant, is in the map in `plans/06-data-model.md` |
| `roadmapShape.test.ts` | `plans/07-roadmap.md` matches its own entry template, and every phase doc has an entry |
| `planConventions.test.ts` | the `§3.2` workstream convention, the `# Phase <token> — <title>` heading, and every markdown link and `#anchor` in `plans/`, `docs/`, the root `README.md` and each `scripts/*` README — resolving against *tracked* files, not what's on disk |
| `turboCache.test.ts` | the two rules below are still true |

## Why this is a package, and why its task is uncached

This package exists for one reason: **its `test` task must never be cached.**

Turbo hashes a package's own files plus its dependencies' files. These tests read `plans/`,
`docs/`, `apps/*/src`, `packages/convex/convex`, `scripts/*/src`, every `.env.example`, and — in
`planConventions` — the output of `git ls-files`. None of that is in the hash. While they lived in
`@skating/core`, which does not depend on `@skating/web`, editing `apps/web/**` or `plans/**`
could not invalidate them, so Turbo replayed their last result forever.

That cost a red CI on PR #91: a local `pnpm test` reported *167 passed, Tasks: 15 successful*
entirely from cache, while CI ran the same commit cold and failed `credentialsRegister`. The local
green was not a green. The cache is not even per-worktree — it lives in the main checkout's
`.turbo/cache`, keyed off the git common dir, so one poisoned entry is replayed to every worktree
on the machine.

`$TURBO_ROOT$/…` globs in `inputs` (Turbo ≥ 2.1) can reach the repo root and were measured as an
alternative. They were not taken: the union of what these five tests read is most of the repo, so
the cache they would preserve is nearly worthless, while the glob list is a hand-maintained copy of
what the tests happen to read today — it goes stale the moment one reads something new, and it
cannot express `git ls-files` at all. That is the same bug, one level up. `globalDependencies` was
measured too and discards ~189s of cached work across 45 tasks on any `plans/` edit, in a repo
whose plans docs change constantly.

So the guarantee is structural rather than maintained: **an uncached task always runs.** The task
runs in ~0.33s, taking an otherwise fully cached `pnpm test` from ~0.36s to ~0.68s — against the
~16s of `@skating/core#test` that a `$TURBO_ROOT$` glob would have re-run on every docs edit. So
this is both the honest answer and the faster one. See D236.

Because that third of a second is paid on *every* run, `dataModelRegister` imports core's four
vocabulary modules by path rather than through the `@skating/core` barrel: the barrel re-exports
~160 modules and pulls `@turf/*` to deliver twenty string arrays, which measured here is 3.03s for
this package against 0.33s. Reaching into `packages/core/src` is narrow and deliberate — this is
the package that is *about* the repo's layout, and it already reads `schema.ts` off disk by path —
so core's `exports` map is left alone rather than widened for a test's benefit.

Two rules keep it that way, both enforced by `turboCache.test.ts`, which is itself in the uncached
task and so can never be served a stale pass of itself:

1. `turbo.json` here keeps `"test": { "cache": false }`;
2. no test in a *cached* package reads above its own package root. A new repo-wide guard belongs
   here, next to these — not beside the code it checks.

Rule 2 is a lint over the source, not a proof: it reads a relative climb in either spelling
(`'../../..'` or `'..', '..', '..'`), but a test that escaped via `process.cwd()`, an absolute path
or a template literal would pass it. It carries floors on the workspace list and the file list, so
it cannot pass by having examined nothing — which is the failure this whole package exists to stop.

## Running them

`pnpm test` from the repo root runs them like any other package's tests, and always executes them.
`pnpm --filter @skating/guards test` runs just these.
