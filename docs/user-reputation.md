# User reputation

How trust is earned, shown, and — separately — how bad-actor patterns get routed to a human. The
whole system (Phase 6, D50; extended by Phase 10's contradiction signal, D56 §7) is designed
around one asymmetry, so start there.

> **Who this is for.** Anyone tuning reputation, or trying to understand why a user who posts
> conflicting reports never loses points. The numbers are **"approved starting points" (founder,
> 2026-07-21), not measured optima** — recalibrate once alpha shows the real point/age
> distribution. Almost all of them live in one file, `packages/core/src/reputationConfig.ts`,
> which is the Phase-7 admin tuning surface.

---

## The one idea: trust is boost-only; enforcement is a separate, human-gated axis

**Reputation points only ever go up.** There is no penalty, no negative score, no "distrusted"
tier. A user earns trust from the community's *reaction* to their contributions, and that's the
only thing the number tracks. It's clamped at zero in three separate places in the backend, so
this isn't a convention — it's an invariant.

So what stops a bad actor? A **completely separate axis**: a private, non-scoring signal that,
on a *sustained pattern*, files a flag for a **human moderator**, whose lever is a posting
restriction (D57). Nothing automatic ever restricts anyone. Keep these two axes distinct in your
head and the rest of the system falls out cleanly:

```
  TRUST (boost-only, cosmetic)          ENFORCEMENT (private, human-gated)
  points → trust class → chip/ring      contradiction signal → mod flag → posting restriction
  never decreases                       never touches the trust number
```

Why boost-only: trust drives what the [recommended feed](#the-recommended-feed) amplifies, and a
score that could be *lowered* by disagreement would punish honest "the ice changed today"
reports and chill exactly the safety reporting we want (D3). Enforcement belongs to a human
looking at a tenure-aware chart, not to an automatic counter.

---

## Trust classes (the cosmetic tiers)

Points map to four ascending classes, rendered as a **chip on the profile** and a **colored ring
+ corner badge** everywhere else — **never a raw number** (except to admins). Derived, never
stored, so retuning a threshold reclassifies everyone with no migration
(`deriveTrustClass`).

| Class | Point floor | Color | Notes |
|---|---|---|---|
| `new` | — | slate | shown for the first **14 days** (`NEW_ACCOUNT_WINDOW_MS`) even with zero signals — a welcome, not a verdict |
| `trusted` | 15 | blue | |
| `expert` | 60 | violet | |
| `leader` | 150 | amber | |
| *(none)* | — | — | a sub-`trusted` account **past** the New window shows **no chip** — we never render "Not trusted" |

**Points beat age.** Thresholds are checked top-down first, so a fast earner who crosses `expert`
in their first week is `expert`, not `new`. The `null` (no-chip) state is a real fourth outcome,
not an error — since the model is boost-only, scores never go negative, so there's no bottom tier.

---

## How points are earned (`POINT_WEIGHTS`)

Every weight bumps `reputationPoints`. **Peer/quality signals deliberately outweigh raw volume** —
you earn trust from the community's reaction, not from posting a lot:

| Reason | Points | What it rewards |
|---|---|---|
| `report_submitted` | 2 | baseline observation — cheap on purpose |
| `photo_evidence` | 3 | report carries ≥1 photo (once per report) — self-verifying |
| `measured_thickness` | 2 | a *measured* (not estimated) reading — take-my-word rigor, so below photo |
| `helpful_thumb` | 5 | a peer thumbed your report or hazard helpful |
| `report_corroborated` | 4 | an independent same-body report agreed with yours |
| `hazard_confirmed` | 1 | the confirmer's helpful act |
| `hazard_corroborated` | 4 | your hazard confirmed by ≥2 peers (author side) |

Note what's **absent**: there is no `unhelpful` weight (boost-only), and `bounty_fulfilled` isn't
here — it's a *separate currency* (`bountyPoints`, default 10/bounty) that never mixes with trust.
See [bounty decay & lifecycle](./bounty-decay-and-lifecycle.md).

Because every derived value is recomputed from the `pointEvents` ledger by a backfill script,
**changing a weight mid-alpha is a replay, not a migration** (D40).

---

## Corroboration (D50 decision 3)

The signal that two independent people saw the same thing. The "agrees" test is deliberately
loose about labels but strict about substance (`reportsAgree` in `reputation.ts`): two same-body
reports agree when their `skateQuality` is **within one ordinal step** (different people mean
different things by "good" vs "fair") **OR** they share **≥1 ice type**. Absence isn't agreement.

| Constant | Value | Controls |
|---|---|---|
| `CORROBORATION_WINDOW_MS` | 7 days | how far apart two reports can be and still bear on each other (a freeze cycle) |
| `CORROBORATION_MAX_PER_REPORT` | 3 | cap on how many priors a *single* create may corroborate — bounds a burst windfall |
| `HAZARD_CORROBORATION_MIN_CONFIRMS` | 2 | peer confirms (author excluded) for the author's `hazard_corroborated` boost |

---

## The contradiction signal (D56 §7)

The enforcement axis. It is the **inverse seam** of corroboration — but critically, **it never
subtracts trust.** It withholds the corroboration boost, sets a symmetric disclosure flag, and —
only on a sustained pattern — routes the un-corroborated author to a human.

**Detecting a *candidate* contradiction** (`reportsContradict`) is strict, to avoid false alarms:
both reports carry a `skateQuality` differing by **≥2 ordinal steps** (e.g. `great` vs
`fair`/`poor`) **AND** they share **no** ice type. It's a strict subset of "don't agree," so a
pair can never both agree and contradict.

**But a candidate is not a contradiction until weather is ruled out.** An honest "the ice changed"
report is never a contradiction (D3/D50). So the settler
([`weatherExplainsIceChange`](./weather-since.md#weatherexplainsicechange--the-shared-honesty-gate),
default 48 FDH / 36 TDH) checks whether the weather *between* the two reports could explain the
disagreement — if so, it's dropped. (Reports less than
`WEATHER_MIN_EXPLAIN_WINDOW_MS = 1 h` apart skip the fetch: weather can't explain a same-hour
disagreement.)

**Escalation is consensus-based, not tit-for-tat.** When a genuine contradiction survives, it
escalates the report that has **zero corroborations** — and only when its opponent has *strictly
more*. A tie (notably both at zero) escalates *neither*. This means the community's weight of
evidence decides who's out of step, not who reported first.

The escalation touches exactly one private field:

- **`contradictionCount`** — a private, non-scoring, **self-correcting** tally: **+1** on a fresh
  contradiction, **−1** when one later resolves, **clamped at 0**. Never shown to anyone, never
  part of the trust number.
- At **`CONTRADICTION_FLAG_THRESHOLD = 3`**, the *only automatic action* is filing a
  `contentFlags` row (reason `unsafe_false_report`, deduped to one open flag per author) for the
  **mod queue**. It targets the *pattern*, not the incident.

That's the end of the automatic path. A human then decides.

---

## D57 — posting permissions (the human's lever)

The moderator's response to a flagged pattern is a posting restriction, enforced in
`packages/convex/convex/lib/auth.ts`:

- **`canPostReports` / `canPostHazards`** — two booleans on the profile, asserted at create time
  (`assertCanPostReports` / `assertCanPostHazards`).
- **Fail-open:** absent ⇒ **allowed**. The default for every adult is unrestricted posting;
  restriction is an explicit, deliberate act.
- **Human-only:** *nothing in the codebase ever auto-sets these.* They're written solely from the
  Phase-7 admin surface. The contradiction signal routes a pattern *to* a human; the human flips
  the boolean.
- The report path also requires `assertCanPostHazards` when a report bundles/attaches hazards, so
  a hazard restriction can't be bypassed by posting hazards *through* a report.

This is the payoff of the two-axis design: automation is good at *spotting patterns* and bad at
*judging intent*, so it only ever escalates to a human — it never punishes.

**Planned extensions (not yet built).** The per-capability pattern generalizes, but each lever's
*shape* matches the abuse it answers rather than blanket symmetry:

- **`canPostComments`** — a planned 3rd boolean (Phase 7). Comments are free-text content, so a boolean
  fits; it lets a moderator mute a toxic commenter *without* silencing their useful safety reports —
  something neither a [block](#blocking-mute) nor a whole-app suspend can express. Would gate
  `comments.create` via an `assertCanPostComments` mirroring the two above.
- **Bounties get no boolean.** Bounty abuse is *volume*, not content (a bounty has no free-text payload
  and is already hard-capped at 3 open / 24 h), so the fitting lever — if one is ever needed — is a
  per-user override of that cap (`activeBountyPostLimit`, `0` ⇒ can't post), not a `canPostBounties`
  flag. Deferred until a real spammer earns it.

---

## Ratings & auto-moderation

Thumbs are polymorphic (`RATING_TARGET_TYPES = ['report', 'hazard']`). One quality lever:

- **`AUTO_LOW_QUALITY_NET_UNHELPFUL = 3`** — when `unhelpful − helpful` reaches 3, the target is
  routed to the mod queue via an `auto_low_quality` flag. It is **never hidden** — safety content
  visibility is not gated by score (D3); the flag just surfaces it for a human.

---

## Blocking (mute)

Blocking is the one *interpersonal* control, and it's shaped by the same D3 rule as everything
else: **an interpersonal grudge must never pull a safety observation off the map.** A block is a
single **bidirectional** row (D32) — "hide this person from me *and* me from them" — with no follow
graph to unwind (there isn't one, D13). **Block == mute**: there's no separate mute feature. You
can't block yourself (rejected server-side); re-blocking is idempotent.

### What a block affects

| Surface | Effect |
|---|---|
| **Profiles** (both ways) | the other user's profile reads as *not found* — in direct lookup and in search — in both directions |
| **Comments** | a blocked author's comments are hidden from you (a hidden comment with replies keeps a placeholder so the thread doesn't collapse) |
| **Author lines** | a blocked author's report/hazard line is *de-emphasized* with a "Blocked" chip — a display annotation, not a gate |
| **Thumbs-down** | a `unhelpful` thumb *across a block relationship* is silently discarded (a likely grudge); a legitimate existing vote is left untouched, and thumbs-**up** always count |

The block set that drives all of this is unioned across **both** directions (I blocked them OR
they blocked me) by `loadBlockedAuthorIds` — the single source, so comments, profile access, and
the author-line chip can't disagree.

### What a block does **not** affect — and why

**A block never hides the other person's reports or hazards.** This is the deliberate, load-bearing
choice (D3, Phase 3). Report and hazard reads gate on **moderation status only** — never on the
block set. The reasoning is stark: an open-water pin or a thin-ice report is a fact about the
*commons*, and the person most likely to be near a danger you reported might be someone you happen
to have blocked. Pulling a real hazard off *their* map because of an interpersonal dispute could
get someone hurt. So:

> Blocking controls whose *personality* you have to deal with — profiles, comments, author lines —
> **not** whose *safety observations* you're allowed to see. The commons stays whole.

If a report is genuinely false or abusive, that's a **moderation** problem (flag it → the mod
queue → a human), not a blocking one. The two axes are kept separate on purpose: a moderator hiding
content is a safety judgment; a user blocking someone is a personal one, and the personal one is
never allowed to make safety content disappear. Minors can block too — it's self-protective (see
[minors & age policy](./minors-and-age-policy.md#what-a-minor-can-do-and-an-honesty-note)).

---

## Badges (D50 decision 6)

Cosmetic, and **every count-based badge gates on a quality signal, never raw volume.** Tiered
via a `{ first, step }` family — earned at `first`, then again at `first + step`, `first + 2·step`,
… The tier count is *derived*, so retuning a step never orphans a stored badge.

| Badge | first / step | Earned for |
|---|---|---|
| `trusted_reporter` | 1 / 5 | reports with ≥2 helpful thumbs |
| `bounty_hunter` | 1 / 5 | bounties fulfilled with a qualifying report |
| `appreciated` | 10 / 15 | helpful thumbs across reports + hazards |
| `hazard_spotter` | 1 / 5 | hazards confirmed *and* thumbed helpful by ≥2 people |
| `watchdog` | 10 / 10 | others' hazards you confirmed or thumbed |
| `corroborator` | 1 / 5 | your report independently corroborated an accurate report |
| `straight_shooter` | 1 / 5 | an honest "don't skate" report marked helpful |
| `measured` | 3 / 5 | reports carrying measured (not estimated) thickness |

---

## The recommended feed

The one place trust does real work: an "exceptional" report can break the viewer's distance /
quality / thickness filters. The gate is **trust + corroboration, never a lone great report** —
otherwise we amplify one unverified claim and build a machine for wasted trips (D3):

| Constant | Value |
|---|---|
| `RECOMMENDED_MIN_CORROBORATION` | 3 (corroborationCount > 2) |
| `RECOMMENDED_MIN_TRUST_CLASS` | `expert` |
| `RECOMMENDED_MIN_PHOTOS` | 2 |
| `RECOMMENDED_RECENCY_HOURS` | 48 |
| `RECOMMENDED_MAX_BODIES_PER_DAY` | 2 (frequency cap + dedup) |
| `RECOMMENDED_BUNDLE_SIZE` | 2 (reports per card when several qualify) |

It breaks filters but **never** recency, blocks, or moderation.

---

## What's deliberately absent

- **No penalty, no negative reputation, no "distrusted" tier** — boost-only, clamped at 0.
- **No automatic posting restriction** — the contradiction signal escalates to a human; only a
  human flips the D57 booleans.
- **No score-based hiding** — low ratings and contradictions route to a mod queue; they never
  hide safety content (D3).
- **Trust and bounty currencies never mix** — `reputationPoints` vs `bountyPoints`.
