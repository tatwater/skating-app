# Phase 6 — Bounties + trust score

> **Roadmap:** [`07-roadmap.md`](./07-roadmap.md) → Phase 6. This is the detailed build plan,
> in the style of the Phase 1/2/2.5/3/4/5 docs.
>
> **What this phase is.** Three deliverables that turn the app from a report firehose into a
> *reputation-aware* community, without ever adding a social graph (D13) or letting status touch
> safety (D3):
> 1. **Bounties** — "request a report for this water body"; notify recent skaters; auto-attach a
>    matching report; the requester's helpful thumb fulfills it (D10/D17).
> 2. **Trust score (D50)** — the asymmetric, **boost-only**, cosmetic reputation signal that stands
>    in for the removed follow graph. Rises from peer **helpful thumbs** and time-windowed
>    **corroboration**; shown as a *class chip*, never a raw number (except to admins).
> 3. **"Recommended" filter-breaking feed** — occasionally surface an *exceptional, corroborated*
>    report that breaks a user's own distance/quality/thickness filters, gated on trust (not a lone
>    `skateQuality == great`), so we never build a machine for wasted trips.
>
> **Status:** 📝 **PLANNED — 2026-07-21.** Greenfield wiring onto pre-provisioned schema: the
> `bounties` / `reportRatings` / `pointEvents` tables and the bounty/rating enums + notification types
> already exist (scaffolded in earlier phases) but nothing writes them yet. `reputationPoints` is
> written `0` at signup and never aggregated; the only existing `pointEvents` write is the
> hazard-confirmation credit. Dev-only; **prod deferred** (same posture as phases 3–5). In-app
> notification rows only — **push delivery stays deferred** repo-wide.
>
> **Build order (per-workstream, web-first on shared surfaces):** **A** `@skating/core` pure logic →
> **B** Convex trust primitives → **C** Convex bounties → **D** Web + Mobile UI → **E** recommended
> feed (last — it *consumes* the trust primitives). See the PR / commit breakdown below.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md). This phase is the build-out of
**D50** (trust score), **D10/D17** (bounties + cosmetic reward), **D44** (bounty eligibility), and the
D3/D13 hard constraints they all inherit.

---

## Decisions locked this session (2026-07-21)

