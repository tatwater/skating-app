# Planning docs

This directory is the design record for the app: the vision, the decisions (with their *why*), the
open questions, and the build sequence. Read `00`–`08` top-to-bottom the first time; after that it's
a reference. Decisions are numbered `D#`, open questions `Q#`, and both are cross-referenced
throughout.

> ⏳ **Almost the layout below.** `backlog/`, `features/`, `research/` and `phases/00-foundations.md`
> exist; the other phase docs still sit flat in this directory under their old names until the
> renumbering pass ([`features/phase-numbers.md`](./features/phase-numbers.md)) lands after
> `phase-n7b-corpus-lifecycle` merges. The crosswalk at the bottom links to them where they are today.

## Layout

```
plans/
  README.md            this file — the layout, the conventions, and the old→new crosswalk
  CLAUDE_NOTES.md      the founder's private scratchpad; not part of the record
  00-vision.md … 08-legal-feasibility-checklist.md
                       the pre-build docs: the whole project, end to end (start at 00)
  phases/              one doc per phase — 01-water-bodies.md, A06e-satellite-imagery.md, …
  features/            one doc per feat — scoped and scheduled, but not a phase
  backlog/             ideas that aren't scoped yet
  research/            investigations that fed a phase or a decision
```

The pre-build docs stay at the top level on purpose: they're the overview, and `07-roadmap.md` is
the living narrative of everything built since — status per phase, what each deferred, and what
turned out infeasible. The detail lives in the phase docs; the roadmap points at them.

## Phases and feats

Work is either a **phase** or a **feat**, and the shape of the work decides which — not its size
in weeks, and not how mature the product is:

- a **phase** has several workstreams, lands over several PRs, and mints its own decisions (`D#`);
- a **feat** is one doc, one-to-few PRs, and few or no new decisions.

A doc moves through the directories as it matures: `backlog/x.md` (an idea) → `features/x.md` (scoped
and scheduled) → done. That's a `git mv`. Phases are numbered; feats are named by slug.

### Phase names

The token is `[A|B]NN[a-z]`: an optional era letter, a two-digit zero-padded number, an optional
sub-phase letter. It's spelled the same in every slot — file `phases/A06e-satellite-imagery.md`,
prose `Phase A06e`, branch `phase-a06e-<slug>`, commit scope `feat(a06e):`.

| Era | Prefix | Range | What it was |
| --- | --- | --- | --- |
| the roadmap | *(none)* | `00` – `10` | the scaffold: every feature the product needed to exist |
| enrichment | `A` | `A01` – `A09` | data, depth, imagery, access, weather, notifications — the app knowing its lakes |
| launch readiness | `B` | `B01` – … | the current era |

Rules that fell out of the history and are worth keeping:

- **A sub-phase letter means its own doc** (`02a`, `02b`, `A06e`). A PR sequence inside one doc is a
  dash (`A06c-2`, `07-2`, `B01-4`) — `-N` is "the Nth PR of this phase", never a sub-phase.
- **Never close a gap, never shift a token.** A phase that gets cut keeps its number (`A06g` is
  vacant; its scoping moved to the backlog). A number that's in the git history is spoken for.
- **`B` is the last lettered era.** With two-digit padding, `A` alone had 99 slots, so `B` exists
  for meaning rather than capacity — and letter eras collide with the registers (`D#`, `Q#`, `L#`)
  soon after. After `B` closes, everything is a feat.

### Workstreams

Inside a phase doc, workstreams are numbered and always carry the section sigil: `§3` is workstream
three, `§3.2` its second item, headings `### §3.2 — The read path`. Prose can say "workstream 3"
where a word reads better. The sigil is mandatory — with it, a bare `A4` or `B2` can only ever be a
phase, and `D74` can only ever be a decision.

### Registers

- **`D#`** — a decision, in [`01-decisions.md`](./01-decisions.md). When something is decided it
  lives there with a rationale; other docs *reference* decisions, they don't re-argue them. If a
  decision changes, update its entry and say what changed — the *why* is the point.
- **`Q#`** — an open question, in [`02-open-questions.md`](./02-open-questions.md). When a `Q#` is
  resolved it becomes a `D#` and moves (02 keeps a pointer).
