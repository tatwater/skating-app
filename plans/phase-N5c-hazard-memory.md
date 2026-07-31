# Phase N5c — Hazard identity: one clustering primitive, two time windows

*Within a winter it answers "is this the same ridge you already marked?" Across winters it answers "is
this the ridge that forms here every year?" Same question, same function, two windows — and building it
once is the only way the two can't disagree.*

> **Status:** ✅ **Built, 2026-07-31 — both halves.** The within-season half (workstreams **A**, **B**,
> **E**, the **D53 amendment** and the `shallow_early_thaw` rename) shipped as **PR #34**. The
> cross-season half (**C**, **D**, **F**) is built on `phase-n5c-recurrence` and green across every
> suite — **unpushed, undeployed, not device-tested**, and the skater-facing advisory ships **dark**
> behind `RECURRENCE_ADVISORIES_PUBLIC = false`, which is the intended shipped state rather than an
> unfinished one. See *§15 — What the build changed about the plan*, *§16 — What the review pass
> found*, *§18 — What the cross-season half changed* and *§19 — What the second review pass found*.
> Founder asks 2026-07-27 (hazard memory) and 2026-07-30 (duplicate corroboration), merged into one
> phase by the founder call in [§4](#4-workstream-a--the-clustering-primitive-d77).
> **Depends on:** [N5a](./phase-N5a-seasons.md) — seasons as a derived first-class dimension, the
> interim promotion list, and the D62 second amendment that keeps a departed skater's hazards.
> **Touches:** `hazards`, `hazardConfirmations`, `bodyFeatures`, a new `hazardRecurrence` table, a new
> season-rollover job, the hazard draw flow on both clients, the map's hazard layer, the on-ice payload,
> `/admin/water/$id`, `/admin/features`, `/admin/tuning`, and a new `/admin/recurrence`.
> **Decisions:** D77–D80, plus a **D53 amendment** (supersession is a backlink, not a hiding
> mechanism — §8.2) and a **D53 rename** (`shallow_bay_early_thaw` → `shallow_early_thaw`). All of them
> are already recorded in [`01-decisions.md`](./01-decisions.md) (2026-07-31), so the work item that
> said "at kickoff" is done.

---

## 1. Why this phase exists

### 1.1 The seasonal reset needs cover

N5a hides last winter's hazards on July 1. That is the right default — a February ridge asserting a
position in July is a claim nobody has stood behind for five months — but it means **the first skater in
November sees a clean map where there was a ridge.** N5a said so and named the cover: promotion into
`bodyFeatures`, which no seasonal reset touches.

What N5a could build was an **interim**, and its own docstring says so
(`packages/core/src/hazardPromotion.ts:11-15`): `listPromotionCandidates` reads **one season**, and
`rankPromotionCandidates` scores on decay tier, corroboration and contradiction — every one of them a
fact about a *row*, none of them a fact about *recurrence*. An operator still has to remember, unaided,
which bay had the spring hole two winters running.

### 1.2 And duplicates are quietly breaking corroboration *this* winter

Founder observation, 2026-07-30, and checking it found it is right — with one important correction.

**Today, duplicate hazards stack.** There is no spatial dedup anywhere. `hazards.create` dedups on
exactly one thing: `idempotencyKey`, a client-minted UUID that survives offline-flush retries
(`hazards.ts:99-113`). That stops *one device* double-posting *one draft*. Two people pinning the same
ridge — or one person pinning it twice from the web — produces two rows, two overlapping halos
(`hazardsToFeatureCollection` emits one feature per hazard), two list entries, two independent confirm
loops. Opening one shows that pin's reporter and that pin's confirmers; there is no "who else marked
this" anywhere. The schema comment justifying the offline key already names the cost:
*"two overlapping footprints read as two hazards, and the confirm loop then has to retire both."*

**The correction:** splitting confirmations does **not** make hazards dissipate. There is no time-based
archival at all (N5a, correction 2). A hazard fades `fresh → aging → stale` to a deliberate opacity
**floor** it never drops below, and archives only on two independent `fully_healed`/`never_existed`
verdicts. Absence of evidence *keeps a hazard alive*, on purpose (D3).

**But the damage is real, and one part of it is worse than the original worry:**

| # | What splitting corroboration actually costs | Where |
|---|---|---|
| 1 | **The on-ice alert never escalates.** Below the confirm threshold a pin fires the soft `confirm_request` ("can you see it?"); at or above it fires `warning` ("⚠ hazard ahead"). Threshold **1** for hazards, **2** for crossings. Three people confirm a real ridge across three duplicates → nobody's phone ever warns | `hazardProximity.ts:108`, `DEFAULT_CONFIRM_THRESHOLD` |
| 2 | **A suggested crossing genuinely dies.** `PASSAGE_EXPIRY_H = 72` off `lastConfirmedAt` — D64 made passage markers the one pin that leaves the map on time alone. Splitting doesn't dim a crossing, it **deletes** it | `hazardDecay.ts:139-160` |
| 3 | **The freshness clock is per-row.** A `still_there` vote resets `lastConfirmedAt` on the pin it was cast on, so all N look staler than what the community actually knows | `hazardDecay`, `hazardLayer` opacity |
| 4 | **Retirement is N× work** — two `fully_healed` votes *per duplicate* to clear one ridge — and corroboration credit (`HAZARD_CORROBORATION_MIN_CONFIRMS = 2`) can miss every duplicate reporter although the group cleared it easily | `hazardConfirmations.ts:143` |

### 1.3 The convergence, which is why these are one phase

Founder call, 2026-07-30: **one clustering primitive, two windows.**

"Are these the same ridge?" within a winter and "is this the ridge that forms here every winter?" across
winters are the same geometric judgement with a different time bound and a different tolerance. Build it
twice and the two *will* drift into disagreeing about what "the same ridge" means — this repo has the
scar already: the hazard verdict vocabulary was written in four places and only three were updated for
D65, so a shipped verdict went untested (N5a, *What Greptile found*, item 2).

So one function in `@skating/core`, two callers, two constants.

---

## 2. The corpus problem, and the call that unblocked it

The roadmap gated hazard memory on *"~three seasons of in-app hazard rows on at least a handful of
bodies"*, because one season of recurrence is noise dressed as insight (the D3 trap).

**Today, dev holds exactly one hazard row.** One `open_water`, one body, season `2026`; zero
`bodyFeatures`. The first real skating season is `'26/'27`. On a strict reading the gate cannot fire
before roughly **2029**.

**Founder call (2026-07-30):** *build it all now, but a thin pattern is admin-only.* A "seen in 1 of 1
seasons" line never reaches a skater; it reaches the operator dashboard, so patterns can be watched
forming and the public bar set from evidence rather than from a guess.

That is what makes early building both safe and worthwhile:

- **The D3 trap is avoided by the gate, not by the delay.** The trap is showing a *skater* a
  single-winter coincidence dressed as a pattern. Until the bar clears, this engine's output is a
  **moderator's reading list**.
- **The duplicate half has no corpus gate at all.** It pays off in the *first* winter — arguably in the
  first week — which is the other reason the two halves belong in one phase.
- **Deferring costs the tuning.** Three winters of rows would accumulate with nobody looking at them as
  a series, and then in 2029 someone sets a matching radius from scratch. Building now means tuning by
  watching, which is what `/admin/tuning` is for.

The phase therefore ships **at two temperatures**:

| | Operator | Skater |
|---|---|---|
| **From day one** | every cluster, every denominator, including 1-of-1; every auto-merge | duplicate consensus, pooled corroboration, merged pins — **all of it**, because none of it is a claim about the future |
| **After the flag flips** | unchanged | cross-season advisories, for clusters clearing the tunable bar |

---

## 3. The sentence discipline (D3, and the thing to get wrong)

The cross-season half is one claim in different clothes, so the claim gets pinned down before the
machinery. *(The within-season half makes no claim beyond "these pins are the same thing", which is why
it ships public immediately.)*

**What we may say:** what was reported, how many distinct winters it was reported in, out of how many,
and where. History, with its denominator attached.

**What we may never say:** that a hazard *is* there, *will* be there, or is *likely*. *"Ridges usually
form here"* and *"there is a ridge here"* are different sentences and only one of them is ours.

Concretely, and testable:

- Every public advisory carries **both numbers** — *"3 of the last 4 winters"*, never *"most winters"*,
  never a bare *"3 winters"*. The denominator is what stops a reader inflating it.
- Copy is **past tense with a reporter**: *"skaters have reported…"*, never *"there is…"*, never
  *"expect…"*.
- An advisory is **not a hazard**: no confirm buttons, no decay, no freshness chip, no pin, no halo.
- **It never reaches on-ice alerting.** The single most important line in the phase. The proximity
  evaluator (D54 / Phase 9.5) fires *"⚠ hazard ahead"* from cached hazard rows; an advisory entering
  that path turns a statement about past winters into a live warning about ice underfoot — the exact
  inversion D3 forbids. Precedent for the enforcement already exists (`hazardProximity.ts:90` skips
  passage markers with one guarded `continue`), but advisories are excluded *more* strongly: by never
  entering the payload at all (§9.5).
- **Ranking is a queue for a human, not a probability.** The admin list may sort by a score; it may not
  print one as a percentage or a likelihood — the line N5a's `hazardPromotion` already holds.

---

## 4. Workstream A — The clustering primitive (D77)

### A1 — What counts as "the same place"

**Two hazards match when they are in the same *type family* and their *footprints* are within a
tolerance of each other.** One function, `clusterHazards(members, { matchMeters, maxSpanMeters })`, in
`@skating/core`.

**Type families.** Matching is per family, never across — a spring and a ridge in the same bay are two
facts, not one:

| Family | Hazard types | Suggests (cross-season) |
|---|---|---|
| `ridge` | `pressure_ridge`, `ice_heave` | `recurring_pressure_ridge` |
| `spring` | `spring_current` | `spring_current` |
| `gas` | `gas_hole` | `gas_hole` |
| `reef` | `reef_hole` | `reef_hole` |
| `volatile` | `open_water`, `thin_ice`, `overflow_slush`, `drain_hole`, `wind_hole`, `slush_hole`, `thawed_rotten` | `shallow_early_thaw` — **only at the raised bar** (§C7) |
| `crack` | `wet_crack`, `drilled_hole`, `shell_area` | *(nothing)* |

The first four mirror `promotionTargetFor` (`hazardPromotion.ts:45-62`), reused unchanged. `crack`
**clusters but never promotes**: two people marking the same working crack today is a duplicate worth
collapsing, even though a recurring crack is not a permanent feature of the lake. This is the first
place the two windows diverge and it is deliberate — *dedup is about identity, promotion is about
permanence.* `volatile` is the one family where recurrence *earns* a promotion target the single-season
table could never justify; the argument and the raised bar are in §C7.

`ridge_crossing` **never clusters, in either window.** It is a passage marker, not a danger (D51/D64); a
recurring *crossing* is a statement about where people walked, and merging two crossings would claim a
wider crossable span than anyone reported — the anti-conservative direction.

**Footprint distance, not centroid distance.** The roadmap's *"within ~80 m of this point"* quietly
assumes hazards are points. They are not: a `pressure_ridge` is a `LineString` with a `bufferMeters`
half-width, often spanning a bay, and two ridges overlapping along different segments can have centroids
400 m apart while sharing 300 m of geometry. So the measure is **minimum distance between footprints** —
the stored `clippedFootprint` when present, else geometry grown by `radiusMeters`/`bufferMeters`, the
same fallback ladder the render and the proximity math already use (`schema.ts:731-736`). Overlapping
footprints are distance `0`.

That makes the tolerance a **gap**, not a radius: 80 m means "these nearly touch", a far tighter claim on
a 600 m ridge than "their centres are 80 m apart".

**Single-link agglomeration with a diameter guard.** Single-link is right for extended objects —
transitive overlap along a ridge genuinely is one feature — but its failure mode is **chaining**: A near
B, B near C, C near D, and the cluster crosses the lake. A merge is rejected when it would push the
cluster's footprint span past `*_MAX_CLUSTER_SPAN_M`. Written down because a chained cluster produces
the most confidently wrong output in the system and looks fine in every tidy fixture.

**Deterministic.** Greedy agglomeration depends on visit order, so members are visited by
`firstReportedAt` then `_id`, and a property test asserts a shuffled input yields identical clusters.

### A2 — The two windows

| | **Within-season (duplicates)** | **Cross-season (recurrence)** |
|---|---|---|
| Question | is this the same ridge you already marked? | is this the ridge that forms here every winter? |
| Members | active, visible hazards in the **current** season on one body | visible hazards across `RECURRENCE_WINDOW_SEASONS` on one body |
| Tolerance | `DUPLICATE_MATCH_METERS` = **25** | `RECURRENCE_MATCH_METERS` = **80** |
| Families | all six | five — the four, plus `volatile` at §C7's raised bar |
| Computed | **at read time**, in `hazards.listForBody` | **by a job**, stored in `hazardRecurrence` |
| Public? | immediately | behind the bar (§9.3) |

**Why the tolerances differ, and in that direction.** Within a season, two pins 25 m apart are the same
lead; two pins 80 m apart may well be two different leads on the same day, and collapsing them would
under-warn. Across seasons, a ridge re-forming within 80 m *is* the same feature — the ice does not
reassemble to the metre. Tight for identity, loose for recurrence.

**Why one is derived and the other stored.** `listForBody` already collects *all* of a body's active
hazards in one bounded read (`hazards.ts:343-353`) — Phase 9's call 6, deliberately never a viewport
scan — so within-season clustering is free there and never goes stale. The cross-season read is the
opposite: `hazards` has no time index, never ages out, and `listPromotionCandidates` had to be capped
mid-review for exactly that reason. That asymmetry is the whole justification for §6's table, and it
should be stated in both files so nobody "unifies" them later.

---

## 5. Workstream B — Within-season consensus (D80)

Four layers, cheapest first. The first three are non-destructive; the fourth is destructive-looking and
is built on the one merge pattern this repo already trusts.

### B1 — Prevent: the draw-time nudge

When a skater finishes drawing a hazard whose footprint is within `DUPLICATE_MATCH_METERS` of a live
same-family hazard, the form says so before it submits:

> **There's already a pressure ridge marked here** — reported 2 days ago by Alex R.
> **[Confirm that one]**  ·  [No, this is a different hazard]

Confirm is the primary action, and it converts the duplicate into the corroboration that was being lost.
"Different hazard" proceeds unchanged, with no friction beyond one tap — a skater standing on ice
looking at something the map has wrong must never be argued with.

**This costs nothing on the server.** Both clients already hold the body's hazards from `listForBody` to
draw the map, so the check is a pure `@skating/core` call against data in memory. It works offline,
which matters: the on-ice capture path is where duplicates are most likely (two skaters, same ridge, no
signal, both flagging it).

### B2 — Pool: gate on the cluster, not the row

Every count that *decides* something reads the cluster total instead of the row:

| Gate | Today | Under this phase |
|---|---|---|
| On-ice alert escalation (`confirm_request` → `warning`) | row `confirmCount` | cluster's **distinct confirming users** |
| Passage-marker expiry / provisionality | row `lastConfirmedAt` | *unchanged* — crossings never cluster |
| Freshness (`fresh`/`aging`/`stale`) | row `lastConfirmedAt` | newest `lastConfirmedAt` across the cluster |
| Corroboration credit (`HAZARD_CORROBORATION_MIN_CONFIRMS`) | row | cluster, credited to each distinct reporter |
| Archival (2 `fully_healed`) | row | **row, deliberately** — see below |

**Distinct users, not summed counts.** One person confirming two duplicates is one witness. So pooling
reads `hazardConfirmations.by_hazard` for the members of **multi-member clusters only** — singleton
clusters, which will be the overwhelming majority, cost nothing extra.

**Archival stays per-row on purpose.** Pooling "gone" votes would let two people clearing one pin retire
a neighbouring pin nobody looked at — pooling in the *unsafe* direction. The asymmetry is the same one
D3 draws everywhere: pool the evidence that a hazard is *there*, never the evidence that it is gone.
(Auto-merge, below, is what actually reduces the N× retirement work, and it does so by making the
duplicates *one row* rather than by sharing their clearance votes.)

### B3 — Render: one consensus footprint

Overlapping same-family pins draw as **one** footprint — the union of the members' footprints — carrying
the cluster's pooled freshness. Opening it shows every reporter, every confirmation, and each member's
own date, so nothing about who said what is lost.

The union direction matters: a consensus footprint is never *smaller* than any member, so consensus
rendering can only ever warn about more area, never less.

### B4 — Auto-merge above a high bar (founder call, 2026-07-30)

Above a deliberately high confidence bar, duplicates collapse into one row without waiting for a
moderator. **Built on D36's water-body merge pattern**, which is what makes this safe enough to
automate:

- The loser is **tombstoned, not deleted** — `mergedIntoHazardId` set, mirroring `waterBodies.mergedIntoId`,
  with a hop-capped `resolveHazardSurvivor` alongside the existing `resolveSurvivor` (`lib/bodies.ts:16-25`).
- **Confirmations are never rewritten.** A confirmation is a named person's statement about a specific
  pin (D65 names them publicly); re-pointing `hazardConfirmations.hazardId` would edit that statement.
  They are read *through* the merge chain instead, and the survivor's `confirmCount` is recomputed as
  distinct users across the chain.
- **The merged-away reporter counts as a corroborating observer** — stronger evidence than a confirm
  tap, since they saw it independently and drew it.
- **The survivor is the earliest** `firstReportedAt`: it is the first sighting, and it is the date the
  cross-season record wants.
- **The rendered footprint is the union** of the chain, so a merge never shrinks warned area.
- **Reversible**: a moderator `unmerge` clears the tombstone and both pins return intact. Every
  auto-merge writes a `moderationActions` row and appears in a *Recent automatic merges* panel in admin,
  so the mechanism can be audited before it is trusted.

**The bar**, all required together:

| Condition | Constant | Why |
|---|---|---|
| Same type family | — | never merge a spring into a ridge |
| Footprints genuinely **overlap** (distance 0) — near-miss is not enough | `AUTOMERGE_REQUIRE_OVERLAP` | 25 m apart is "probably"; overlapping is "yes" |
| Overlap ratio ≥ 0.5 (IoU) | `AUTOMERGE_MIN_FOOTPRINT_IOU` | stops a lake-spanning polygon swallowing a small distinct pin it happens to contain |
| Same season | — | across the boundary is recurrence's job, not merge's |
| Not a passage marker | — | merging crossings claims a wider crossable span than anyone reported |
| Neither already merged, promoted, or moderator-hidden | — | never re-decide something a human decided |

**No time-window condition, deliberately.** A ridge marked in December and independently marked again in
February, overlapping, is the same ridge — and the February reporter is exactly the corroboration the
pin has been missing. Merging them is right, and the survivor keeps December.

**The residual risk, stated plainly:** a wrong merge costs a distinct hazard its separate identity — the
one failure here a skater cannot undo. What bounds it is that a merge can never shrink the warned
footprint (union), never pool clearance votes, and never survive a moderator noticing it. So the cost of
being wrong is *a confusing pin*, not *unwarned ice*.

---

## 6. Workstream C — Cross-season recurrence

### C1 — A season contributes at most one

The honesty rule, and not optional. Three skaters pinning the same ridge in one January is **one**
season of evidence. `seasonsObserved` is a **set**, derived per member from `seasonOf(firstReportedAt)` —
the field N5a chose for hazard season, because it is a clock nobody can move. Without this rule, one
enthusiastic week becomes "a pattern".

(B4's auto-merge reduces how often this rule has to do the work, but never replaces it: unmerged
near-misses at 30 m still need collapsing to one season.)

### C2 — What is excluded from a cluster

- `moderationStatus !== 'visible'` — a moderator judged the pin bad; it is not evidence.
- Hazards whose community verdict was **`never_existed`** — a claim the report was bogus is the opposite
  of corroboration. ⚠ **`goneCount` cannot answer this.** `schema.ts` says it counts *"'fully healed
  & safe' verdicts ONLY"*, and that comment has been **stale since D65**: `hazardLifecycle.ts:281`
  increments it for `fully_healed` **and** `never_existed`, because they pool toward one archive. So the
  job reads `hazardConfirmations` and counts `never_existed` separately, as
  `hazardConfirmations.ts:246-256` already does. Fix the comment in the same pass.
**Promoted hazards are *counted*, not excluded.** An earlier draft dropped members superseded by an
active feature on the reasoning that "there is nothing to suggest". That confuses two things: the
**suggestion queue** (where an already-promoted cluster is indeed finished) and the **record** (which
should stay complete, because it is the evidence the promotion rests on and the thing a demotion returns
to). So a promoted cluster keeps all its members, keeps accumulating new ones each winter, and simply
carries `promotedToFeatureId` and drops out of §7.2's queue. This falls out of the D53 amendment in
§8.2 — once supersession stops hiding hazards, there is nothing to exclude them *from*.

**Deliberately included:** `status: 'archived'` rows. N5a's reasoning holds — *"a ridge the community
voted healed in March is exactly the kind that comes back in December; 'it healed' is a fact about last
winter, not about this one."*

### C3 — The `hazardRecurrence` table

One row per (body, family, cluster):

| Field | Notes |
|---|---|
| `waterBodyId` | |
| `family` | `ridge` / `spring` / `gas` / `reef` / `volatile` — five, not four. `volatile` earns a row precisely so §C7's raised bar has something to be raised *about*; `crack` is the one family with no cross-season record, since a recurring working crack is not a permanent feature of a lake |
| `geometryKind`, `geometry`, `bufferMeters?`, `radiusMeters?`, `bbox` | the **representative footprint** — the medoid member, carried across whole so a promoted cluster keeps a real ridge's shape rather than a synthesised average |
| `memberHazardIds` | every contributing hazard (survivors only — merged tombstones are represented by their survivor) |
| `seasonsObserved` | `Season[]`, ascending, **deduped** |
| `windowSeasons` | the denominator |
| `firstReportedDayOfSeasonP25` / `…P75` | the timing window (§C5), days since July 1 |
| `distinctAuthorCount` | operator-visible; see open question 2 |
| `suggestedFeatureType` | from the family table |
| `priority` | the ranking score (§C4) |
| `subAreaId?`, `subAreaName?` | from the medoid (N2/D60) — the place phrase |
| `publiclyVisible` | **stored, not derived** — see below |
| `computedAt`, `computedForSeason` | provenance |
| `suppressedAt?`, `suppressedByUserId?`, `suppressReason?` | §7.3 |
| `promotedToFeatureId?` | set when promoted (§8.2) |

Indexes: `by_water_body`, `by_computed_season_and_priority` (the ranked cross-lake queue),
`by_water_body_public` = `['waterBodyId', 'publiclyVisible']`.

> `publiclyVisible` is stored precisely because the alternative ships 1-of-1 clusters over the wire and
> asks the client not to render them. The founder call was that a thin pattern is admin-only; a
> client-side filter is "admin-only if you don't open the network tab".

### C4 — The job

A `recomputeRecurrence` staged job on the established self-continuing pattern (`lib/contentPurge`,
`photoReconcile`), scheduled at the **season rollover** — early July, which D63 chose because nobody is
looking. ⚠ Note for the build: `crons.ts` uses only `crons.interval` today, so this is the repo's first
`crons.cron` expression rather than a copy of an existing line — plus a **"recompute now"** button per body, because an operator who has just merged two lakes
or hidden three bogus pins should not wait a year.

1. **Build the work queue.** Page `hazards` (a new `by_first_reported` index earns its keep here, and for
   the season-scoped reads N5a currently filters in memory) and collect distinct `waterBodyId`s into a
   scratch queue. There is no "bodies with hazards" index, and adding a counter to `waterBodies` would be
   a write-path change for a once-a-year read.
2. **Process one body per call, fully — never capped.** This is the pass whose whole job is completeness;
   a cap here is the `listPromotionCandidates` finding one level up. Continue on a cursor rather than
   truncate.
3. **Diff, don't replace.** Preserve `suppressedAt` and `promotedToFeatureId` by matching new clusters to
   existing rows on **member overlap** (Jaccard > 0.5), not identity. A cluster that grew by one member
   is the same cluster. Unmatched old rows are deleted unless promoted or suppressed, in which case they
   are kept and marked stale.
4. **Take a lease.** One per body, refreshed per call, released at completion — the lesson Greptile
   taught this repo twice on PR #31: a marker written at schedule time is a lie about completion, and an
   unmarked capped account is a permanent retry.

**Idempotence is a test.** Two runs must produce byte-identical rows apart from `computedAt`.

### C5 — Ranking, and what happens to N5a's

`rankPromotionCandidates` is **kept, not replaced**. On a lake with one season of hazards it is the only
thing there is, and it will be for most lakes for years. Recurrence, where it exists, outranks it; the
per-lake card renders both (§7.1).

The recurrence score, in weight order:

1. **Seasons observed against the window** — `|seasonsObserved| / windowSeasons`. The only input about
   recurrence rather than about a row. Dominant by design.
2. **Decay tier**, as N5a has it: the only input about physics.
3. **Recency** — a cluster last seen in `'26/'27` is weaker than one seen last winter. Lakes change
   (a dredged channel, a new culvert), and a pattern that stopped is evidence too. *(No constant of its
   own in §7.4: the decay is a function of `seasonsObserved`'s newest entry against the current season,
   so `RECURRENCE_WINDOW_SEASONS` already bounds it.)*
4. **Corroboration**, capped, counted **per season** rather than across members, so one enthusiastic
   winter cannot outweigh a quiet recurring one.
5. **Contradiction**, subtracted: `fully_healed` mildly (it healed *that* winter), `never_existed`
   heavily.

Reuses `CORROBORATION_CAP` and `TIER_WEIGHT` so the two rankings cannot disagree about what a tier means.
Pure, property-tested — this is where a sign error is invisible and consequential.

### C6 — The timing window

*"Always between late December and February"* is the sentence the founder ask named, and the one most
easily overclaimed. Computed as the **25th–75th percentile of members' day-of-season**, an interquartile
range so one anomalous November sighting doesn't stretch it across the winter. Rendered:

- **Widened to whole half-months**, never weeks: *"late December to February"*, never *"Dec 27 – Feb 8"*.
  A narrow window implies the rest of the season is clear, which is a claim we do not have.
- **Never narrower than about three weeks**, however tight the data.
- **Only at the same bar as the advisory itself** — founder call, 2026-07-30. One constant governs both,
  so raising it makes both claims more conservative together.

### C7 — The `shallow_early_thaw` exception (founder call, 2026-07-30)

**Recurring thin ice / open water / thawed ice may propose a permanent feature — but only this family
has to clear a raised bar.**

The argument for including it is the strongest case in the phase for why recurrence is worth building at
all. A single winter's thin patch is weather: N5a scored tier-A types at **zero** promotability and was
right to. But a spot that goes out early *every* March is not weather — it is a **permanent property of
the lake bed**: shallow water over a sandbar, a reef, a delta, the lee of an island. D53 already names
the type, and today it is **unreachable from any hazard**, which is exactly the gap recurrence closes.
Recurrence is the evidence that distinguishes *"a thin patch happened here"* from *"this spot thaws
first, every year"* — a distinction one season simply cannot make.

**The rename** (founder call): `shallow_bay_early_thaw` → **`shallow_early_thaw`**. There is no guarantee
the spot is a bay — it may be an island's lee, a sandbar, a reef, a shallow delta — and the old name
narrows the type to one of its cases. **This rename is free today and will not be later:** dev holds
**zero** `bodyFeatures` rows, so it is a pure find-and-replace with no migration. It touches
`lib/enums.ts:144`, `lib/depth.ts:32`, `HazardModeratorControls.tsx:29`, `hazardWeather.test.ts`, and
comments in `lakeDepth.ts`, `hazardWeatherDecay.ts` and `schema.ts:371`. Doing it in this phase rather
than later is the whole reason to do it at all.

**The raised bar**, all required:

| Condition | Why |
|---|---|
| **3 seasons minimum**, regardless of `RECURRENCE_PUBLIC_MIN_SEASONS` | volatile types are volatile; two coincidences in a row is a plausible accident in a way two ridges are not |
| **Depth must not contradict it**, where depth exists | N6a gave every body a depth with provenance (D68) and `SHALLOW_MAX_DEPTH_M`/`SHALLOW_MEAN_DEPTH_M` already encode "shallow" (D69). A recurring thin-ice cluster on a body the data says is deep is a signal about *that spot*, not the lake — suggest it, but say the depth disagrees |
| **Never auto-suggested where depth positively contradicts** and the depth is measured rather than modelled | D68's provenance ladder exists precisely so a claim can be weighted by what it was read off |
| Suggestion copy names the mechanism | *"this spot has been reported thin in 3 of the last 4 winters — shallow water goes out from the bottom first"*, so the moderator is judging a physical claim, not a count |

> **A pleasing loop worth noting.** N6a's write-up records that `shallow_early_thaw` is a manual flag
> nobody had a path to set, and that N6a's depth data *"does not retire it"*. This is the other half:
> recurrence is how the flag gets *proposed* from observation, and depth is how the proposal gets
> checked. Neither alone was enough.

---

## 7. Workstream D — The operator surfaces

### 7.1 The per-lake card, upgraded

`/admin/water/$id`'s *"Before first ice — recurring hazards"* card becomes two sections:

- **Recurring** (new, from `hazardRecurrence`): each cluster with its denominator (*"seen in 2 of the
  last 3 winters"*), its seasons, its timing window, its distinct-author count, its place phrase, links
  to every member, and **Promote** / **Suppress**.
- **Last season, single sighting** (the existing `listPromotionCandidates` list, unchanged): last
  winter's hazards that have somewhere to be promoted *to* but no history behind them yet.

N5a's framing stays — **this is a safety pass, not tidying up** — and the new section adds the honest
half: *nothing here is a prediction; it is what was reported, and how often.* The card states its own
provenance (*"computed 2 July 2029 for the `'29/'30` season"*) with the recompute button beside it: a
stale answer that looks live is the failure mode of every precomputed surface.

### 7.2 `/admin/recurrence` — the cross-lake pre-first-ice queue

Every cluster across every body, ranked, read off `by_computed_season_and_priority`, paginated —
**bounded by construction**, since it reads the precomputed table and never touches `hazards` or
`waterBodies` in bulk (the Phase 7b rule). Filters: family, minimum seasons, not-yet-promoted,
not-suppressed, region. This is where an operator spends an hour in October and covers the whole corpus,
which is the difference between the feature existing and the feature working.

Same page carries the **Recent automatic merges** panel (§B4), with one-click unmerge.

### 7.3 Suppression, with a reason

A moderator can suppress a cluster: it stops being suggested and stops being publicly advisable,
permanently, across recomputes — for three pins in one cove across three winters that are three people
misreading the same shadow. Writes a `moderationActions` row (new `suppress_recurrence` /
`unsuppress_recurrence`) with a required reason. Reversible; never a delete.

### 7.4 `/admin/tuning` gets the constants

Per the settled Phase 7 posture — *constants live in code, the dashboard makes their effect legible, an
edit is a redeploy* — "tunable" means a **documented exported constant rendered read-only** in a new
"Hazard memory" section:

| Constant | Default | Decides |
|---|---|---|
| `DUPLICATE_MATCH_METERS` | `25` | when two pins this winter are the same hazard |
| `DUPLICATE_MAX_CLUSTER_SPAN_M` | `150` | the chaining guard, within-season |
| `AUTOMERGE_MIN_FOOTPRINT_IOU` | `0.5` | the auto-merge confidence bar |
| `AUTOMERGE_REQUIRE_OVERLAP` | `true` | near-miss never auto-merges |
| `RECURRENCE_MATCH_METERS` | `80` | when two winters' hazards are the same feature |
| `RECURRENCE_MAX_CLUSTER_SPAN_M` | `400` | the chaining guard, cross-season |
| `RECURRENCE_WINDOW_SEASONS` | `4` | the denominator |
| `RECURRENCE_PUBLIC_MIN_SEASONS` | `2` | **the public bar** — start at 2 of the last 4, raise to 3 if noisy. Also gates the timing window |
| `RECURRENCE_ADVISORIES_PUBLIC` | `false` | the master switch |

Two charts earn their place beside them: **clusters by seasons-observed** (so "how many 2-of-4s go public
if I flip this" is a number, not a guess) and **auto-merges per week with unmerge rate** (the honest test
of whether the bar is set right — a rising unmerge rate means it is too low). Both from the
`metricSnapshots` rollup pattern.

> There is no feature-flag system in this repo and this phase does not invent one. Two constants and a
> redeploy is the mechanism, matching every other threshold in the app.

---

## 8. Workstream E — Manual authoring (D79)

Founder call, 2026-07-30: *"also allow admins to promote their own manually."*

**A bigger gap than it sounds.** `bodyFeatures.create` exists (`bodyFeatures.ts:66`) and has **no UI
anywhere** — `/admin/features` is list-and-demote only (`admin.features.tsx:20-54`). Today the only way
to hand-create a permanent feature is the Convex dashboard or the CLI, so four of the nine
`BODY_FEATURE_TYPES` — `constriction`, `bridge_narrows`, `delta`, `shallow_early_thaw` — are
**unreachable in the product**: no hazard promotes into them and no form creates them.

### 8.1 Draw a body feature by hand

On `/admin/water/$id`, on the lake's own map: pick from all nine types, draw the geometry, add a note,
give a reason (already required), save. Reuses **N5b's web authoring** — terra-draw, the same
point/line/polygon primitives hazards use — which is why it lands here rather than as its own phase. Web
only: `/admin` is a web tree, and N5b established terra-draw has no React Native adapter.

This is also the answer to *"what covers the first three winters"*: an operator who **knows** a lake has
a spring at the outlet needn't wait for the corpus to prove it. The engine is for the lakes nobody on the
team skates.

### 8.2 Promotion stops hiding hazards — the D53 amendment

**Founder call, 2026-07-30, and it goes further than the fix I had proposed.**

> *A hazard from previous seasons that has been promoted should still be visible as a reported hazard in
> all years in which it was reported. A recurring feature is a pattern, not a real marker — so even in
> seasons after it's been promoted, users will still report it.*

That is the right seam, and it renames the concept: **a `bodyFeature` is a standing statement about the
lake; a hazard is a sighting by a person on a date.** Promotion adds the first. It must not delete the
second — in any season, past or future.

Today it does. `hazards.listForBody` filters out anything with `promotedToFeatureId` set
(`hazards.ts:363`), across **every** season, and `isUserVisibleHazard` (`hazards.ts:457`) additionally
makes a promoted hazard unreachable by permalink and unconfirmable. So a promotion today silently
rewrites February 2027 as a month in which nobody reported a ridge. Under one-hazard promotion that was
a small distortion; under cluster promotion it would erase the entire evidence trail the advisory rests
on, one click after an operator agreed it was real.

**The amendment: `promotedToFeatureId` becomes a pure backlink.** It records provenance and nothing
else. It stops hiding, stops blocking permalinks, and stops blocking confirmation.

What that buys, beyond honest history:

- **New sightings keep arriving and keep counting.** A skater who marks the ridge this winter is not
  told it's already known — they file a hazard like any other, it renders like any other, and it feeds
  next July's recurrence pass. A promoted cluster therefore *keeps growing*, which is what makes the
  denominator go on meaning something after promotion.
- **Confirmation still works on the sighting.** Confirming *"the ridge is here right now"* is a
  different statement from *"ridges form here"*, and only the first can be confirmed.
- **The two never race.** After a season boundary, last winter's sighting is hidden by the **season**
  axis and the feature remains — which is the desired end state, reached by the mechanism N5a already
  built rather than by a second one.

**What replaces the hiding.** Nothing needs to: features and hazards are already separate map sources
(`body-features` and `hazards`), with D53's distinct "known seasonal hazard" styling on the former. The
only work is in the drawer, where a hazard inside a promoted cluster's footprint carries one line —
*"this spot is also marked as a recurring feature"* — so the two reads as one story rather than as a
duplicate warning. Double-rendering is confined to the season of promotion in any case, since promotion
happens in the pre-first-ice pass, when last season's sightings are already season-hidden.

So `promoteFromRecurrence`:

- creates the feature from the cluster's representative footprint;
- sets `promotedToFeatureId` on every member **as a backlink**, hiding nothing;
- sets `hazardRecurrence.promotedToFeatureId` so the cluster leaves the suggestion queue but keeps
  accumulating members;
- keeps `promotedFromHazardId` on the medoid so `demote` still has a source, extended to clear the
  backlink from every member it set.

> ⚠ **This is a behaviour change to shipped code, and the reviewer's diff is every reader of
> `promotedToFeatureId`** — `listForBody`, `isUserVisibleHazard`, `listPromotionCandidates`, and the
> confirm path. That is precisely the pattern N5a's own review pass named: *"the diff to review after
> widening a value is every existing reader of it."* Here the value is being **narrowed** in meaning,
> which is the same hazard from the other direction. `listPromotionCandidates` is the one reader that
> should keep filtering on it — an already-promoted hazard is genuinely finished as a *suggestion*.

---

## 9. Workstream F — The skater-facing advisory

### 9.1 Where it lives

**The lake drawer / lake page, both clients** (`WaterBodyDetail.tsx`), with the season empty state
(`SeasonEmptyState`), above the hazard list. Nowhere else — not the map, the feed, notifications, the
recommended strip, or search. The map is where a mark means *someone reported this*, and an advisory has
no reporter this season.

### 9.2 What it says

Templates in `@skating/core` so both clients and the tests read one source:

> **Ice history.** Skaters have reported a pressure ridge near The Narrows in **3 of the last 4
> winters**, first seen between late December and February.
> *This is what was reported in past seasons — not a report of conditions now. Nothing has been reported
> here yet this winter.*

Place phrase from the medoid's `subAreaName` (N2/D60) when present, **omitted entirely** when absent — no
invented geography. Type from `HAZARD_TYPE_LABELS`. Timing clause only at the bar. The second paragraph
is not decoration; it is the D3 line, asserted in tests.

### 9.3 When it shows, and when it yields

- Only when `RECURRENCE_ADVISORIES_PUBLIC` is on **and** `|seasonsObserved| >=
  RECURRENCE_PUBLIC_MIN_SEASONS` **and** the cluster is neither suppressed nor already promoted (a
  promoted cluster is a body feature rendering permanently on the map — the advisory would be a second,
  weaker voice saying the same thing).
- **It yields to live information.** If a hazard has been reported this season inside the cluster
  footprint, the advisory hides for that cluster: there is a pin, with a date and a reporter and a
  confirm loop, and it is better than history in every respect.
- Otherwise it stays all season, below live hazards. It does not decay — it makes no claim about now — and
  is recomputed once a year.

### 9.4 The explicit no-list

An advisory **never**: enters the on-ice payload or the proximity evaluator; generates a notification,
bounty or feed row; feeds `displayScore`/`minVisibleZoom` (D49 — prominence reflects activity, and
history is not activity); affects trust, points or the bounty gate; or can be confirmed, disputed,
thumbed or flagged. *(Feedback goes through "report a hazard", which produces better data than a
thumbs-down on a statistic. Revisit if operators find they need the signal.)*

### 9.5 Offline

⚠ **Corrected 2026-07-31, during the build.** This section described a cache that does not exist.
`bodyCache.ts` stores water-body *reference* data only — name, states, polygon, centroid, area. There is
no cached hazard array to keep an advisory out of. Hazards reach the on-ice evaluator from a **live
`hazards.listForBody` subscription**, held in module state by `onIceMode.ts` and fed by `HazardBanner`,
which is served from the Convex client's own cache when there is no signal.

Two consequences, one better than the plan and one worse:

- **The structural exclusion is *stronger* than described.** An advisory comes from a different query
  (`hazardRecurrence.listForBody`) that the on-ice path never subscribes to at all. `onIce.ts` cannot
  see it by accident because it never asks for it — no shared array, no adjacent field, nothing to get
  wrong. That is a better guarantee than "a separate field in the same row".
- **"Rides the offline cache" is not true today, for advisories or for hazards.** Neither is durably
  cached; both depend on the Convex client cache. Matching hazards' behaviour is the consistent choice
  and needs no new SQLite table, but it should be *said* rather than assumed, and a durable per-body
  hazard cache is a real (unbuilt) thing if the on-ice path is ever to survive a cold start with no
  signal.

---

## 10. What the code says (findings that shaped this plan)

Checked in the repo on 2026-07-30:

1. **No spatial dedup exists.** `idempotencyKey` is per-device retry protection only (`hazards.ts:99-113`).
2. **Duplicates split every gate that matters**, but do **not** cause dissipation — there is no
   time-based archival, and the opacity floor is deliberate (D3). The exception is `ridge_crossing`,
   which expires at `PASSAGE_EXPIRY_H = 72` off `lastConfirmedAt` (D64) — the one place vote-splitting
   deletes rather than dims.
3. **`hazards` has no time index.** `by_water_body` is creation-ordered; N5a filters season in memory
   (`hazards.ts:355-357`) — correct for a body-bounded read, insufficient for a corpus-wide job.
4. **`listPromotionCandidates` caps at 500 rows in creation order** and logs when it bites
   (`hazards.ts:417-426`). Fine for one season; wrong as a multi-season basis.
5. **`goneCount` pools `never_existed` with `fully_healed`** (`hazardLifecycle.ts:281`) while
   `schema.ts` still says otherwise. Stale comment, real consequence for recurrence.
6. **`promotionTargetFor` maps 5 hazard types to 4 feature types**, leaving 4 of 9 `BODY_FEATURE_TYPES`
   unreachable. §C7 reaches one of them (`shallow_early_thaw`) from recurrence; §8.1 reaches the rest by
   hand.
7. **`bodyFeatures.create` has no UI** → §8.1 is a build item, not a wiring item.
8. **Supersession hides across all seasons and blocks permalinks + confirmation**
   (`hazards.ts:363`, `:457`) → the D53 amendment in §8.2.
9. **`resolveSurvivor` (`lib/bodies.ts:16-25`) is the merge pattern to copy** — tombstone plus hop-capped
   chain resolution, already proven on `waterBodies`.
10. **A body merge (D36) reassigns hazards to the survivor** (`waterBodies.ts:802`) → a merge must enqueue
    both bodies for recompute, or last year's clusters sit on a tombstoned body.
11. **D62's second amendment keeps a departed skater's hazards, anonymised** — the constraint the roadmap
    flagged is genuinely closed. Consequence: member `description`s may be blank; label that
    ("description removed"), or an operator reads the gap as a data bug.
12. **N5a's clock-pinning lesson applies directly.** A January fixture is in this season for half the
    year — every test here pins `now`, per the convention `accountDeletion.test.ts` documents.

---

## 11. Work breakdown

1. **Plans** — this doc; D77–D80 into `01-decisions.md`; the roadmap entry moved out of *Waiting on a
   blocker* (and the two related deferred entries — consensus rendering, auto-merge — folded in);
   README index line.
2. **`@skating/core`: the clustering primitive.** `clusterHazards`, type families, footprint distance,
   the chaining guard, the two constant sets. Property-tested, including shuffle-invariance and the
   chain fixture.
3. **Within-season pooling** — cluster-derived confirm/freshness gates in `hazards.listForBody`, the
   on-ice payload, and `hazardProximity`; archival deliberately left per-row.
4. **The draw-time nudge** on both clients (pure client-side; works offline).
5. **Consensus rendering** — union footprints in `hazardLayer`, the multi-reporter detail view.
6. **Auto-merge** — `mergedIntoHazardId`, `resolveHazardSurvivor`, read-through confirmations, the bar
   constants, `unmerge`, audit rows, and the admin panel.
7. **Schema + indexes** — `hazardRecurrence`, `hazards.by_first_reported`, `mergedIntoHazardId`, the
   `goneCount` comment fix in `schema.ts`.
8. **The rollover job** — work queue, per-body full pass, diff-preserving upsert, lease, July cron,
   `recomputeForBody`, merge hook.
9. **Server reads** — `hazardRecurrence.listForBody` (public-gated), `listForBodyAdmin`, `listQueue`,
   `suppress`/`unsuppress`, `promoteFromRecurrence`, the `demote` extension.
10. **Operator surfaces** — the two-section lake card, `/admin/recurrence`, the merges panel,
    `/admin/tuning` section + both charts + their rollups.
11. **Manual authoring** — the draw-a-feature surface, all nine types.
12. **The advisory** — component on both lake surfaces, yield rule, offline field, D3 copy tests.
13. **The D53 amendment** (§8.2) — supersession becomes a backlink; every reader of
    `promotedToFeatureId` reviewed; the "also a recurring feature" drawer line.
14. **The `shallow_early_thaw` rename + the depth cross-check** (§C7) — the rename is free while dev
    holds zero `bodyFeatures` rows, so it lands early in the phase rather than late.

**If the phase has to be cut**, items 2–6 are the half that pays off this winter and 12 is the half that
ships dark — cut from the bottom, not the top.

---

## 12. Risks and failure modes

| Risk | Why it bites | Mitigation |
|---|---|---|
| **A wrong auto-merge** hides a distinct hazard's identity | the one failure a skater can't undo | overlap + IoU + same-family + same-season bar; union footprint so warned area never shrinks; tombstone + one-click unmerge; audit panel and the unmerge-rate chart |
| **Chaining** drags a cluster across a lake | single-link on extended geometry | span guards in both windows; a test built from a real ridge chain, not tidy fixtures |
| **Over-merging in the nudge** — a skater talked out of a genuinely distinct pin | the prompt is a nudge at the worst moment to argue | "different hazard" is one tap, never blocked, and the nudge never fires for passage markers |
| **Pooling in the unsafe direction** | it would let two votes retire an unexamined neighbour | archival stays per-row, explicitly, with the reasoning in the code |
| **One reporter's repeated error becomes "a pattern"** | nothing requires independent observers | `distinctAuthorCount` stored and shown; suppression; open question 2 |
| **A migrating ridge** never clusters, or clusters wrongly | 80 m is a guess until there is data | tuned constants with charts behind them — the reason to build early |
| **Stale precomputed rows read as live** | annual recompute | provenance on every surface, recompute button, merge hook |
| **The advisory read as a live warning** | the most consequential misreading available | §3's discipline, no map presence, structural exclusion from on-ice, copy tests |
| **Promotion erases the evidence trail** | supersession hides across all seasons today | the D53 amendment (§8.2) — supersession becomes a backlink and hides nothing |
| **A volatile-family promotion over-warns permanently** | `shallow_early_thaw` is the one promotion reachable from a tier-A type | §C7's raised bar: 3 seasons minimum, depth must not contradict, mechanism named in the copy — and `demote` is one click |

---

## 13. Answered at scoping (2026-07-30)

All five open questions were closed by the founder the same day. Recorded with the reasoning, because
three of the five changed the design.

**1. Recurring volatile hazards do propose a permanent feature — renamed and at a raised bar.** ✅
Yes, and the type is renamed **`shallow_early_thaw`**: there is no guarantee the spot is a bay, and the
old name narrows the type to one of its cases. The bar is raised as recommended. See §C7 — this is the
single clearest illustration of what recurrence buys that one season cannot, and the rename is free
*today* and never again.

**2. A cluster needs no second reporter.** ✅ The founder's reading is exactly the concern: one skater
reporting the same ridge every winter on a pond nobody else visits would never promote under a
distinct-author requirement — and that is precisely the lake with the least other coverage, so the rule
would fail hardest where the feature matters most. `distinctAuthorCount` is stored and shown to
operators, and the constant can be introduced later if false patterns turn out to come from single
reporters. **Tune with data, don't guess now.**

**3. Promotion stops hiding hazards entirely — a D53 amendment.** ✅ Broader than the fix proposed:
not "current season only" but *never*, in any season, before or after promotion, because **a feature is
a pattern and a hazard is a sighting** and users go on filing sightings after a promotion. Rewritten as
§8.2; it is now a required work item rather than a conditional one.

**4. The nudge never blocks — and the better answer is a correction affordance.** ✅ Confirmed: no
hard block, ever. The founder's counter-proposal is better than the question and is **recorded as a
follow-on, not built here** — see below.

**5. No recurrence content on the per-body summary cards.** ✅ And the cards themselves move to
**N6c** (founder ask, same day) — they have waited long enough in the deferred register. They ship with
**active report counts and types only**. Revisit later: *"likely open water"* or *"frequently pressure
ridges off the eastern shore"* could genuinely help someone judge a lake with no recent reports — but
that is the surface closest to the map, where D3 pressure is highest, and it should be decided
deliberately rather than inherited.

---

## 13a. Follow-on, recorded not built: *"it's in the wrong place"*

**Founder idea, 2026-07-30**, arising from question 4 and better than the question. Rather than blocking
a duplicate, offer a third option beside *confirm* and *this is different*:

> **It's in the wrong place** → the skater redraws the existing hazard's footprint.

The appeal is that it fixes the actual problem. A duplicate pin is often not a second opinion about
*whether* — it is a first opinion about *where*, filed as a new hazard because there was no way to say
"that ridge is real but it's 40 m north of where it's drawn". Today the corrective information becomes a
duplicate; under this it becomes a better shape.

What has to be decided before it is buildable, and why it is a separate piece of work:

- **Replace, average, or vote?** Each has a different failure mode. Replace trusts the newest observer
  absolutely. Average produces a shape nobody drew and, on a line, can bend a ridge through ice that was
  never marked. A vote is honest but slow, and slow is wrong for a geometry correction on live ice.
- **The safety asymmetry decides most of it.** A redraw that **grows** a footprint is conservative and
  can apply immediately; one that **shrinks** it un-warns ice somebody marked, and should need more
  evidence — the same asymmetry as confirm (1 vote) versus removal (2), and the same logic as §B4's
  union rule. This is the seam a design should start from.
- **Vandalism surface.** Editing someone else's safety geometry is a strictly stronger power than filing
  your own, so it needs the moderation and history that hazard authoring already has — an edit log, a
  revert, and probably a trust or corroboration gate (D50).
- **It interacts with auto-merge.** A correction and a merge both change what one footprint means, and
  they should be one story rather than two mechanisms racing to reshape the same pin.

Not in N5c: this phase's nudge converts duplicates into *confirmations*, which is the 80% case and needs
no new lifecycle. Correction is a new authoring power and deserves its own scoping.

---

## 14. Trigger and staging

- **Ship now, public immediately:** workstreams A and B (clustering, nudge, pooling, consensus rendering,
  auto-merge), E (manual authoring), the D53 amendment (§8.2) and the `shallow_early_thaw` rename. None
  of it makes a claim about the future, and the corroboration fix pays off in the first winter.
- **Do the rename first.** It is a find-and-replace while dev holds zero `bodyFeatures` rows and a
  migration once it doesn't.
- **Ship now, dark:** workstreams C, D and F behind `RECURRENCE_ADVISORIES_PUBLIC = false`.
- **Flip the public flag when** the operator queue has been read across at least **two** rollovers and
  the clusters at the current bar look like real patterns — realistically the `'28/'29` rollover,
  possibly `'27/'28` if the corpus is dense. A judgement from `/admin/recurrence` and the tuning chart,
  not a date.
- **Raise `RECURRENCE_PUBLIC_MIN_SEASONS` to 3** if 2-of-4 reads noisy once public. The constant, the
  timing window and the advisory move together, so it is one edit and one redeploy.
- **Watch the unmerge-rate chart in the first winter.** It is the only empirical check on
  `AUTOMERGE_MIN_FOOTPRINT_IOU`, and the bar should be raised on the first sign operators are undoing
  merges.

---

## 15. What the build changed about the plan (2026-07-31)

Written during the first half rather than after it, in the house style: the things the plan got wrong
are more useful than the things it got right.

### 15.1 The chaining guard had to be rebuilt twice

§A1 bounds a cluster's **total span** at `DUPLICATE_MAX_CLUSTER_SPAN_M` = 150 m. Both halves of that
are wrong, and each was caught by a fixture rather than by reading.

**An absolute cap cannot work.** A `pressure_ridge` is routinely 600 m of buffered LineString, so any
cap tight enough to stop chaining refuses to merge two pins of *one ridge* — the exact case the
mechanism exists for. The guard is now **relative**: a cluster may extend `*_MAX_CLUSTER_SPREAD_M`
beyond its **largest single member**, anchored on the biggest thing anyone actually drew rather than on
the biggest thing merging has produced, so repeated links cannot ratchet the allowance up one at a
time.

**And it cannot be measured on the diagonal.** Two 400 m ridges crossing at right angles overlap and
are plainly one cluster, but their merged box is 400 m square — a 566 m diagonal against a 400 m
member, so a diagonal guard refuses the merge purely because the ridges point different ways. The
comparison is now per axis: north–south against north–south, east–west against east–west.

The constants keep their values (150 / 400) and change their meaning, so `/admin/tuning` says
`DUPLICATE_MAX_CLUSTER_SPREAD_M` and describes it as a spread rather than a span.

### 15.2 Footprint distance needed a second pass, for a shape this phase is mostly about

"Minimum distance between footprints" is exact when computed vertex-against-polygon in both
directions — for **disjoint** shapes, and for containment. It is wrong for exactly one case: two
polygons that **cross** with no vertex of either inside the other. That is not a corner case here. It
is two buffered ridge bands crossing at right angles, which overlap and which clustering should
plainly collapse, and a vertex-only test reports clear water between them. `polygonDistanceMeters`
therefore runs a segment-crossing scan as a second pass — but only when the first found a gap while the
bounding boxes still overlap, so the common answer costs nothing extra.

### 15.3 The witness count includes people who *drew*, not only people who tapped confirm

**Founder call, 2026-07-31.** §B2 says the pooled gate reads "distinct confirming users across the
cluster". But the commonest duplicate has no confirmations at all — three skaters each mark the same
ridge, nobody presses anything — and a confirmers-only count leaves every phone on the lake stuck at
the soft *"can you see it?"*, which is the failure §1.2 opened with.

So a cluster's witnesses are distinct users who **either** confirmed a member **or** authored one,
always excluding the pin's own author. §B4 already made this argument for the merge case (*"the
merged-away reporter counts as a corroborating observer — stronger evidence than a confirm tap, since
they saw it independently and drew it"*); it applies identically to an unmerged cluster. Singletons are
unchanged — identical to today's `confirmCount`, which is a property test — one person double-posting
is still one witness (D54 intact), and crossings never cluster, so the one pin type where escalating
too readily would be anti-conservative is excluded structurally rather than by a threshold.

### 15.4 §9.5's offline story was about a cache that does not exist

Corrected in place — see §9.5. Short version: `bodyCache.ts` holds body reference data only, hazards
reach the on-ice evaluator from a live `listForBody` subscription, and the structural exclusion is
consequently *stronger* than the plan claimed (a different query the on-ice path never asks for) while
"rides the offline cache" is simply not true today, for advisories or for hazards.

### 15.5 Two readers of `promotedToFeatureId` the amendment's diff missed

§8.2 warns that the reviewer's diff is *every* reader of the field, and then lists four. There are six.
`weather.getHazardWindow` refused a weather strip for a promoted pin, and
`hazardWeather.listActiveHazardsForWeather` deferred one out of the decay sweep — both on the reasoning
that a promoted pin "doesn't render". Under the amendment it does, so the second one would have left a
visible hazard reading its freshness off a stale weather window. Both now key on moderation alone.

### 15.6 Decisions taken in the build, worth recording

- **Auto-merge runs at create**, in the same mutation, bounded to the body and the season. Any later
  and there is a window in which the map shows two pins for one ridge, which is the state it exists to
  remove — and it is the same moment the draw-time nudge fired, so the two cannot disagree.
- **`create` returns the survivor**, so a client navigating to what it just filed lands on a live pin
  rather than a tombstone. `get`, `listClusterMembers` and the confirm path all resolve through the
  chain, so a permalink or an on-ice notification sent before a merge still works.
- **A vote arriving now *does* follow the chain**, which is not in tension with "confirmations are
  never re-pointed": that rule is about *existing* statements at merge time. Writing a new vote against
  the tombstone would file a real observation somewhere no lifecycle reads.
- **The survivor's union is stored as its `clippedFootprint`**, which widens that field's meaning from
  "the clip, when clipping removed area" to "the stored footprint override". Render, the stored bbox
  and the proximity evaluator already read it, so a merge changes what is drawn and what is measured
  with no client change at all — and `unmerge` restores the original by recomputing from the row's own
  untouched `geometry`.
- **`moderationActions.actorId` becomes optional.** Auto-merge writes audit rows, but has no human
  actor, and naming the creating skater would record a member as having moderated when they didn't.
- **`noMergeWith`** on both rows is what stops `unmerge` being a button that undoes nothing.
- **`duplicate_nudge`** joins `HAZARD_CONFIRM_VIA` — the only trigger that also records a duplicate
  *prevented*, which is what makes the nudge's conversion rate measurable.
- **`BODY_FEATURE_TYPES` moved to `@skating/core`**, re-exported by `lib/enums.ts`, because D79's form
  made it the third hand-kept copy of the list and the D65 four-copies scar is the reason not to.

### 15.7 Left open, deliberately

**Dismissing the nudge blocks the merge, and only the merge.** Pooling and consensus rendering are
non-destructive — the union outline is never smaller than either member and the drawer still names both
reporters — so a dismissed pair still draws as one outline. One outline is visually the same claim a
merge makes, which is a residual tension worth a founder's eye. If it reads as overruling the skater,
the lever is to carry `dismissedDuplicateOf` into `poolConsensus` as a cluster split, **not** to weaken
the merge bar.

**Not built here, and not started:** workstreams C (the `hazardRecurrence` table, the rollover job, the
ranking), D (the two-section lake card, the cross-lake queue, suppression) and F (the skater-facing
advisory and its copy tests). §11's cut line held exactly as written — items 2–6, 11, 13 and 14 are the
half that pays off this winter.

---

## 16. What the review pass found (2026-07-31, before the PR)

Every suite was green when this pass started, which is the point: none of the four below were caught by
a failing test, and three of them were *asserted* somewhere as already true.

### 16.1 Pooling reached every gate except the one the phase opened with

**The worst of them, and the most instructive.** `toView` pooled `freshness`, `provisional` and
`expired` correctly, and published the pooled witness count as a **separate** field,
`clusterConfirmCount`. Nothing read it. The on-ice evaluator takes `confirmCount` off the row and
**re-derives `isProvisional` itself** (`hazardProximity.ts:108`), so three skaters marking one ridge —
§1.2's opening scenario, and the whole subject of §15.3's founder call — left every phone on the lake at
the soft *"can you see it?"* while the drawer beside it read confirmed.

The lesson is not "we forgot a field". It is that **a derived value published alongside its raw input is
an invitation to read the raw input**, and the on-ice path had a second, independent derivation of the
same rule sitting a package away. `toProximityHazards` now feeds `clusterConfirmCount ?? confirmCount`
into the evaluator, which makes the pooled number load-bearing rather than decorative. The deeper fix —
carrying the server's `provisional` and deleting the client-side re-derivation — is a bigger change to a
shipped Phase 9.5 interface and its `confirmThreshold` tunable, and is the right thing to do the next
time that file is opened.

### 16.2 Recomputing a union from the stored union is not reversible

`refreshMergedFootprint` read each row through `hazardFootprintOf`, which prefers `clippedFootprint` —
and on a survivor that field *is* the union. So the union was recomputed from itself and could only
grow. §15.6's claim that *"`unmerge` restores the original by recomputing from the row's own untouched
`geometry`"* was true of the intent and false of the code, in two cases:

- **three pins, one unmerged**: the removed pin's area stays, so Unmerge does nothing to the outline it
  was pressed to undo;
- **two pins near a shore**: the empty-chain branch re-clips the *union* instead of the pin's own shape,
  and stores the widened footprint again.

The existing test passed because its fixture sits mid-lake, where `clipFootprintToBody` returns `null`
and the row falls back to the drawn shape — a fixture that was tidy in exactly the way §A1 warns
chaining fixtures are tidy. Every recomputation now starts from `geometry` + `radiusMeters`/
`bufferMeters`, the one thing a merge never edits, and the three-pin case is a test.

### 16.3 A `filter` before a `take` is not a bounded read

`listRecentMerges` was written as `.order('desc').filter(...).take(50)` and documented as *"bounded"*.
Convex reads rows until it has 50 **matches**, so on a corpus with no merges — which is every corpus
today — it walks the whole append-only audit log. The same commit had already added
`moderationActions.by_created_at` for the 7b rollup, with a comment saying precisely this about scans of
that table. It now reads a 120-day window off that index: bounded by a season's moderation volume rather
than by how long the app has been running.

### 16.4 A file git will not diff is a file nobody reviews

`hazardConsensus.ts` carried a **literal NUL byte** as a map-key separator, so git classified the file as
binary: no diff, no blame, no line comments — on the module that computes what the alert gates read. It
ran fine and lint was silent. It is written as the `\u0000` escape now, which is the same string
to the runtime and a reviewable file to everything else.

### 16.5 The rest

- `listForHazard` queried votes by the **argument** id while resolving the hazard through the merge
  chain, so a stale deep link listed the tombstone's confirmers under the survivor's count.
- The nudge's *"no, this is a different hazard"* cost a **second** submit press on both clients, which
  §B1 promised it would not. It now files in the same tap — passed as an argument rather than through
  `setState`, which would not have been visible to the call that followed it anyway.
- The idempotent-replay branch of `create` returned the stored id without resolving the chain, breaking
  the *"`create` returns the survivor"* rule for exactly the offline-flush path that rule was for.
- `/admin/recurrence` had a hand-written copy of `relativeWhen`, in the phase whose thesis is that the
  second copy is where the drift starts.

**One finding the review got wrong, kept because the reasoning is the useful part.** It was reported
that corroboration credit gated every cluster member on the *opened* pin's witness count, and that
per-member counts could differ by one. They cannot. `clusterConsensus` builds its witness set as
`confirmers ∪ authors`, and every member's author is in `authors` by construction — so
`witnesses.has(member.createdByUserId)` is always true and every member's count is `witnesses - 1`.
The number is uniform across a cluster, one member clearing the bar means all of them have, and the
per-member re-check briefly added was dead code. It has been removed and the invariant written down
where the loop reads, since it is a fact about `clusterConsensus` that is not obvious from the call
site — which is exactly how it got misread the first time.

**Left as-is, deliberately:** `tryAutoMerge` reads every active hazard on the body inside the create
mutation. It matches `listForBody`'s bound (Phase 9 call 6) and is correct; it does widen the OCC
conflict window for concurrent creates on one lake, which is worth remembering if a popular lake ever
sees contention.

### 16.6 The coverage pass

The primitives were already well covered — `hazardCluster` has shuffle-invariance, partition and
span-guard property tests, and `hazardConsensus` has the monotonicity one. The gaps were all a layer
out, in the code that *uses* them, and every one of them was a documented claim nothing asserted:

- **Pooled corroboration credit** (§B2's fourth row) had no test at all. Now covered by the case it
  exists for: two pins 30 m apart — overlapping enough to cluster, not enough to merge — where one
  confirm tap credits both reporters on a bar no single pin reached.
- **The `hazard_merges` rollup**, which §7.4 calls the only empirical check on the merge bar. Now
  asserts the automatic/moderator/undone split stays three numbers, that a quiet day writes a zero
  rather than a hole in the series, and that re-running a day overwrites.
- **`clusterScopeFor`'s archived exclusion** — the claim that a pin the community voted healed must not
  borrow freshness from a live neighbour. It was a bound inside an index expression with nothing
  asserting it; now a test.
- **The merge-chain hop cap**, whose whole job is to turn a cycle into `null` rather than a query that
  never returns.
- **`listRecentMerges`'s window**, added in this pass, so the bound doesn't quietly regress to a scan.
- **`polygonUnion`** — exercised indirectly through the layer and the merge tests, but its two
  load-bearing contracts (the union covers every member; a failure returns `null` so the caller draws
  more outlines rather than fewer) were never stated directly.
- **The new copy** — `relativeWhen`'s day/hour boundaries, and the D3 assertions the nudge and the
  consensus summary have to satisfy: no accusation, no invented attribution, no raw enum key, no claim
  that the hazard is there.

**Still not asserted:** the one-tap nudge wiring on either client. The pure candidate finder is covered
in `hazardDuplicate.test.ts`, but neither client has a form harness, so that path is reviewed rather
than tested — which is the standing state of client UI in this repo, not a gap this phase opened.

---

## 17. What Greptile found (2026-07-31)

Three findings, all real, and they share one shape: **auto-merge was wired into `hazards.create` and
nowhere else.** §15.6 recorded the decision to merge *at create*, in the same mutation, and that
reasoning was right — but "create" turned out to name one code path rather than the event, and the
other two ways a hazard enters the system were each wrong in their own way.

### 17.1 The offline queue dropped the one field that exists to be remembered

`dismissedDuplicateOf` rides a `hazards.create` call, and `QueuedHazard` never carried it. So a
skater who tapped *"no, this is a different hazard"* and then lost signal had their answer discarded
at the queue boundary: the pin flushed an hour later without it and was auto-merged into the very
hazard they had looked at and rejected.

That is the worst version of this defect, because **the nudge fires hardest exactly where there is no
signal** — two skaters, one ridge, both flagging it — so the dismissal is most likely to be *made*
offline and, without this, most likely to be lost. The field now travels the same way `capturedAt` and
a confirmation's `observedAt` do, on the standing rule that what a skater decided on the ice survives
the round trip unchanged.

### 17.2 The report path created hazards without merging them

`reports.create` calls `insertHazard` directly for the in-report authoring path (D51), so a hazard
drawn inside a report skipped auto-merge entirely — which made the report form *the way to file a
duplicate that never collapses.* A hazard drawn in a report is a sighting like any other, and the
state auto-merge exists to remove does not care which form produced it.

Two details the fix had to get right, both of which only exist because the report path writes several
hazards at once:

- **The report records the survivor,** not the row it just wrote, so `hazardIdsCreated` can never point
  at a tombstone.
- **And dedupes,** because two hazards drawn in one report can be judged the same thing — in which case
  the report created one hazard and should say so rather than listing the survivor twice.

### 17.3 Reputation was paid per pin, not per sighting

Greptile's P1, and the one with a consequence outside the hazard system. Pooling made the corroboration
bar cluster-wide, and the award loop then ran once per *member* — so one skater who marked the same
ridge twice was credited twice for one observation, at four points a time, feeding the D50 trust class
and the ring that renders from it.

The credit is now keyed to the **earliest member each author drew**, once per person per cluster.
Earliest because the canonical order is stable, and the idempotency check spans *all* of that author's
members rather than the one being awarded — otherwise an earlier pin joining the cluster later (a
backdated `capturedAt` on an offline flush is enough) would re-award, which is the same defect arriving
more slowly. Two *different* people each drawing the ridge is still two awards: that is two independent
sightings, and it is the entire reason a cluster is better evidence than a pin.

### 17.4 One more, found while confirming 17.2

`listBundleCandidates` had no merge filter, so the D55 auto-bundle offered **merge tombstones** as
"your hazards from this skate" — pre-checked, in the form whose job is to tidy them up, and where the
survivor is the author's own it sat one row above its own tombstone. `attachHazardsToReport` accepted
them too. Both filter now, on the split the rest of the phase draws: supersession records where a
feature came from and hides nothing, a merge says *this pin is represented by another one*.

### 17.5 The lesson

Three of these four are the same missed question — *what are all the ways a hazard is created?* — and
the fourth is *what are all the ways one is offered?* The phase asked that question carefully about
**readers** of `promotedToFeatureId` (§8.2 warns that the diff is every reader, and §15.5 found two more
it missed) and never asked the mirrored question about **writers** of a hazard row. Worth carrying into
the second PR, where the recurrence job becomes a third writer of hazard-shaped state.

### 17.6 The second pass: a dismissal that outlived its draft

Greptile again, on the fix for §17.1 rather than on the original code — and right.

`dismissedDuplicateOf` was carried into the queue correctly, but **nothing cleared it afterwards**.
Mobile runs the whole capture session on one mounted component, so after filing a pin with a dismissal
the state stayed set, and the *next* capture — a different hazard, possibly a different type, possibly
metres from a genuine duplicate — took the `dismissed === null` branch and skipped duplicate detection
entirely, then sent the stale id to the server to suppress a merge nobody had declined. A field added
to stop the machine overruling a skater had become a way to silently disable the check for everything
that followed it.

Cleared now in `resetDraftState` (which every exit already funnels through) and on **retype**, because
matching is per type family: the pin a skater ruled out may not even be a candidate for what they are
drawing now, so re-asking is one tap and carrying the exclusion is a silent no.

Web was safe, but only **by accident of its caller** — `WaterBodyDetail` mounts the form conditionally,
so closing it unmounts and takes the state with it. That is a property of one call site, not of the
component: the sibling `ReportForm` one line above stays mounted behind an `open` prop, and moving the
hazard form to match would have reintroduced the bug silently. Both exits now go through a shared
`clearDraft`, and the reasoning is written where someone would change it.

**Twice now the defect has been in the nudge's client state** — the two-tap dismissal in §16.5, this in
§17.6 — and both times in the one surface this repo does not test. The lever, if a third appears, is to
lift the nudge's state into a pure reducer in `@skating/core` that both clients drive, the way
`hazardDraft` already works. Not done here: it is a refactor of shipped authoring flows, and the second
PR is a better place for it than the tail of this one.

### 17.7 A dismissal names a row; a skater declines a hazard

Third pass, and the sharpest of them: `dismissedDuplicateOf` was compared by **row id**, and this phase
spent its whole length establishing that a hazard is not a row. Two doors around the check, both of the
app's own making:

- **The merge chain.** The pin a skater was shown may since have been folded into a survivor — and on
  the offline path that is not a rare race, it is the expected case, since hours pass between the nudge
  on the ice and the flush in signal. Refusing only the dismissed id let the *survivor* — the pin now
  carrying exactly that hazard's warning — absorb the new one.
- **The cluster.** A sibling overlapping the same ice is, by §A1's own definition, the same hazard.
  Folding into it put the pin in precisely the cluster the skater rejected, through a different door.

`shouldAutoMerge` now takes a `dismissedIds` set and the server resolves it: the dismissed row, its
survivor, everything folded into that survivor, and the cluster the dismissed hazard belongs to.
Computed only when a dismissal exists — rare — so an ordinary create pays nothing. The new pin is
excluded from that clustering pass on purpose: what the skater declined is a fact about the *existing*
pins, and letting the draft influence which cluster that is would make the answer depend on the thing
being judged.

Erring wide is right here. Over-refusing leaves two pins a moderator can merge by hand; under-refusing
overrules a person who was standing on the ice looking at it. But the refusal stays scoped to **one
hazard, not the lake** — a dismissal must not switch off deduplication for everything else that
session, and that is its own test.

### 17.8 Returning `null` is not unmounting

The other half of §17.6, by a path the fix didn't cover. `HazardCapture` renders `null` while a deletion
is pending (D62), and a pending deletion **can be cancelled** — so it is a round trip, not an exit, and
every `useState` survives it. A dismissal made before the read-only window was inherited by the first
capture after it, which then skipped duplicate detection and sent an unrelated exclusion.

Cleared on the transition now. Only the nudge state: freeing the draft and its photo files when a
deletion goes pending is arguably right too, but that is a D62 question rather than this phase's, and
guessing at it inside a hazard-identity change is how unrelated things break.

**Three passes, three variations on one root.** §17.5 named it as "the phase never asked who all the
*writers* are". §17.6 through §17.8 sharpen it: the phase also never asked **what a stored id refers to
once merging exists**. `dismissedDuplicateOf`, `hazardIdsCreated`, `attachHazardIds` and the bundle
list were all written before auto-merge and all meant "this row" in a world where a row was a hazard.
Every one of them needed re-reading as "this *hazard*", and the second PR adds `memberHazardIds` to
that list before it adds anything else.

---

## 18. What the cross-season half changed about the plan (2026-07-31)

Same discipline as §15: the places the plan was wrong are worth more than the places it was right.

### 18.1 §C4's own matching threshold could not do what §C4 said it would

The plan asks for two things in the same paragraph, and they contradict each other:

> Preserve `suppressedAt` and `promotedToFeatureId` by matching new clusters to existing rows on
> **member overlap** (Jaccard > 0.5)… A cluster that grew by one member is the same cluster.

One member growing to two is a **Jaccard of exactly 0.5** — not greater — so the row a moderator had
suppressed would be abandoned the first winter anyone added a sighting. Two growing to four is 0.5 as
well. Small clusters are the *only* clusters for years, so the symmetric measure fails across the whole
corpus before it ever succeeds.

The match is the **overlap coefficient**, `shared / min(|old|, |new|)`, which says what the second
sentence meant: most of the smaller set survived. It matches a cluster that grew, matches one that
shrank because pins were hidden, and still refuses two that merely brush past each other. A split still
lets only one half inherit, because a claimed row is out of the running for the rest of the pass.

### 18.2 The rollover is a daily tick with a month gate, not a `crons.cron`

§C4 notes this would be the repo's first cron expression. It still isn't one, and the reason is better
than uniformity: a `0 8 2 7 *` expression that fails on July 2 **waits a year**. A daily interval that
does nothing outside the first week of July, and nothing again once `computedForSeason` is stamped,
makes the once-a-year job retryable for the price of one indexed read on 358 days. Both halves of that
gate are tests.

### 18.3 The advisory's timing clause reads "first reported", not "between"

§9.2's example is *"first seen between late December and February"*. But the window label collapses a
fully-covered month to its bare name — which is what makes *"late December to February"* come out right
— and *"between January"* is not a sentence. `first reported <label>` works for every shape the label
can take, and keeps the clause in the same past tense as the rest of the sentence.

### 18.4 The advisory describes a **family**, not a hazard type

§9.2 says *"Type from `HAZARD_TYPE_LABELS`"*. A cluster can hold a `pressure_ridge` and an `ice_heave`,
so naming one of them would report a detail the record does not carry. The copy names the family, and
`RECURRENCE_FAMILY_PHRASES` has no `crack` entry — the *type* refuses one, since `RecurrenceFamily`
excludes it, so the compiler holds that line rather than a comment.

### 18.5 Decisions taken in the build

- **A scratch queue table**, because the two phases cannot share a `.paginate()` and an array threaded
  through scheduler arguments grows without bound in exactly the corpus this pass was built for.
- **`representativeHazardId` is stored**, so a promotion records itself against the same pin whose
  shape the feature carries. Re-deriving the medoid at promote time could pick a different one.
- **`demote` had to grow.** It cleared `promotedFromHazardId` and nothing else, which after a *cluster*
  promotion leaves every other member naming a standing statement that has been withdrawn. It clears
  every backlink now and returns the pattern to the queue.
- **`promote_recurrence` is its own audit verb.** Promoting one sighting and promoting a pattern across
  winters are different claims, and an audit that could not tell them apart would lose the reason the
  second one can be trusted.
- **The tuning chart is a distribution.** "How many patterns go public if I raise the bar" is only
  answerable as a histogram, and that constant is the one thing in this half a skater ever feels.
- **The test file pins the clock**, and it is load-bearing: almost everything defaults to
  `seasonOf(Date.now())`, so fixtures dated in one season against a real wall clock produce empty
  results that look exactly like a broken query. Five tests failed that way before the pin.

### 18.6 What is deliberately not built

- **The `?action=` deep link and any notification path for advisories.** §9.4's no-list holds: no
  notification, no bounty, no feed row, no `displayScore`, no trust or points, and nothing confirmable.
- **A durable offline cache for advisories.** §9.5 was corrected in the first half — no such cache
  exists for hazards either — and matching hazards' behaviour is the consistent choice. A per-body
  hazard cache is a real, unbuilt thing if the on-ice path is ever to survive a cold start with no
  signal, and it should be designed for hazards first.
- **Impression tracking on the advisory**, and any measurement of whether skaters read it. There is
  nothing to measure while it ships dark, and the honest time to decide what to count is when somebody
  proposes flipping the flag.

### 18.7 The trigger, restated now that it is real

`RECURRENCE_ADVISORIES_PUBLIC` flips when the operator queue has been read across at least **two**
rollovers and the clusters at the current bar look like real patterns — realistically the `'28/'29`
rollover, possibly `'27/'28` if the corpus is dense. That is a judgement from `/admin/recurrence` and
the *Patterns by winters observed* chart, not a date. Raising `RECURRENCE_PUBLIC_MIN_SEASONS` to 3 is
one edit, and it moves the advisory and its timing clause together by construction.

---

## 19. What the second review pass found (2026-07-31, before the PR)

Every suite was green before this pass too, which is the recurring lesson of §16: the things worth
finding here were **claims the plan made that the code did not keep**, and a test cannot fail on a
sentence nobody translated into an assertion. Four of the six below are of exactly that shape.

### 19.1 The advisory's yield rule could not fire in the season it is for

**The worst of them, and it was asserted as working.** §9.3 says an advisory stands down when a hazard
has been reported this season *"inside the cluster footprint"*. The code tested **membership** —
whether a live pin's id appears in `memberHazardIds` — and those are the same test only if membership
is current. It is not: the rollover runs in the **first week of July**, when the season it computes
for is days old and holds no hazards at all. So a ridge pinned the following January is *never* a
member of the cluster that describes it, and the advisory would have gone on talking over a live pin
for the entire winter — the one season it exists to stand down in.

It ships dark, so nothing reached a skater. What makes it worth writing down is how it passed review
twice: the test seeded its "live" pin **before** running the pass, which made the pin a member and the
assertion vacuous. A fixture that pre-dates the job is a fixture that cannot see a staleness bug, and
this phase's whole subject is a table that is computed once a year.

`hasLiveSighting` now measures geometry — same family, within `RECURRENCE_MATCH_METERS` of the stored
representative footprint, on the same fallback ladder render and proximity use. The tolerance is the
one the cluster was built at, so a pin that would have joined this cluster in July is the pin that
silences it in January. Two tests replace the old one: a sighting filed *after* the pass (asserting
explicitly that it is **not** a member and yields anyway), and the other direction — a pin a kilometre
away, or of another family, does not silence a history it is not about.

### 19.2 A query that ships dark should not read the lake

`recurrence.listForBody` collected every active hazard on the body before deciding what to yield —
including when the public read had returned **zero** rows, which while `RECURRENCE_ADVISORIES_PUBLIC`
is off is *every single call*. Both clients mount `IceHistory` on every lake drawer open, so the
shipped-dark state was paying a full per-body hazard read for a query that returns `[]` by
construction. One early return. Worth naming because it is the failure mode of anything gated by a
constant: the gate makes the feature invisible, not free.

### 19.3 A partial rollover waited a year, which is what the interval was chosen to avoid

§18.2 argues for a daily tick over a `crons.cron` because *"a run that fails on July 2 is picked up on
July 3"*. `maybeRunRollover` gated on "does any row exist for this season" — which is true after the
**first** body commits. A chain dying at body 1 of 200 therefore set the stamp, left 199 rows queued,
and made every remaining tick in the window a no-op. The retryability held only for the failure that
happens before any work lands, which is the least likely one.

The queue is now checked first and outranks the stamp. Restarted from the top rather than resumed,
because a run can also die *during* discovery and a half-built queue cannot be told apart from a
finished one — and restarting is safe precisely because the pass is idempotent, which was already a
test. One redundant pass in a failure year is the right price for a pass that finishes.

### 19.4 A reversible decision with nowhere to reverse it

`unsuppress` had a mutation, an audit verb and a test, and **no caller**. The per-lake card printed
*"Suppressed — {reason}"* as dead text and the cross-lake queue filtered suppressed rows out without a
way to ask for them, so §7.3's *"Reversible; never a delete"* was true of the server and false of the
product. Both surfaces now carry Unsuppress, and the queue a *Show suppressed* toggle.

This is §8's own finding — `bodyFeatures.create` shipped with no UI, which is why D79 existed —
repeating inside the phase that recorded it. The generalisation worth keeping: **a mutation without a
surface is not a feature, and the reversibility argument for a destructive-looking action is only as
good as the button.**

### 19.5 `listQueue` was capped, and the plan said paginated

`.take(min(limit, 300))` followed by in-memory filters for family, minimum seasons, promoted and
suppressed. That is §16.3's finding from the other end: the read is bounded, but the *filters* are not
in the index, so on a corpus whose top-ranked clusters are mostly promoted the cap fills with rows the
operator asked not to see and the queue reads **empty** while unpromoted patterns sit just below it.
Now genuinely paginated on the repo's existing `paginationOpts` / `usePaginatedQuery` idiom, with the
same note `listFeed` carries: a page filtered to nothing is how a filtered scroll makes progress, not
the end of the list.

### 19.6 Two sections numbered 17

The cross-season write-up was numbered `17`, as was *What Greptile found* — colliding headings and
colliding `17.x` anchors, in a repo whose docs suite already has a note about GitHub slug collisions,
and with the status block linking to the section by number. Renumbered to **18**, and this pass is 19.

### 19.7 Left as-is, deliberately

- **A body that fails to recompute blocks the ones behind it.** `processNextBody` takes the first
  unclaimed row in index order, so a lake that throws is retried at the head of the queue on each of
  the July ticks and nothing after it runs that day. Bounded (the window is a week) and visible in the
  logs, and the alternative — a failure counter per row — is machinery for a failure nobody has seen
  yet. Worth remembering rather than pre-solving.
- **`describeCluster` double-counts a mixed archive.** A hazard archived on one `fully_healed` plus
  one `never_existed` vote lands in both `healedSeasons` and `neverExistedCount`. It needs a hazard
  with exactly one of each and no third vote, and both penalties point the same way, so the ranking
  errs conservative. Not worth a special case in the one function whose sign errors are hardest to see.
- **`enqueueBody` recomputes inline rather than enqueuing.** The name is wrong and the behaviour is
  right — a body merge should not wait for July. Renaming it touches the merge path in `waterBodies`,
  which is not where this PR should be making incidental edits.
