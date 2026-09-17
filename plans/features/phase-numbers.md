# Next-gen — one phase-naming scheme: what a rename actually touches, and the traps in it

> **✅ The tree is renamed (2026-09-17, PR 2 of 3).** What remains is step 2b — `gh pr edit` over the pre-pass PRs with the banner — and it runs after that PR merges. This doc keeps the old names deliberately: it is the record of the mapping.
>
> **Scoped 2026-09-16 (after N9 merged).** Founder: the numbering has
> drifted through three schemes — pre-build docs `00–08`, roadmap phases `1–10` with `.5` splits,
> post-roadmap phases `N1–N9` with `a–h` splits — and "it's become a problem knowing what to name the
> next batch." This doc records the inventory, the scheme we lean toward, the amendments the
> inventory forced, and the order to do it in. **Nothing has been renamed.** The `next-gen-*` docs
> themselves are out of scope here and will be revisited once the scheme is settled.
>
> **Second pass, same day:** zero-padding goes everywhere (prose and scopes too, not just filenames);
> lettered eras cap at `A` and `B`, after which work is `feat-<slug>`, decided by the shape of the
> work rather than by exhausting a namespace; runtime strings get renamed too (prod has no rows yet);
> and the mechanical pass waits for `phase-n7b-corpus-lifecycle` to land — the crosswalk doesn't.
>
> **Third pass, same day:** `plans/` splits into `phases/`, `features/`, `backlog/`, `research/`
> with `00–08` and `CLAUDE_NOTES.md` at the root and the crosswalk in `plans/README.md`; workstreams
> go from letters to `§3.2` with the sigil mandatory; PR titles/bodies get rewritten via `gh pr edit`
> with a "predates the renumbering" banner on every pre-pass PR; **the commit-message rewrite is
> rejected** — it would strip the GitHub-signed merge commits.
>
> **Fresh-eyes review, same day:** two crosswalk gaps found (`Phase 0 → 00`; `7a/7b → 07-1/07-2`,
> 129 hits the table would have mis-rewritten), the "never bare" rule dropped as redundant under
> padding, two traps added (relative-link re-basing on the directory move; historical literals),
> the next-gen docs sorted into `features/` vs `backlog/`, and the externals verified clean. Then
> the crosswalk PR was cut.

---

## The two problems inside the one ask

1. **Naming the future** — what the next batch of phases is called. Urgent, and it costs one
   decision. It does **not** require touching anything that exists.
2. **Renaming the past** — making the existing docs, comments, and history read in the new scheme.
   Optional, and it splits cleanly in two:
   - the **working tree** (plans, docs, code comments): renameable, mechanically, in one PR;
   - the **record** (git history, PR titles and bodies, branch names, Convex rows, published
     artifacts): mostly immutable — but not uniformly, see "Rewriting history" below. 356 of 957
     commit messages and 458 conventional-commit scopes (`feat(n6e):` ×142, `(n7)` ×64, `(n6h)`
     ×59 …) say the old names, as do 53 of the 59 PR titles/bodies.

Because part of (2b) is permanent, **a crosswalk table is mandatory whatever else we do** — anyone
reading a PR's commit list or an admin-visible import-run row will meet an old name. Once the
crosswalk exists, the working-tree rewrite is a consistency nicety for readers and agents, not a
correctness need.

### Rewriting history — what can and can't be made consistent (2026-09-16)

Founder: *"I'd love if the history were easily traversable in the future with the phases as they
will be when people read them."* Measured against the actual repo:

