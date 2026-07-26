# Bounty decay & lifecycle

A bounty is one skater saying **"someone please go get fresh eyes on this lake."** This doc
covers its whole life — when you're allowed to open one, how long a recent report *suppresses*
new ones, how weather reopens them, and when they expire (Phase 6 D10/D17/D44; the decay-based
freshness gate is Phase 10 §7c, D56).

> **Who this is for.** Anyone tuning bounty behavior. The numbers are **admin-tunable defaults**
> (Phase 7) living in `packages/core/src/reputationConfig.ts`, the shared
> [reputation](./user-reputation.md) tuning surface. Note the "decay" here is a *freshness
> window on the suppressing report*, not a decay of the bounty itself.

---

## The mental model

A bounty exists because a lake has **no fresh eyes lately**. So the entire lifecycle turns on one
question asked at create time: *is this body already fresh?* If a recent-enough report covers it,
there's nothing to bounty and create is blocked. Everything below is about making "recent enough"
smart instead of a flat cutoff.

```
  create request
      │
      ├─ daily cap ok?  (≤ 3 open in 24h)                → else blocked
      ├─ body already fresh?  (a report inside its       → if fresh, blocked
      │     decay-based freshness window suppresses it)
      └─ open ──→ fulfilled  (a qualifying report arrives)
             └─→ expired     (30-day lifetime sweep)
```

Two things worth setting straight up front:

