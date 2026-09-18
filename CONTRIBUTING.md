# Contributing

Thanks for your interest! This project is a **working alpha on a development deployment**: both
apps run, the water body corpus is loaded, and every roadmap phase is built (see the
[README's status](./README.md#status)). Nothing is in production yet, and the next era of work —
launch readiness — is being scoped in the open. The design record under [`plans/`](./plans/) and
the explanatory docs under [`docs/`](./docs/) are as much a part of the project as the code.

## Before anything else

Please read the **[vision and product principles](./plans/00-vision.md)**. One principle
is non-negotiable in every contribution:

> **Safety-first, never authoritative.** The app never asserts that ice is safe or
> "good to go." Reports are named peers' observations at a specific time and place. No
> feature, copy change, score, decay curve or classification may present a go/no-go verdict
> or a prediction of ice safety. Decay is *confidence*, not safety, and a stale hazard never
> reads as "all clear." See [D3](./plans/01-decisions.md#d3--safety-first-non-authoritative-framing-product-defining).

A change that erodes that principle won't be merged, however well-built.

## Ways to help

- **Domain knowledge** — especially from experienced wild-ice skaters. If the app describes a
  water body you know wrongly, or a decision reads as naive about how ice behaves, open an issue.
- **Read the [docs](./docs/) and the [plans](./plans/) and open an issue** — gaps, contradictions,
  better ideas. The [decisions log](./plans/01-decisions.md) is meant to be challenged; if you think
  a `D#` is wrong, say why.
- **Build against the record** — the [roadmap](./plans/07-roadmap.md) lists every phase's
  deferred items and the [deferred register](./plans/07-roadmap.md#deferred-register) collects the
  cross-cutting ones; [`plans/backlog/`](./plans/backlog/) holds unscoped ideas. Discuss before
  starting anything larger than a fix.
- **Data** — a missing pond, a wrong outline, a boat ramp that's a private driveway. The pipelines
  under [`scripts/`](./scripts/) each have a README, and
  [`docs/water-body-data.md`](./docs/water-body-data.md) explains what we take in and refuse.

## How we work

- **Decisions are documented.** Non-trivial technical or product decisions get a `D#`
  entry in [`plans/01-decisions.md`](./plans/01-decisions.md) with a short rationale.
  If your PR makes such a decision, add or update the entry; other docs *reference* decisions,
  they don't re-argue them.
- **Phases have a doc and a roadmap entry.** Work is a *phase* (several workstreams, several PRs,
  its own decisions) or a *feat* (one doc, one-to-few PRs). Naming, workstream sigils (`§3.2`),
  and the words we use ("water body", US spellings) are in [`plans/README.md`](./plans/README.md)
  and enforced by `planConventions.test.ts` and `roadmapShape.test.ts` in `packages/core`.
- **Discuss big changes first.** For anything beyond a small fix, open an issue before a
  large PR so we can agree on direction.
- **Be kind.** See the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development

The repo is a **Turborepo + pnpm** monorepo ([D39](./plans/01-decisions.md)). Use `pnpm`
throughout — the root `devEngines` blocks npm, and `npx` fails with an unhelpful error.

```bash
pnpm install          # install workspace deps (needs the FontAwesome token — see below)
pnpm lint             # Biome — lint + format check
pnpm check-types      # strict TypeScript across every workspace
pnpm test             # Vitest across every workspace, with coverage
pnpm format           # Biome --write
```

> ⚠ **`pnpm install` needs a FontAwesome Pro token.** The icon set is FA Pro, and its
> packages come from a private registry that covers the whole `@fortawesome` scope — so the install
> fails without a seat, rather than merely falling back to free icons. Setup (one line in your
> `~/.npmrc`) is in [docs/fontawesome-pro.md](./docs/fontawesome-pro.md). If this is blocking you
> from contributing, please open an issue — it's a trade we made for the app's own design work, not
> a decision we're attached to.

### Running the apps

Both apps talk to a **Convex** deployment and a **Clerk** instance, and draw the map from
`.pmtiles` archives on Cloudflare R2. The maintainer's dev deployment is not open, so to run the
app end to end you'll need your own:

1. **Convex** — `pnpm convex-dev` from the repo root creates a dev deployment on first run and
   pushes `packages/convex/convex/` to it (`--once` pushes and exits). `convex/_generated` is
   committed; run `pnpm --filter @skating/convex codegen` after adding a `convex/` file.
2. **Clerk** — a dev instance; the publishable key goes in the app env, the secret key and the JWT
   issuer domain go on the Convex deployment (`pnpm convex-dev env set …`). Deployment env vars
   are set on the deployment, never read from `.env.local`.
3. **Env files** — copy `apps/web/.env.example` → `apps/web/.env` and
   `apps/mobile/.env.example` → `apps/mobile/.env.local`; each is commented. Tile URLs left blank
   fall back to the Protomaps demo bucket, which is dev-only and expires — building your own
   archives is [`scripts/basemap`](./scripts/basemap/README.md).
4. **Data** — a fresh deployment has no water bodies.
   [`docs/adding-a-region.md`](./docs/adding-a-region.md) is the runbook for loading one.

Then:

```bash
pnpm --filter @skating/web dev       # Vite dev server (prints its URL)
pnpm --filter @skating/mobile start  # Metro for the Expo dev client; Android emulator is the primary target
```

Mobile is Android-first; an iOS build has never been made. Device builds go through EAS
(`preview` profile, internal distribution) and are the maintainer's to cut —
[`docs/deployment-and-release.md`](./docs/deployment-and-release.md) has the mechanics, including
what merging does and does not deploy (short version: only the website).

### Data pipelines

Everything under [`scripts/`](./scripts/) is hand-run, never built with the apps, and has its own
README with prerequisites (`osmium`, GDAL, Python, `rclone`). Loads write to the Convex deployment
your `packages/convex/.env.local` points at, and a corpus-wide read can be expensive — read the
README's warnings before running a loader against a shared deployment.

### Convex MCP (optional, for AI-assisted work)

`.mcp.json` at the repo root configures the **Convex MCP server**, which lets an AI coding
assistant inspect the deployment directly — list tables, read rows, run a one-off read-only query,
and read function logs — instead of deploying a throwaway query to answer a question.

It authenticates with whatever `packages/convex/.env.local` already grants you, so it can't reach
anything you couldn't reach with the CLI, and it's configured deliberately narrowly:

- **`envGet` / `envSet` / `envRemove` are disabled** — deployment env vars hold Clerk, Strava and
  Resend secrets, and no assistant needs to read or change them. `envList` stays on for "is
  `CLERK_SECRET_KEY` set yet?" — ⚠ but it **returns values, not just names** (observed 2026-09-17),
  so treat it as a secret-reading tool and never paste its output anywhere.
- **Production is off by default** — the server refuses production deployments unless explicitly
  started with `--dangerously-enable-production-deployments`. Don't.

Nothing else in the repo depends on it; delete the file if you'd rather not run it.

### Tests

**Tests land with the feature** ([D40](./plans/01-decisions.md)). The goal is full coverage of the
logic in every workspace, relaxed only where a line genuinely isn't worth a test — say so in the PR
when that's the call. `packages/core` and `packages/convex` enforce a 90% line floor.

- **Vitest** for unit/logic across every workspace,
- **fast-check** property tests for safety-sensitive math (decay curves, hazard projection,
  dedup, geospatial containment),
- **convex-test** for backend functions — note it runs against an in-memory backend, so a green
  suite says nothing about what's on a deployment,
- end-to-end (Playwright / Maestro) is not set up yet; the phases' *Owed* lines in the roadmap
  track what still wants on-device verification.

Heavy `convex-test` and property tests should carry an explicit timeout: CI is several times slower
than a laptop and vitest's 5 s default flakes.

## Commit / PR expectations

- **One PR per phase**, sub-workstreams as separate commits (code review is metered). Keep a PR
  under ~5,000 lines unless there's a reason, and give the reason.
- Commit subjects say *what changed and why*, with the phase as a scope where there is one:
  `feat(a06e): …`, `fix(a07b): …`, `docs(roadmap): …`.
- **Before opening:** `pnpm lint && pnpm check-types && pnpm test`, then push to your dev
  deployment and actually exercise the change — CI proves it compiles, not that it works. Green CI
  (lint + type-check + tests + a throwaway Convex push that checks `convex/_generated` is current)
  is required to merge.
- **Declare every direct dependency.** The linker is hoisted, so a phantom import works locally
  and CI won't catch it.
- Describe the *why*, not just the *what*. If the PR closes a phase, its roadmap entry and phase doc
  land in the same PR.
- By contributing, you agree your contributions are licensed under the project's
  [AGPL-3.0 license](./LICENSE) (plus the [store distribution
  exception](./LICENSE-EXCEPTIONS.md)).

## Security & safety issues

- For a **security vulnerability**, please **do not open a public issue** — email the
  maintainer at desk@teaganatwater.com instead.
- For a **dangerously false ice report** in a running deployment, use the in-app
  flag/report tools (that's what they're for).