- **`L#`** — a legal / ToS / feasibility gate, in
  [`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md).

Nothing here is final code; the data model in `06` is schema-flavored pseudocode meant to be
reacted to.

## Read in this order

| # | Doc | What it covers |
|---|---|---|
| 00 | [Vision](./00-vision.md) | The problem, the product, the principles, app structure. **Start here.** |
| 01 | [Decisions log](./01-decisions.md) | ADR-style log of every decision (`D#`) and its rationale. |
| 02 | [Open questions](./02-open-questions.md) | What we're deliberately deferring (`Q#`), with current leanings. |
| 03 | [Tech stack options](./03-tech-stack-options.md) | Service/tooling menu with pros/cons; the locked default stack. |
| 04 | [Integrations](./04-integrations.md) | GPS providers, weather, email — setup + ToS watch-outs. |
| 05 | [Accounts & credentials](./05-accounts-and-credentials.md) | External accounts to register, ordered by lead time. |
| 06 | [Data model](./06-data-model.md) | Conceptual schema for every entity + vocabulary. |
| 07 | [Roadmap](./07-roadmap.md) | Every phase, its status, what it deferred, and what it ruled out. |
| 08 | [Legal & feasibility checklist](./08-legal-feasibility-checklist.md) | Register of everything deferred behind a legal / ToS / consent / feasibility gate. |

## Reading old history

Everything before the renumbering — 59 pull requests, every commit message, every branch name, the
import-run rows in the admin UI — uses the old names, and the commit history is deliberately **not**
rewritten (it would strip the signed merge commits). PR titles and descriptions get rewritten in
the renumbering pass and carry a banner pointing here; their branch names and commit lists never
change. This table is how to read them.

| Old | New | PRs | Doc today | Note |
| --- | --- | --- | --- | --- |
| 0 | 00 | #1–#6 | — | foundations; no phase doc, see the roadmap |
| 1 | 01 | #7–#11 | [phase-1-water-bodies.md](./phase-1-water-bodies.md) | |
| 2 | 02a | #12, #13, #16 | [phase-2-map-and-reports.md](./phase-2-map-and-reports.md) | |
| 2.5 | 02b | #14 | [phase-2.5-regional-expansion.md](./phase-2.5-regional-expansion.md) | |
| 3 | 03 | #15, #17 | [phase-3-community-and-safety.md](./phase-3-community-and-safety.md) | |
| 4 | 04 | #19 | [phase-4-drive-time-and-filtering.md](./phase-4-drive-time-and-filtering.md) | |
| 5 | 05 | #18 | [phase-5-newsfeed.md](./phase-5-newsfeed.md) | |
| 6 | 06 | #22 | [phase-6-bounties-and-trust.md](./phase-6-bounties-and-trust.md) | |
| 7, 7a, 7b | 07, 07-1, 07-2 | #24, #25 | [phase-7-operator-surface.md](./phase-7-operator-surface.md) | 7a/7b were two PRs of one doc → dash |
| 8 | 08 | #26 | [phase-8-native-capture.md](./phase-8-native-capture.md) | |
| 9 | 09a | #20 | [phase-9-hazards.md](./phase-9-hazards.md) | |
| 9.5 | 09b | #21 | [phase-9.5-on-ice-alerting.md](./phase-9.5-on-ice-alerting.md) | |
| 10 | 10 | #23 | [phase-10-weather.md](./phase-10-weather.md) | |
| N1 | A01 | #27 | [phase-N1-read-path-durability.md](./phase-N1-read-path-durability.md) | |
| N2 | A02 | #28 | [phase-N2-lake-editor-and-subareas.md](./phase-N2-lake-editor-and-subareas.md) | |
| N3, N4 | A03, A04 | #29, #30 | [phase-N3-N4-account-lifecycle.md](./phase-N3-N4-account-lifecycle.md) | one doc; `A04` never used alone |
| N5a | A05a | #31 | [phase-N5a-seasons.md](./phase-N5a-seasons.md) | |
| N5b | A05b | #32 | [phase-N5b-hazard-authoring.md](./phase-N5b-hazard-authoring.md) | |
| N5c | A05c | #34, #35 | [phase-N5c-hazard-memory.md](./phase-N5c-hazard-memory.md) | |
| N6a | A06a | #33 | [phase-N6a-lake-depth.md](./phase-N6a-lake-depth.md) | |
| N6b | A06b | #36, #37 | [phase-N6b-bathymetry-layer.md](./phase-N6b-bathymetry-layer.md) | |
| N6c, N6c-1, N6c-2 | A06c, A06c-1, A06c-2 | #38, #42 | [phase-N6c-expanded-lake-profiles.md](./phase-N6c-expanded-lake-profiles.md) | |
| N6d | A06d | #43 | [phase-N6d-lake-access-points.md](./phase-N6d-lake-access-points.md) | |
| N6e, "N6e PR 0–3" | A06e, A06e-0 … -3 | #44–#47 | [phase-N6e-satellite-imagery.md](./phase-N6e-satellite-imagery.md) | PR 4/5 unbuilt |
| N6f | A06f | #44, #56 | [phase-N6f-no-public-access.md](./phase-N6f-no-public-access.md) | |
| N6g | *(vacant)* | — | [phase-N6g-imagery-research.md](./phase-N6g-imagery-research.md) | never built → `backlog/imagery-research.md` |
| N6h, "N6h PR 1–5" | A06h, A06h-1 … -5 | #48–#51, #54 | [phase-N6h-weather-detail.md](./phase-N6h-weather-detail.md) | **not** A06g — gaps stay |
| N7, N7-2, N7-3 | A07a, A07a-2, A07a-3 | #39, #40, #41 | [phase-N7-unified-corpus.md](./phase-N7-unified-corpus.md) | |
| N7b | A07b | — | [phase-N7b-corpus-by-request.md](./phase-N7b-corpus-by-request.md) | branch `phase-n7b-corpus-lifecycle` |
| N8, "N8 PR 1–4" | A08, A08-1 … -4 | #52, #53, #55, #57 | [phase-N8-notification-pipeline.md](./phase-N8-notification-pipeline.md) | |
| N9, "N9 PR 1–2" | A09, A09-1, A09-2 | #58, #59 | [phase-N9-subareas-as-places.md](./phase-N9-subareas-as-places.md) | |

Workstreams were letters before the renumbering: `§A` / `Workstream A` / a bare `A3` in a code
comment all mean what is now `§1` / `§1.3`; `B4` is `§2.4`, and so on through `H` = `§8`. (Phase 8's
"A→B→C pipeline" are stage names, not workstreams, and are unchanged.)

Lowercase tokens are always literals and were never rewritten: `feat(n6e):` is the scope a commit
actually carried, `phase-n6e-satellite-imagery-3` the branch that actually existed,
`n7-3-20260809` the campaign id stamped on the rows.