- **Bounties don't cost or grant trust to open.** A bounty is a request, not a contribution.
  Fulfilling one grants a *separate* currency (`bountyPoints`), never
  [trust points](./user-reputation.md#how-points-are-earned-point_weights).
- **The "decay" is on the suppressing report.** A fresher, better-corroborated, more-trusted
  report suppresses bounties *longer*; weather that likely changed the ice reopens them
  *immediately*. That weighted window is the interesting part.

---

## The decay-based freshness window (§7c)

Phase 6 shipped a hard cutoff: any report within `FRESH_REPORT_HOURS = 48` blocked a bounty.
Phase 10 replaced that with a **weighted window** — the same 48 h *base*, stretched or shrunk by
how much that report is worth as "fresh eyes" (`packages/core/src/bounties.ts`):

```
windowHours = base × (1 + thumbBoost + trustBoost)          (never negative)
```

- **`base` = `FRESH_REPORT_HOURS` = 48 h.**
- **`thumbBoost` = `clamp(netThumbs, −2, +4) × 0.25`** — each net helpful thumb widens the window
  by a quarter of the base, bounded. Corroboration keeps a report "fresh eyes" longer.
- **`trustBoost` = `TRUST_WINDOW_BOOST[trustClass]`** — a well-trusted local's read stays fresh
  longer; a brand-new account's less:

  | Trust class | boost |
  |---|---|
  | `new` (or null) | −0.5 |
  | `trusted` | 0 |
  | `expert` | +0.5 |
  | `leader` | +1 |

- **`BOUNTY_FRESH_MAX_MULTIPLIER = 3`** — the widest the window can stretch (a leader with max
  thumbs = 3× base = ~6 days). This also sets **how far back the create gate scans** for
  suppressing reports.
- **`BOUNTY_FRESH_MAX_REPORTS = 10`** — cap on suppressing reports evaluated per create (newest
  first), bounding the read fan-out. `OPEN_BOUNTY_SCAN_CAP = 200` caps the open-bounty index scan, and
  the per-body recent-report window is capped alongside it (N1) — both log what they drop.

A body is "too fresh to bounty" when *any* report is still inside its own weighted window (judged
on `skateEndTime`, the freshest read of the ice, so a late-synced offline report still counts by
when the skater was actually out there).

---

## Weather can reopen a bounty early

The point of layering weather onto bounties: if the ice **materially changed** since a suppressing
report, its window collapses to **zero** and fresh eyes are wanted *now* —
`weatherChangedIceSince === true` ⇒ `windowHours = 0`.

Because the create path is a Convex **action** (it can fetch), it resolves the
[weather-since](./weather-since.md) summary per suppressing report and asks
[`weatherExplainsIceChange`](./weather-since.md#weatherexplainsicechange--the-shared-honesty-gate)
— but with **deliberately high thresholds**:

| Constant | Value | vs. the contradiction gate |
|---|---|---|
| `BOUNTY_REOPEN_FREEZING_DEGREE_HOURS` | **180** | vs. 48 — ~1.5× a "full" cold signal |
| `BOUNTY_REOPEN_THAW_DEGREE_HOURS` | **120** | vs. 36 — ~1.3× a full thaw |

Why so much higher than the [contradiction check](./user-reputation.md#the-contradiction-signal-d56-7)'s
48/36? Different questions. The contradiction gate asks "*could* weather explain two reports
disagreeing?" — one cold night is a plausible yes. This gate asks "should a big change reopen a
*well-corroborated* report's bounty early?" — and one ordinary sub-freezing night must **not**, or
the trust/thumbs weighting would collapse for most of the skating season. It takes a solid
multi-day freeze or a real thaw.

**Fail-open:** a failed/empty weather fetch leaves `weatherChangedIceSince` undefined, and the
window falls back to recency × thumbs × trust. "Can't tell" never reopens a bounty.

### The action/mutation split is transactional

Fetching weather forces a split — a Convex mutation can't reach the network, so create is an
**action** that fetches, then hands off to an internal **mutation** (`createChecked`) that writes.
That gap is a classic read-then-write race: a suppressing report could land *after* the action's
weather pass but *before* the insert commits, sneaking an ineligible bounty (and its notifications)
through.

The fix leans on the one-directional nature of the weather signal: **weather only ever *reopens* a
bounty, never creates suppression.** So the action's only job is to decide *which* suppressing
reports the weather has reopened (it passes their ids forward); the actual "is this body fresh?"
verdict is **re-computed transactionally inside `createChecked`** against the reports as they exist
at commit, blocking on any suppressor not in the reopened set. A report that landed during the
fetch is caught there — and because its weather window is near-zero, its plain freshness *is* its
weather-aware freshness, so blocking on it is correct, not merely cautious.

---

## Junk controls & lifetime

The only two non-freshness gates (a bounty is low-stakes, so controls are light):

| Constant | Value | Controls |
|---|---|---|
| `MAX_OPEN_BOUNTIES_PER_DAY` | 3 | max *open* bounties one requester may hold... |
| `BOUNTY_DAILY_WINDOW_MS` | 24 h | ...measured over this rolling window |
| `DEFAULT_BOUNTY_LIFETIME_MS` | 30 days | lifetime before the `expireBounties` sweep flips `open → expired` |
| `BOUNTY_ELIGIBILITY_WINDOW_HOURS` | 72 | how far back "skated here recently" authors are notified on create |

---

## Fulfillment & reward

A qualifying report on the bountied body fulfills it, granting the fulfiller the **separate
achievement currency**:

- **`DEFAULT_BOUNTY_REWARD_POINTS = 10`** → `bountyPoints` (never `reputationPoints`).
- This is what the `bounty_hunter` [badge](./user-reputation.md#badges-d50-decision-6) counts.

Keeping bounty rewards on their own currency is deliberate: fulfilling requests is a distinct kind
of good citizenship from being *reacted to well*, and folding them together would let volume masquerade as trust.

---

## What's deliberately absent

- **No cost/trust to open a bounty** — it's a request, gated only by freshness + the daily cap.
- **No decay of the bounty itself** — the "decay" is the suppressing *report's* freshness window;
  a bounty just sits `open` until fulfilled or the 30-day sweep expires it.
- **Bounty and trust currencies never mix** — fulfillment grants `bountyPoints`, never
  `reputationPoints`.
- **Weather never *extends* a window, only collapses it** — the reopen gate is one-directional
  (fail-open to the trust-weighted window).