Everything below was settled with the founder on 2026-07-21. Point weights, windows, and thresholds
ship as **tunable constants in one file** (single-sourced the way D49's display curve is), so the
Phase 7 admin UI can bind controls to them and the founder can retune without an engineer. The
**backfill script (§B)** recomputes every derived value from the ledger, so retuning mid-alpha is safe.

### Trust score (D50) — reputation model

1. **`reputationPoints` becomes a real aggregate.** Today it's `0` forever. We add a
   `bumpReputation(ctx, userId, delta)` helper — a direct mirror of `bumpContributionCount` in
   `lib/contributionCounts.ts` (`patch({ reputationPoints: Math.max(0, current + delta) })`) — called
   at **every** `pointEvents` insert. The `pointEvents` table is the audit ledger; the profile field is
   the denormalized running total. This also **retrofits** the existing hazard-confirmation write
   (`hazardConfirmations.ts`), which inserts the ledger row today but does *not* bump the profile.

2. **Starting point weights (approved as a starting point; tunable later):**

   | Ledger `reason` | delta | who earns it | notes |
   |---|---|---|---|
   | `report_submitted` | **+2** | report author | baseline observation; cheap on purpose |
   | `photo_evidence` | **+3** | report author | report carries ≥1 photo; **once per report** |
   | `measured_thickness` | **+3** | report author | report carries ≥1 **measured** (not estimated) reading; **once per report** — rewards rigor |
   | `helpful_thumb` | **+5** | target author | a peer thumbed your **report or hazard** helpful |
   | `report_corroborated` | **+4** | both authors | independent in-window agreement; capped (below) |
   | `hazard_confirmed` | **+1** | the **confirmer** | *existing* — you did a helpful act confirming |
   | `hazard_corroborated` | **+4** | hazard **author** | *new* — your hazard confirmed by ≥2 peers |

   Peer/quality signals (`helpful_thumb`, corroboration) deliberately outweigh raw volume
   (`report_submitted`) — reputation is *earned from the community's reaction*, not from posting a lot
   (D50). **`unhelpful` never writes a point event** (boost-only, D50) — see the moderation path below.

3. **Corroboration algorithm (reflects the founder's weather nuance).**
   - **Boost window is long:** `CORROBORATION_WINDOW = 7 days` (tunable). Agreeing reports over a freeze
     cycle *reinforce* trust, so the agreement window is generous.
   - **"Agrees" test:** `skateQuality` **within one step** (ordinal — different people mean different
     things by each label) **OR** ≥1 **shared ice type**. Overlapping hazard types corroborate hazards.
   - On `reports.create`, scan prior in-window **visible** reports on the same body; for each that
     agrees, award `report_corroborated` to **both** the new author and the prior author (retroactive
     ledger row + `reputationPoints` bump + a `report_rated`-style in-app notice to the prior author).
   - **Self-corroboration excluded** (same author's second report on a body never counts).
   - **Capped at `CORROBORATION_MAX_PER_REPORT = 3`** corroborators counted per report, so a popular
     lake can't inflate one reporter.
   - **Taking trust *away* is deferred to Phase 10.** Per the founder's rule, a *contradicting* report
     only ever counts against someone if it's **same-day (≤24 h) AND the weather held or got
     colder/less-windy** — which needs the Phase 10 weather-since strips (D19) to evaluate honestly.
     So **Phase 6 corroboration is purely additive**; the penalty path lights up with Phase 10.

4. **Helpful/unhelpful thumbs are the manual, human-in-the-loop trust lever — and now cover hazards.**
   `reportRatings` becomes **polymorphic** (`targetType: report | hazard`) so the *same* thumbs UI and
   the *same* one-vote-per-user rule apply to hazards, which ship today with **no rating at all** (only
   the three-tier `still_there / healing_unsafe / fully_healed` confirmations + vote tallies). See
   schema §. *(Alternative the founder floated — a fourth confirmation verdict "this never existed" as a
   de-facto thumbs-down — is **deferred**: it would change the hazard lifecycle math in
   `@skating/core`'s `deriveHazardLifecycle`. We use polymorphic thumbs for UI consistency instead; the
   "never existed" verdict can be revisited later.)*
   - **`helpful`** → `helpful_thumb` point event to the **target's author** + reputation bump.
   - **`unhelpful`** → **never a public penalty** (D50). It accumulates; when a target crosses a
     net-unhelpful threshold it is routed to the mod queue (new `auto_low_quality` `contentFlags`
     reason) but **is not hidden from the UI** (founder call — visibility of safety content is never
     gated by score, D3). The mod queue itself is Phase 7; Phase 6 just writes the flag.
   - **One rating per `(rater, target)`**; a rater **cannot** rate their own content.
   - **Block-aware asymmetry (founder call):** a **thumbs-down** from a user in a block relationship
     (either direction) is **discarded** as a signal (possible grudge); a **thumbs-up** still counts.
     Trust is otherwise **global**, not per-viewer.

5. **Trust is displayed as a class *chip*, never a raw number** (except admins can see the real score).
   - **Profile page:** a color-coded class chip (`New` / `Trusted` / `Expert` / `Leader`). We **never**
     render "Not trusted": a user below the `Trusted` threshold and **past** the New window simply gets
     **no chip**. Since the model is boost-only, scores don't go negative in Phase 6.
   - **Everywhere else** (feed cards, comments, report/hazard authors, bounties): **no chip** — instead
     a **color-coded ring around the avatar** and an optional small **corner badge icon**, matching the
     class color. One shared `TrustAvatar` component.
   - **Starting class thresholds** (placeholders — calibrate once alpha shows the real distribution; the
     backfill script lets us recompute):

     | Class | Chip / ring color | Earned when |
     |---|---|---|
     | *(none)* | — (neutral avatar) | below `Trusted` and past the New window |
     | **New** | slate / gray | account age < ~14 days, or no qualifying signals yet |
     | **Trusted** | blue | ~15+ points |
     | **Expert** | purple | ~60+ points |
     | **Leader** | gold / amber | ~150+ points |

6. **Badges (cosmetic; a small starter set).** `profiles.badges` exists as a free-form `string[]` with
   no vocabulary and no reader/writer today — we define a `BADGE_TYPES` vocabulary and award badges by
   checking thresholds on the relevant events. Every count-based badge **gates on a quality signal** (a
   thumb, a confirmation) — never raw volume — to reinforce accurate/appreciated/safe activity, not
   sheer output.

   | Badge family | Trigger |
   |---|---|
   | **Trusted Reporter** | first report with ≥2 helpful thumbs (or ≥ a trust threshold), then every 5 such reports |
   | **Bounty Hunter** | fulfill a bounty with a qualifying report, then every 5 |
   | **Appreciated** | 10 / 25 / 50 / 75 / 100 … helpful thumbs across reports + hazards |
   | **Hazard Spotter** | first hazard confirmed **and** thumbed helpful by ≥2 people, then every 5 qualifying |
   | **Watchdog** | confirm or thumb 10 / 20 / 30 … hazards reported by other people |
   | **Corroborator** *(added)* | your report independently corroborated an accurate report N times |
   | **Straight-Shooter** *(added)* | an honest **negative** ("don't skate") report marked helpful — rewards safety-culture reporting (D3), so "great ice!" isn't the only path to status |
   | **Measured** *(added)* | N reports carrying **measured** (not estimated) thickness readings — rewards rigor |

### Bounties (D10/D17/D44)

7. **Anyone can post a bounty on any body, but limited to 3 open in a rolling 24 h** (server-enforced
   via the requester's recent `createdAt`s). Reputation does **not** gate who may post; the cap is the
   only junk control, and it nudges users toward lakes they actually care about.

8. **A bounty is blocked on a body that already has a *fresh* report.** A bounty means "no fresh eyes
   lately," so we block creation if there's a **visible report within `FRESH_REPORT_HOURS` = 48 h**
   (tunable). *(Phase 10 upgrade: replace the hard cutoff with a **decay-based freshness score** —
   recency × peer thumbs × author trust × weather-since — so a well-corroborated report suppresses
   bounties longer than a lone stale one, and warming weather reopens them sooner. That's the founder's
   decay idea; it needs weather-since (Phase 10) to be honest, and reuses the hazard decay shape.)*

9. **Eligibility fan-out on create** = authors with a **report** on this body within `windowHours`
   (indexed `reports.by_water_body_skate_end_time` → distinct authors). The D44 **GPS-skate** half of
   eligibility stays dark until **Phase 8**. Notifications are **per-actor `bounty_request` rows
   inserted directly** (not through the body-keyed coalescing queue, which doesn't fit), respecting
   `notificationPrefs.bountyRequest` + `status === 'active'`, never notifying the requester.

10. **Auto-attach + fulfillment.** While a bounty is `open`, a **matching** new report on that body
    (the same "agrees" test as corroboration, minimum bar TBD-simple: any new visible report on the
    body) appends to `bounties.fulfillingReportIds`. The **requester** then rates a fulfilling report:
    a **helpful** rating flips the bounty to `fulfilled` and awards the reward; an **unhelpful** rating
    does nothing to the bounty (it stays `open`). The requester may also **cancel** (→ `cancelled`).

11. **Bounty reward is a *separate currency* from trust (founder call).** Fulfilling a bounty awards
    `bounty_fulfilled` points to a **new `bountyPoints` counter**, **never** `reputationPoints`. This
    keeps the trust model purely about report/hazard accuracy while giving bounties their own
    achievement layer (feeds future badges). `bounties.rewardPoints` **is** the `bounty_fulfilled`
    delta written to the fulfilling report's author — reconciled, so nobody is double-counted.

12. **Expiry cron.** A new `internal.bounties.expireBounties` sweep flips `open → expired` past
    `expiresAt`. Default lifetime **~30 days** (tunable; a Phase 7 admin field). Needs a **new index**
    `bounties.by_status_expires` (the existing index is body-keyed, so a global sweep would full-scan).

### Recommended feed (moved here from Phase 4)

13. **A separate query the client interleaves — *not* spliced into the paginated `listFeed`.** Injecting
    an off-chronological row into a cursor-paginated stream fights the cursor; `FeedCardData` has no
    `kind` discriminator today, so a server splice would force a union into the page. Instead, a
    dedicated `feed.recommended` query returns 0–2 items; the client renders them as **visually
    distinct** cards near the top ("Recommended — exceptional ice outside your usual range"). Mobile
    already models a `header | card` union (`FeedListItem`), so a `recommended` variant slots in.

14. **The "exceptional" bar is trust/corroboration, not a lone great report** (D3 — otherwise we'd
    amplify one unverified claim and build a machine for wasted trips). All thresholds tunable:
    `corroborationCount > 2` **AND** author trust ≥ **Expert** **AND** ≥2 photos **AND**
    `skateQuality == great` **AND** `iceTypes` includes `black_ice` **AND** a recency floor. It **breaks
    distance / quality / thickness** filters but **never recency, blocks, or moderation**.

15. **Frequency caps + dedup (server-tracked).** ≤2 **unique bodies per user per day**; if multiple
    reports qualify for the same lake, **bundle the top-2** into one recommended card. State lives in a
    per-user `lastRecommendedAt` + a recently-recommended body set (server-side, more reliable than
    client session state). *(Per-day is cleanly enforceable; the "1–2 per hour of browsing" pacing is
    deferred — start per-day and add session pacing only if it feels too sparse.)*

---

## Schema changes (all migration-aware — see `06-data-model.md`)

Tables `bounties`, `reportRatings`, `pointEvents` already exist; most of this is **field/index/enum
additions**, all optional-or-defaulted so existing dev rows migrate free.

- **`profiles`**
  - `reputationPoints` — **already exists** (number, non-optional). No schema change; it starts being
    *aggregated* for the first time.
  - `badges` — **already exists** (optional `string[]`, unused). Gets a `BADGE_TYPES` vocabulary + a
    writer/reader.
  - **add `bountyPoints: v.optional(v.number())`** — the separate achievement currency (decision 11).
    Optional ⇒ migration-free; treated as `0` when absent.
- **`reportRatings` → polymorphic (decision 4).** Today: `reportId`. Change to a target discriminator:
  - **add `targetType: literals(RATING_TARGET_TYPES)`** (`['report','hazard']`) and
    **`targetId: v.string()`** (holds a `reports` or `hazards` id); keep `bountyId?`, `verdict`,
    `raterId`, `createdAt`. Replace the `by_report` / `by_rater_report` indexes with
    `by_target` (`['targetType','targetId']`) and `by_rater_target` (`['raterId','targetType','targetId']`)
    for the one-vote-per-user point lookup. Dev has **zero** rating rows today, so the migration is a
    pure schema swap (no backfill of legacy `reportId`).
- **`pointEvents`** — add reasons **`hazard_corroborated`** (author-side hazard boost) and
  **`measured_thickness`** (per-report rigor boost, once per report) to `POINT_EVENT_REASONS`
  (decision 2). `bounty_fulfilled` already exists (routes to `bountyPoints`, not `reputationPoints`).
- **`bounties`** — add index **`by_status_expires` (`['status','expiresAt']`)** for the expiry sweep
  (decision 12). Fields already exist.
- **`contentFlags`** — add reason **`auto_low_quality`** for the net-unhelpful mod-routing path
  (decision 4). Written by the ratings mutation; consumed by the Phase 7 queue.
- **New enums (`lib/enums.ts`):** `RATING_TARGET_TYPES`, `BADGE_TYPES`, `TRUST_CLASSES`
  (`['new','trusted','expert','leader']`). `POINT_EVENT_REASONS` gains `hazard_corroborated` +
  `measured_thickness`; `FLAG_REASONS` gains `auto_low_quality`.
- **New constants module** (single-sourced, Phase-7-tunable): point weights, `CORROBORATION_WINDOW`,
  `CORROBORATION_MAX_PER_REPORT`, class thresholds + colors, badge thresholds, `FRESH_REPORT_HOURS`,
  bounty lifetime, `MAX_OPEN_BOUNTIES_PER_DAY`, recommended-feed thresholds + caps.

---

## `@skating/core` (pure logic first, 100% coverage — D40)

Safety-adjacent reputation math is pure and heavily tested before any Convex wiring.

- **`reputation.ts`** — `POINT_WEIGHTS` constants; `deriveTrustClass(points, accountAgeMs) → TRUST_CLASS | null`
  (the threshold + New-window logic, decision 5); `reportsAgree(a, b)` (skateQuality within-one-step ||
  ice-type overlap, decision 3); `hazardsAgree(a, b)` (type overlap); `hasMeasuredThickness(report)`
  (≥1 reading with `method === 'measured'` — gates the `measured_thickness` award, decision 2);
  `TRUST_CLASS_COLORS`.
- **`badges.ts`** — the badge threshold table + `deriveEarnedBadges(stats) → BadgeType[]` (pure over a
  stats bag: helpful-thumb count, qualifying-report count, bounties fulfilled, hazards confirmed, …).
- **`bounties.ts`** — `isBodyFreshForBounty(reports, now, freshHours)` (the recency gate, decision 8);
  `withinDailyBountyLimit(recentCreatedAts, now, cap)` (decision 7).
- **`recommended.ts`** — `isRecommendable(report, authorTrust, thresholds)` (decision 14) +
  `rankRecommendations(...)` + the ≤2-bodies/bundle-top-2 selection (decision 15).

---

## Convex backend

- **`lib/reputation.ts`** — `bumpReputation` / `bumpBountyPoints` (mirror `bumpContributionCount`); an
  `awardPointEvent(ctx, { userId, reason, refId, delta })` router that inserts the ledger row **and**
  bumps the right counter (trust reasons → `reputationPoints`; `bounty_fulfilled` → `bountyPoints`);
  a `checkAndAwardBadges(ctx, userId)` that recomputes earned badges from live stats and patches
  `profiles.badges`. **Retrofit** `hazardConfirmations.ts` to route its existing insert through
  `awardPointEvent` (so it finally bumps `reputationPoints`) and to award the **author-side**
  `hazard_corroborated` when `confirmCount` crosses 2.
- **`ratings.ts`** — `rate({ targetType, targetId, verdict })`: one-vote-per-user (point lookup on
  `by_rater_target`), no self-rating, **block-aware** (discard thumbs-down across a block relationship),
  `helpful` → `awardPointEvent(helpful_thumb)` to the target author + badge check + `report_rated`
  notification; `unhelpful` → accumulate + write `auto_low_quality` `contentFlags` at the threshold
  (never hides). Fires the bounty **fulfillment** check when the rater is the bounty requester.
- **`bounties.ts`** — `create` (daily-limit + freshness gate + eligibility fan-out `bounty_request`
  rows); `cancel`; auto-attach hook invoked from `reports.create`; fulfillment-on-helpful (→ `fulfilled`
  + `bounty_fulfilled` reward to the report author + `bounty_fulfilled` notification); internal
  `expireBounties` sweep over `by_status_expires`.
- **`reports.ts`** — in `create`, after the existing counter bump, award the author's per-report point
  events (`report_submitted`; `photo_evidence` if ≥1 photo; `measured_thickness` if ≥1 measured reading —
  each once per report), then run **corroboration** (scan `CORROBORATION_WINDOW`, award both authors,
  capped) and the **bounty auto-attach** hook.
- **`feed.ts` (or `reports.ts`)** — `recommended` query (decisions 13–15), server-tracked caps.
- **`crons.ts`** — add `crons.interval('expire bounties', { hours: 6 }, internal.bounties.expireBounties, {})`.
- **Backfill (`internalMutation`)** — `backfillReputation`: recompute `reputationPoints` / `bountyPoints`
  / `badges` from `pointEvents` + existing reports/hazards/ratings, so a mid-alpha weight change can be
  replayed. Mirrors `backfillContributionCounts`.

---

## Web + Mobile UI

Per **D47**: **web folds bounties into Map** (no top-level route — a create affordance on a body,
bounty markers/list on the map, `/bounties/:id` detail child route); **mobile gets the Bounties tab**
(currently a placeholder → real create + browse + detail). Build web-first on shared surfaces, mirror on
mobile (Phase 2/3/5 pattern).

- **Thumbs** — helpful/unhelpful control on report **and** hazard detail + cards (both platforms), one
  shared component driving the polymorphic `rate` mutation.
- **Trust display** — a `TrustClassChip` on the **profile** only (replaces the web `TrustScore`
  placeholder widget; mobile's plain "Trust score" stat); a shared **`TrustAvatar`** (colored ring +
  optional corner badge icon by class) used **everywhere else** an author avatar appears (feed cards,
  comments, report/hazard authors, bounties). Admin-only: the raw number stays visible in the
  operator/profile-admin view (Phase 7 surfaces it fully).
- **Badges** — a badge row on the profile.
- **Bounties** — create/browse/detail per platform (above), with the eligibility notification landing as
  an in-app row.
- **Recommended** — the distinct recommended card interleaved near the top of the feed (both platforms).

---

## Testing (lands with the feature — D40)

- **`@skating/core`** 100%: class thresholds + New-window edges, `reportsAgree`/`hazardsAgree`,
  `hasMeasuredThickness` (measured vs. estimated vs. no readings), freshness gate, daily-limit,
  `isRecommendable` + ranking/bundling.
- **`convex-test`**: reputation aggregation (ledger ↔ counter parity + backfill idempotence);
  per-report awards (`report_submitted` / `photo_evidence` / `measured_thickness`, once each per report);
  corroboration (both-author boost, self-exclusion, cap, window edges); polymorphic ratings
  (one-per-rater, no self-rate, block-aware thumbs-down discard, helpful→points, unhelpful→flag no-hide);
  bounty create (daily cap, freshness block, eligibility fan-out), auto-attach, fulfillment-on-helpful,
  cancel, expiry sweep; badge threshold crossings; recommended query caps/dedup.
- **Component tests** for the thumbs control, `TrustClassChip`, `TrustAvatar`, bounty create/detail,
  recommended card. Heavy convex-test cases get an explicit longer timeout (CI 5 s default flakes).

---

## PR / commit breakdown (one PR per phase — memory: bundle-prs-by-phase)

One PR, sub-workstreams as commits (Greptile is metered), sequenced so trust primitives land before
their consumers:

1. **core + schema + constants** — `@skating/core` reputation/badges/bounties/recommended pure logic;
   schema field/index/enum additions; the tunable-constants module.
2. **Convex trust primitives** — `awardPointEvent` + counters + backfill; polymorphic `ratings.ts`;
   corroboration in `reports.create`; hazard retrofit (confirmer bump + author `hazard_corroborated`);
   badge awarding; `auto_low_quality` flag path.
3. **Convex bounties** — create/cancel/auto-attach/fulfill + eligibility notifications + `expireBounties`
   cron + `by_status_expires` index.
4. **Web + Mobile UI** — thumbs; `TrustClassChip` + `TrustAvatar`; badges; bounties surfaces (Map-fold /
   tab).
5. **Recommended feed** — core predicate + `recommended` query + interleaved card (consumes trust).
6. **Docs / status** — this doc's status flip, README pointer, roadmap check.

---

## Out of scope / deferred (logged so it isn't lost)

- **Contradiction penalty** on the trust score — Phase 10 (needs weather-since to gate honestly).
- **Decay-based bounty freshness** (recency × thumbs × trust × weather) — Phase 10; Phase 6 uses the
  hard `FRESH_REPORT_HOURS` gate.
- **GPS-skate bounty eligibility** (the D44 second half) — Phase 8.
- **Admin tuning UI** for weights/windows/thresholds/bounty-lifetime — Phase 7; Phase 6 ships them as
  single-sourced constants + the backfill replay.
- **"This never existed" hazard confirmation verdict** — deferred (would touch `deriveHazardLifecycle`);
  polymorphic thumbs cover the thumbs-down need for now.
- **Per-hour-of-browsing recommended pacing** — start per-day; add session pacing only if too sparse.
- **Push delivery** — deferred repo-wide; Phase 6 bounty/rating notices are in-app rows.
- **Prod cutover** — deferred with the rest of phases 3–5.