| Record | Rewritable? | How | Cost |
| --- | --- | --- | --- |
| PR titles + bodies (59; 53 carry old names) | **yes** | `gh pr edit N --title --body` works on merged PRs; same substitution table; no notifications | ~1 hour, no mess; the PR *number* is the stable id |
| PR review comments (Greptile's) | no | not ours | — |
| Branch names on merged PRs (`headRefName`) | no | historical | — |
| Commit messages (356) + scopes (458) | yes, at a price | `git filter-repo --message-callback` with the same table, then force-push | see below |
| PR **commit lists** on GitHub | **no** | rendered from `refs/pull/N/head`, which a force-push never touches | — |
| Convex rows (dev only; prod has none) | leave | crosswalk | — |

**The commit rewrite is feasible, and this is the cheapest moment it will ever be**: one contributor,
`main` unprotected, no tags, no releases, no forks, prod uninitialized, and — once n7b lands —
nothing in flight. What it costs:
- all 957 SHAs change. `filter-repo` emits a commit-map, so the 73 SHA citations in `plans/`/`docs/`
  are a mechanical fix, not a real cost. Every clone/worktree must be re-pointed (`fetch` +
  `reset --hard origin/main`), so do it with nothing in flight;
- the 63 GitHub-signed merge commits lose their "Verified" badge — cosmetic;
- **the two records can't both be made consistent.** After a rewrite, `git log` says `feat(a06e):`
  while PR #47's Commits tab still says `feat(n6e):`, and its "merged commit" link points at a SHA
  that is no longer on `main` (the object survives via the pull ref). This is the one place where
  the record is truly immutable.

So: PR-level traversal can be made fully consistent; `git log`-level traversal can be, at the cost
of SHAs and badges; PR commit lists will always say the old names.

**Founder call (2026-09-16): PR-level traversal and nothing else.** Losing the GitHub-signed merge
commits settled it — no `filter-repo`, no force-push, every SHA stays. Commit messages and PR commit
lists keep the old names permanently, and the crosswalk is how they're read.

The PR pass, concretely:
- every PR numbered **at or below the rename PR** gets its title and body run through the same
  substitution table (53 of the 59 carry tokens; the other 6 are the Phase 0 scaffold PRs);
- **every** one of those PRs also gets a banner prepended to its description, whether or not its
  body changed, because its branch name and commit list can't change and a reader needs to know
  why they disagree with the title. Something like:

  > **Renumbered 2026-MM-DD.** This PR predates the phase-renumbering pass. Its title and description
  > have been rewritten to the current scheme; its branch name and commit messages have not — see
  > [`plans/README.md` → *Reading old history*](https://github.com/tatwater/skating-app/blob/main/plans/README.md#reading-old-history)
  > for the crosswalk.

  The link must point at the README on `main` (not a PR ref) and the anchor must match the heading's
  GitHub slug — check it after the README lands. The script checks for the banner's first line
  before prepending, so re-running it can't double-banner;
- PRs opened after the pass carry the new names natively and get no banner. The rename PR itself is
  written in the new scheme and is the boundary;
- `gh pr edit N --title … --body …` on merged PRs works and sends no notifications. Review comments
  (Greptile's) and `headRefName` are left as they are.

## What the inventory found (2026-09-16, `main` at `aafc975`)

Tokens counted: `Phase N6e` / `phase-N6e` style, and bare `N6e` / `N7-3` style (uppercase `N`,
word-bounded). Excludes `node_modules`, `pnpm-lock.yaml`, `_generated`.

| Where | Files | Hits | Kind | Renameable? |
| --- | --- | --- | --- | --- |
| `plans/` — 30 `phase-*` files + `07-roadmap.md` (1,907 lines) + `README.md` + `01`/`02`/`08` | 44 | ~1,000 | filenames, prose, 237 intra-plans links (12 with anchors) | yes — `git mv` + link rewrite |
| `docs/` | 12 | ~60 | prose + 67 `plans/phase-…` path links from outside `plans/` | yes |
| code comments (`.ts`/`.tsx`/`.sh`) | ~560 | ~2,300 | comments and test `describe` names only | yes — mechanical |
| runtime strings | ~25 | ~30 | `console.warn` text, admin tuning blurbs, `importRuns` names, audit `reason` strings (`"N7 campaign: …"`), the bathymetry archive's baked `--name="Skating bathymetry (N6b)"` | code yes; **rows already written keep the old text** |
| Convex data | — | — | `campaignId: 'n7-3-20260809'`, `'n6c'`; audit reasons; import-run names | **no** — leave; crosswalk |
| schema, table, index, field names | 0 | 0 | — | nothing to do (verified) |
| git: commits / scopes / branches / PR titles | 356 / 458 / 5 / 59 | — | — | **no** — crosswalk |
| Claude memory dir (`~/.claude/projects/…/memory`) | 38 of 74 | 177 | prose | yes, and must — or the next session speaks the old names |

**The headline: not one identifier that a computer reads carries a phase token.** Every hit in the
tracked tree is prose, a comment, a filename, or a link. That is what makes this tractable.

## The scheme (settled in discussion 2026-09-16)

The founder's proposal, with the amendments the inventory forced and two founder calls made on the
second pass: **zero-pad everywhere, not just filenames**, and **only two lettered eras, then
`feat-*`**.

| Era | Prefix | Phases | Notes |
| --- | --- | --- | --- |
| Pre-build docs | `00–08` | — | untouched |
| Scaffold (the roadmap) | *none* | `01 … 10` | the only era without a letter — that *is* its marker; digits sort before letters |
| Enrichment (2026-07-26 → 2026-09-16) | `A` | `A01 … A09` | today's `N` |
| Launch readiness | `B` | `B01 …` | the next batch, and **the last lettered era** |
| After that | `feat-<slug>` | — | see "When phases stop" |

**The token is `[A|B]NN[a-z]`, zero-padded to two digits, in every slot**: filenames
`phases/A06e-satellite-imagery.md`, prose `Phase A06e`, branches `phase-a06e-<slug>[-N]`, commit
scopes `feat(a06e):`. Sub-phases are a lowercase letter; the PR / campaign sequence inside a doc is
`-N` (`A06c-2`, `A07a-3`, `B01-4`). `.5` is retired: `2.5 → 02b`, `9.5 → 09b`, and their siblings are
`02a`/`09a`. Old prose "Phase 2" → `Phase 02a` mechanically — nobody ever wrote "Phase 2" to mean
2+2.5, because 2.5 was always called 2.5.

Padding in prose does two jobs. It fixes the directory listing (`phase-10` no longer sits between
`phase-1` and `phase-2`, matching the `00–08` convention already there). And **it dissolves the
collision in amendment 2 for free**: workstream refs are `A4`/`B5b`, never padded; phases are
`A04`/`B05b`. The padding *is* the disambiguator. One thing to keep an eye on: the pre-build docs are
`01-decisions`, `02-open-questions`, and prose says "(see 01)"; `Phase 01` vs doc `01` stays clear only
because the word "Phase" is always there — which is the rule anyway.

### When phases stop — `feat-*`

Two lettered eras is the cap on purpose. With padding, `A` alone has 99 slots, so `B` exists for
meaning (launch readiness), not capacity. And "B exhausted" is **not** the signal that the product is
stable — that would bake a maturity claim into a numbering scheme, and we'd either stretch `B` to
reach it or stop early and feel odd. The transition is decided by **the shape of the work**, so the
call at kickoff is mechanical:

- a **phase** — multiple workstreams, multiple PRs, mints its own `D#`s, cross-cutting;
- a **feat** — one doc, one-to-few PRs, few or no new decisions.

That gives every doc a lifecycle: `next-gen-<slug>` (backlog, unscoped) → `feat-<slug>` (scoped,
scheduled) → done. Same file, renamed as it graduates. Commit scopes become the slug
(`feat(spellings):`). Once `B` closes, everything is a feat.

### Directory layout (founder call, 2026-09-16)

```
plans/
  README.md            the folder structure, phase-vs-feat, conventions, and the old→new crosswalk
  CLAUDE_NOTES.md      the founder's private scratchpad — stays at the root, never reorganized
  00-vision.md … 08-legal-feasibility-checklist.md   the pre-build docs: the project's overview
  phases/              A06e-satellite-imagery.md — no `phase-` prefix; the directory says it
  features/            <slug>.md — scoped and scheduled feats
  backlog/             <slug>.md — unscoped ideas; today's `next-gen-*`, prefix dropped
  research/            as today
```

Inside `phases/` the listing is `01-…`, `02a-…`, …, `10-…`, `A01-…`, `A03-A04-…`, …, `B01-…` — digits
before letters, no padding wart. The graduation `backlog/x.md → features/x.md` is a `git mv`.
The move and the rename are one link rewrite, so they ride the same PR. The crosswalk goes at the
bottom of `plans/README.md` ("Reading old history"): ~25 rows, it's a convention artifact, and it's
where someone puzzled by a PR title looks first — grep finds it wherever it lives. The README's
current "where things stand" preamble and per-phase list go away in the same pass; that's
`07-roadmap.md`'s job once it's restructured.

### Workstreams — `§3.2`, plain numbers, sigil mandatory (founder call, 2026-09-16)

Today a phase doc's workstreams are letters — `Workstream E`, `### B3 — …`, `§A3`, and 258 bare
`A4`-style refs mirrored into code. They become **plain numbers with the `§` sigil always**: `§3` is
workstream 3, `§3.2` its second item, headings `### §3.2 — The read path`, "Workstream 3" where a
word is wanted. Not roman: `§` already means "section", N6e has a *Workstream 0* that roman can't
say, and `§VIII.3` is slow to read. After this the only letter+digit tokens in the repo are the
registers (`D#`/`Q#`/`L#`) and product names (`R2`, `S2`) — the collision problem is gone, not
mitigated.

Cost: ~700 hits (258 bare, 232 "Workstream X", 207 `§X`), mechanical because A=1 is uniform across
docs. Hand-check two shapes: Phase 8's "A→B→C pipeline" are *stage* names, not workstreams — leave
them; and a few bare refs like "the A3 table" (`apps/web/src/components/MapView.tsx:1288`) need a
human to say which they are. Heading slugs change, so the anchored links go through the link
checker. Roughly half a day on top of the mechanical PR.

### Amendment 1 — never close a gap, never shift a token

The proposal maps `N6h → A6g` because `N6g` (imagery research) is unbuilt and moves to `next-gen-*`.
Don't: `N6h` is the name in 59 commits and PR titles #48–#54, and an off-by-one that applies to *one*
letter is the kind of rule readers generalize wrongly (someone who learns "N6h = A06g" will infer
"N6g = A06f"). **`N6h → A06h`; `A06g` stays vacant** with a crosswalk line saying where its content
went. Gaps are free; shifts are a permanent tax. Same rule forward: a phase that gets cut keeps its
number.

### Amendment 2 — `A#`/`B#` already mean something (now mostly moot)

Single-letter-plus-digit is a crowded namespace here. `D#` is the decisions register (6,565 hits),
`Q#` open questions, `L#` legal; and **`A#`/`B#` are the workstream-section refs used inside every
phase doc and mirrored into code** — `N6c B4`, `N6e A4`, `N8 §A1`, `plans/01-decisions.md:2691`
"found by running A4 against real lakes" — 258 hits. This is why eras can't run `A, B, C, D, …`:
`Phase D6` beside decision `D6` would be a disaster, and the founder didn't want a sequence that
skips letters either. Hence the two-era cap above.

With padding, `A04` (phase) and `A4` (workstream item) can't be confused — and since workstreams
are becoming `§3.2` anyway, nothing collides. So the mechanical pass is a **token swap only**:
`(N6f)` in a comment becomes `(A06f)`, not `(Phase A06f)`. "Phase A06f" is the preferred spelling in
new prose because it reads better, not because the bare token is ambiguous. (The first draft of this
doc said "never bare"; that rule predates padding and would have meant inserting a word into ~1,700
comments for nothing.)

### Amendment 3 — the `N3-N4 | A3-B4` line is a typo

`phases/A03-A04-account-lifecycle.md` is one doc that absorbed two roadmap entries. It becomes
`phase-A03-A04-account-lifecycle.md` (`Phase A03/A04` in prose), with `A04` never used alone. Not
`A3-B4`.

### The crosswalk (draft — becomes a table in `plans/README.md`)

One line per shipped name, grep-friendly (old and new on the same line), with the PR numbers so
`git log` and GitHub read the same way. Rows are the founder's table with the amendments applied:

| Old | New | PRs | Note |
| --- | --- | --- | --- |
| 0 | 00 | #1–#6 | foundations; no phase doc, lives in `07-roadmap.md` |
| 1 | 01 | #7–#11 | |
| 2 | 02a | #12, #13, #16 | |
| 2.5 | 02b | #14 | |
| 3 – 6, 8 | 03 – 06, 08 | | |
| 7, 7a, 7b | 07, 07-1, 07-2 | #24, #25 | the scaffold era used sub-letters once, for two PRs of one doc — dash, by the rule |
| 9 | 09a | #20 | |
| 9.5 | 09b | #21 | |
| 10 | 10 | #23 | |
| N1 | A01 | #27 | |
| N2 | A02 | #28 | |
| N3 / N4 | A03 / A04 | #29, #30 | one doc |
| N5a / N5b / N5c | A05a / A05b / A05c | #31, #32, #34, #35 | |
| N6a / N6b | A06a / A06b | #33, #36, #37 | |
| N6c (-1, -2) | A06c (-1, -2) | #38, #42 | |
| N6d | A06d | #43 | |
| N6e (PR 0–3) | A06e (-0 … -3) | #44–#47 | PR 4/5 unbuilt |
| N6f | A06f | #44, #56 | |
| N6g | — (vacant) | — | never built; scoping → `next-gen-imagery-research.md` |
| N6h (PR 1–5) | A06h (-1 … -5) | #48–#51, #54 | **not** A06g |
| N7, N7-2, N7-3 | A07a, A07a-2, A07a-3 | #39, #40, #41 | |
| N7b | A07b | (unpushed branch `phase-n7b-corpus-lifecycle`) | |
| N8 (PR 1–4) | A08 (-1 … -4) | #52, #53, #55, #57 | |
| N9 (PR 1–2) | A09 (-1, -2) | #58, #59 | |

## The alternative we considered and why not

**Keep `N` for the shipped era and pick the next letter from those that sort after it** (`P`, `U`,
`W`…). Zero retroactive work — the crosswalk shrinks to "the `.5`s". It loses on three counts: the
sequence isn't legible (why P?); the letters after N are where the product names live (`R2`, `S2`,
`T`); and the enrichment era would forever be the one with the odd name. The founder's `pa/a/b`
(pre-alpha/alpha/beta) idea has the sort problem they noticed *and* bakes maturity claims into names
that outlive them — the "alpha" era is still dev-only. Neutral letters age better.

## ⚠ The traps — what a blind rename would break

1. **False positives in the token regex.** Lowercase `'n1'`/`'n2'` are test-fixture ids
   (`nhdId: 'n1'`, `view('n1', 100)`); bare `N` is a count ("at least N nights"); `n7-3-20260809` is a
   stored campaign id. Rule: uppercase `N`, word-bounded, **never inside a string literal**, ordered
   longest-token-first (`N7-3` before `N7`, `2.5` before `2`). Review the diff by category, not by file.
2. **Runtime strings that reach data — rename them (founder call).** `subAreas.ts` writes
   `reason: "N7 campaign: …"` into audit rows; `load.ts` names import runs `"N7 unified corpus — …"`;
   the bathymetry archive's metadata says `(N6b)`. Rewriting the code changes future rows only, so
   the admin UI on **dev** will show both spellings. That's acceptable because **prod Convex has never
   been initialized** — prod's rows will only ever carry the new names, since its imports run on the
   renamed code. Two carve-outs stay as they are: `campaignId: 'n7-3-20260809'` is a *key* stamped on
   body rows (only a comment references it; leave it), and the bathymetry archive's baked name fixes
   itself on the next cut, which prod needs anyway.
3. **Links and anchors — paths go through a filename map, never the token regex.** 237 intra-plans
   links, 12 with anchors, 67 path links from `docs/`, `scripts/*/README.md`, and code
   (`scripts/bathymetry/src/provenance.ts` cites `plans/phases/A06b-bathymetry-layer.md` by path).
   The directory move adds **re-basing**: 54 links from phase docs to `./01-decisions.md#…` /
   `./research/…` become `../…`, and 155 links from `00–08` + README to `./phase-*` become
   `./phases/…`. So every path is rewritten from an explicit 30-entry old→new filename map, with
   the relative prefix recomputed per source file. Heading text with a phase name changes its GitHub
   slug — including the five `01-decisions.md#d66--…-n5a` style anchors whose slug embeds the old
   phase name. There is **no link checker in CI** — write a throwaway one for this PR (resolve every
   `](./…)` and `plans/…` path; check every `#anchor` against the target's headings under GitHub's
   slug rules) and run it before and after.
3b. **Historical literals are never rewritten.** Lowercase `n6f` commit scopes and `phase-n6e-…`
   branch names cited in docs (46 hits) name things that existed under those names; the token regex
   is uppercase-only and skips anything preceded by `phase-`, and only the filename map touches
   `phase-…` slugs. (Verified: no uppercase branch-name literal exists outside a filename.) Same for
   `campaignId` values and quoted PR titles.
4. **Open branches — land `phase-n7b-corpus-lifecycle` first.** A ~600-file comment diff conflicts
   with every line another branch touched. Measured 2026-09-16: the n7b branch (worktree
   `../skating-n7b`, 5 commits, 0 behind) touches 40 files including the four heaviest token files
   (`schema.ts` 63 hits, `reports.ts` 24, `waterBodies.ts` 17, `bounties.ts` 11), and **94 of its
   added lines carry old-name tokens**. Merging it after the rename means conflicts on the
   overlapping comment hunks *and* 94 stale lines re-entering the tree. Both fixable, neither worth
   it for a branch that's ready. Step 1 below is safe alongside it (touches two files the branch
   doesn't); step 2 waits. The `us-spellings.md` sweep is the same shape of diff — do the two
   back-to-back in the same window, as **separate** PRs.
   *Durable mitigation whatever the order:* the substitution script is **idempotent and committed**
   (e.g. `scripts/rename-phases.sh`) until the last old-name branch has landed, so a straggler is
   `rebase` → run script → commit, and a stray `N6e` typed from muscle memory is a one-liner to fix.
5. **Greptile is metered.** A comment-only diff across 600 files is a review nobody needs. Either
   skip the reviewer on this PR or keep the mechanical pass in its own PR so the editorial ones stay
   reviewable.
6. **macOS case-insensitive FS.** `N→A` isn't a case-only rename, so `git mv` is safe. If any
   filename ends up differing only by case from its old name (e.g. lowercase-ing the era letter),
   use the two-step `git mv` via a temp name.
7. **Claude's memory dir.** 38 files speak the old names. Rewrite their *contents* in the same pass
   (same regex, same review); their filenames are internal ids and stay. Separately: a prior session
   wrote `memory/phases/07-operator-surface.md` into the **repo root** (tracked, commit `54ae486`)
   instead of `~/.claude/…/memory/` — `git rm` it in the mechanical PR.
8. **The next-gen docs get sorted, not renamed in place.** By the phase-vs-feat test: this doc and
   `us-spellings.md` are scoped and scheduled → `features/phase-numbers.md`,
   `features/us-spellings.md`; `next-gen-weather-shelter-index.md`, `next-gen-weather-stations.md`
   and `backlog/A06g-imagery-research.md` are unscoped → `backlog/weather-shelter-index.md`,
   `backlog/weather-stations.md`, `backlog/imagery-research.md`.
9. **Verified clean, nothing to do:** the Fly app is `skating-imagery`; no cron name, R2 key,
   snapshot file, or `vitest -t` filter carries a token; GitHub has no repo description, milestones,
   or releases, and only default labels; `package.json` descriptions are prose and get the normal
   pass. `07-roadmap.md` stays at the root (it's a pre-build doc and the living narrative); its
   `## Phase 9 — …` headings rewrite in the mechanical PR.
10. **`CLAUDE_NOTES.md` is the founder's.** The draft table there is superseded by this doc; the
   founder prunes it, not a PR.

## How to run it (three PRs, in this order)

1. **Scheme + crosswalk** — `plans/README.md` rewritten: the *target* directory layout (with a ⏳
   line saying the move lands in the next PR), the phase-vs-feat test, the conventions (token
   shape, `§3.2`, `D#`/`Q#`), and "Reading old history" — the crosswalk, whose rows link to each
   phase doc at its **current** path (the only index that links every phase doc today; the
   mechanical PR re-points the links). The README's stale "where things stand" preamble and the
   long per-phase list go. Half a day. **Safe to do now, alongside the n7b branch.** *This is the PR
   that unblocks naming the next batch (`B01`); the rest can wait.*
2. **The mechanical rename** — after n7b lands (the founder will wrap it soon, so no idempotent
   script is needed; a throwaway one is fine). In one PR: the `plans/` directory split and the
   `git mv`s; the phase-token substitution over `plans/`, `docs/`, `README.md`, code comments,
   runtime strings, and the memory dir; the workstream renumbering (`§3.2`) with its two hand-checked
   exclusions; link check before/after; full test suite (behavior must be byte-identical — only
   test *names* and log/blurb text may change). ~650 files, ~3,700 hits, ~1.5 days including the
   review by category. Back-to-back with the US-spellings sweep (which becomes `features/us-spellings.md`).
2b. **PR titles + bodies + banner** — right after (2) merges, once `plans/README.md` is on `main`
   so the banner's link resolves: the same table over every PR up to and including the rename PR
   via `gh pr edit`, plus the "predates the renumbering" banner on each. Dry-run first (print the
   before/after for three PRs of different shapes — a Phase-0 scaffold PR, an `N6h PR 5` one, and
   one with a long body of `§`/`D#` refs). One to two hours. **No commit rewrite, ever.**
3. **`07-roadmap.md` restructure** — the separate editorial job already queued in
   `CLAUDE_NOTES.md` (tight per-phase summaries, 🟢/🟡/⚪ status, deferred-and-resolved-by, infeasible
   flags; detail moves down into phase docs). 1–2 days. Done *after* (2) so it's written once, in the
   new names, and never has to think about old ones. The root `README.md` refresh follows it.

## Related

- `plans/CLAUDE_NOTES.md` — the founder's draft table this doc supersedes, plus the roadmap /
  README refactor asks that become step 3.
- `plans/features/us-spellings.md` — the other tree-wide mechanical diff; same landing window.
- `plans/README.md § Conventions` — where the rules go once decided.
