# Contributing

Thanks for your interest! This project is in **pre-alpha** — right now it's mostly
[design documentation](./plans/), and the codebase is still being scaffolded. That's a
great time to get involved: the shape of things is still being decided in the open.

## Before anything else

Please read the **[vision and product principles](./plans/00-vision.md)**. One principle
is non-negotiable in every contribution:

> **Safety-first, never authoritative.** The app never asserts that ice is safe or
> "good to go." Reports are named peers' observations at a specific time and place. No
> feature, copy change, or model may present a go/no-go verdict or a prediction of ice
> safety. See [D3](./plans/01-decisions.md#d3--safety-first-non-authoritative-framing-product-defining).

A change that erodes that principle won't be merged, however well-built.

## Ways to help right now

- **Read the [plans](./plans/) and open an issue** — gaps, contradictions, better ideas,
  or domain knowledge (especially from experienced wild-ice skaters).
- **Discuss decisions** — the [decisions log](./plans/01-decisions.md) is meant to be
  challenged. If you think a `D#` is wrong, say why in an issue.
- **Once code lands**, help build against the [roadmap](./plans/07-roadmap.md).

## How we work

- **Decisions are documented.** Non-trivial technical or product decisions get a `D#`
  entry in [`plans/01-decisions.md`](./plans/01-decisions.md) with a short rationale.
  If your PR makes such a decision, add or update the entry.
- **Discuss big changes first.** For anything beyond a small fix, open an issue before a
  large PR so we can agree on direction.
- **Be kind.** See the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development (once the scaffold exists)

The repo will be a **Turborepo + pnpm** monorepo (see
[D39](./plans/01-decisions.md)). The intended workflow:

```bash
pnpm install          # install workspace deps
pnpm dev              # run the app(s) locally
pnpm lint             # lint
pnpm typecheck        # strict TypeScript — the first test tier
pnpm test             # Vitest across packages
```

> These commands are the *target* setup; until the scaffold is committed they may not
> all exist yet. Check back, or open an issue if you'd like to help stand them up.

### Convex MCP (optional, for AI-assisted work)

`.mcp.json` at the repo root configures the **Convex MCP server**, which lets an AI coding
assistant inspect the deployment directly — list tables, read rows, run a one-off read-only query,
and read function logs — instead of deploying a throwaway query to answer a question.

It authenticates with whatever `packages/convex/.env.local` already grants you, so it can't reach
anything you couldn't reach with the CLI, and it's configured deliberately narrowly:

- **`envGet` / `envSet` / `envRemove` are disabled** — deployment env vars hold Clerk, Strava and
  Resend secrets, and no assistant needs to read or change them. `envList` (names only, no values)
  stays on, since "is `CLERK_SECRET_KEY` set yet?" is a real question during the prod cutover.
- **Production is off by default** — the server refuses production deployments unless explicitly
  started with `--dangerously-enable-production-deployments`. Don't.

Nothing else in the repo depends on it; delete the file if you'd rather not run it.

### Tests

We aim for high coverage of both apps' **logic**, with:

- **Vitest** for unit/logic across shared packages,
- **fast-check** property tests for correctness-/safety-sensitive math (visibility
  resolution, dedup, geospatial containment),
- **convex-test** for backend functions,
- Playwright (web) / Maestro (mobile) for end-to-end flows as they stabilize.

New logic should land **with tests**. See
[D40](./plans/01-decisions.md) for the full strategy.

## Commit / PR expectations

- Keep PRs focused and describe the *why*, not just the *what*.
- Green CI (lint + typecheck + tests) is required to merge.
- By contributing, you agree your contributions are licensed under the project's
  [AGPL-3.0 license](./LICENSE) (plus the [store distribution
  exception](./LICENSE-EXCEPTIONS.md)).

## Security & safety issues

- For a **security vulnerability**, please **do not open a public issue** — email the
  maintainer at desk@teaganatwater.com instead.
- For a **dangerously false ice report** in a running deployment, use the in-app
  flag/report tools (that's what they're for).
