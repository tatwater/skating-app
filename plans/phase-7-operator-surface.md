# Phase 7 — Operator surface (admin, moderation, dedup review, analytics)

> **Status:** ✅ Complete on dev (prod deferred), 2026-07-24. PR 7a (operator core) merged as #24;
> PR 7b (analytics & tuning) on branch `phase-7b-analytics-tuning`. All green: core 653 / convex 480 /
> web 152 / mobile 76. Detailed build plan for the roadmap's Phase 7 (D37/D38 + the D49/D52/D56/D57
> tuning surfaces). Decisions settled with the founder in the 2026-07-23 planning session — see
> **Settled decisions** below; **build deltas are recorded in `07-roadmap.md` → Phase 7**.
>
> **The one-line shape:** a **role-gated `/admin` route tree inside the existing web app** (D37 — not
> a second app), mobile-responsive but web-only (no Expo surface), organized as **work queues +
> a read-only "control-room" of every tunable constant paired with the chart that tells you if it's
> set right.** Most of the *backend* (roles, audit log, flag/support/dedup schema, posting-permission
> enforcement, takedown mutations) already shipped in Phases 3/6/9/10 — Phase 7 is mostly the **admin
> UI + the admin-facing query/queue layer + user-lifecycle mutations + analytics instrumentation.**

---

## Settled decisions (2026-07-23 planning session)

1. **Config = read-only "control-room," no `appConfig` override table (v1).** The founder works with a
   coding agent, so *editing a constant in `@skating/core` and redeploying is the tuning workflow* —
   preferred over breaking flow to tweak a dashboard field. Therefore:
   - Global constants (`HAZARD_DECAY`, `FRESH_REPORT_HOURS`, `BOUNTY_REOPEN_*`, `POINT_WEIGHTS`,
     `TRUST_CLASS_THRESHOLDS`, the `display.ts` curve, …) stay **in code**. The dashboard renders each
     one **read-only** — live value + plain-language explanation + its companion chart — with a locked
     field and the note *"Defined in `packages/core/src/<file>.ts` · changing this requires a redeploy."*
     The web app already imports `@skating/core`, so surfacing the live values needs **no backend**.
   - The **already-runtime, per-row levers stay editable in-dash** because they're *data*, not constants:
     `curatedBoost`, `weatherSamplePoints`, `canPost*` permissions, `ban/suspend/role`, `bodyFeatures`
     promote/demote.
   - `appConfig` is a **documented future seam** — promote a single constant to a runtime override only
     when a real "change without redeploy" need appears (e.g. bumping a bounty reopen threshold from a
     phone during a live thaw). Not built speculatively.
2. **Analytics stay in-house (no PostHog this phase — D29 stays deferred).** New Convex tables only.
3. **Forward-only instrumentation is acceptable.** Charts that need event data we've never logged (the
   bounty-gate scatter) start empty and fill going forward; charts computable from existing rows (bounty
   expiry) are backfilled.
4. **Charts = shadcn/ui `chart` components (Recharts underneath).** shadcn is the house component DX;
   its `chart` primitive wraps Recharts and themes off our design tokens. No bespoke SVG, no raw Recharts.
5. **Two PRs** (per the "bundle-by-phase, split when it helps" rule; Greptile is metered):
   - **PR 7a — Operator core:** route tree + chrome, admin queue queries, user-lifecycle + merge +
     support mutations, `canPostComments`, Resend alerts, audit.
   - **PR 7b — Analytics & tuning:** `bountyGateEvents` + `metricSnapshots`, the cron rollups, the
     control-room + charts.
6. **Contact-support / report-a-bug ships on BOTH web and mobile** (the one Expo-touching bit — a
   *submission* path, not the operator surface). Appeals/reinstatement reuse `supportTickets`
   (`category: account`), not a new table.
7. **Founder bootstraps their own `admin` role** via the Clerk/Convex dashboards (no seed mutation
   needed).
8. **Dedup review may be near-empty until Phase 8** (match-on-create + user-drawn bodies is Phase 8).
   Build the merge mutation + queue UI now (schema's ready, cheap); expect ~zero rows until Phase 8.
   See **Phase-8-deferred** checklist.

---

## What already exists (do NOT rebuild)

Prior phases shipped most of the operator *backend*. Verified against `packages/convex/convex` on
2026-07-23:

| Capability | Where | Status |
|---|---|---|
| Role model `member\|moderator\|admin` + `requireRole(ctx, min)` | `lib/auth.ts`; `profiles.role` (schema.ts) | ✅ |
| `status` (`active\|suspended\|banned\|deleted`) + `statusReason` + `suspendedUntil` + `moderatedByUserId` | `profiles` (schema.ts) | ✅ (fields only — **no ban/suspend mutation yet**) |
| Posting perms `canPostReports`/`canPostHazards` + `assert*` enforcement | `lib/auth.ts`; `reports.create`, `hazards.create` | ✅ |
| `moderationActions` audit table — **all** action enums (ban/suspend/grant_role/merge_waterbody/…) | schema.ts; `lib/enums.ts` | ✅ (table + enums; most actions have **no writer yet**) |
| `contentFlags` table + member-facing `flag` mutation | `contentFlags.ts` | ✅ (**no admin queue query**) |
| Auto-flag paths that FEED the queue: `unsafe_false_report` (contradiction ≥3), `auto_low_quality` (net-unhelpful ≥3) | `contradictions.ts`, ratings | ✅ (produce flags; queue UI missing) |
| `supportTickets` table | schema.ts | ✅ (**no functions at all**) |
| Takedowns: `setModerationStatus` (hide/remove/restore), `resolveFlag` | `moderation.ts` (`requireRole('moderator')`) | ✅ |
| `waterBodies` review/dedup fields + `approve`/`remove`/`restore`/`setCuratedBoost`/`listPendingReview` | `waterBodies.ts` | ✅ (**no merge mutation**) |
| `bodyFeatures` table + `create`/`promote`/`demote` (admin) | `bodyFeatures.ts` | ✅ |
| Put-in admin mutations | `putIns.ts` | ✅ |

**Naming note:** the plan docs say `users.role`/`users.status`; the schema **renamed `users` →
`profiles`** (Clerk owns the auth user; `profiles.clerkUserId = identity.subject`). Follow the code.

---

## What Phase 7 must build

### Backend — new Convex functions/tables

**Admin queue queries (read side — none exist today):**
- `moderation.listFlags` — open/reviewing `contentFlags`, **`unsafe_false_report` pinned to a priority
  lane** (D3/D37), with resolved target context (the report/comment/hazard/photo/user + author). Off
  `by_status`; bounded page size.
- `moderation.listActions` — the `moderationActions` audit trail (filter by actor/target/action), for
  the "recent actions" dashboard panel and per-user history.
- `support.list` — `supportTickets` by `status`/`category` (off `by_status`).
- `waterBodies.listDedupCandidates` — `suspected_duplicate` bodies off `by_dedup_status` (pairs with the
  existing `listPendingReview` for user-body approvals).
- `admin.userSearch` — search `profiles` (the existing `search_profile` index) + a `profiles.getAdmin`
  detail query exposing the **raw** `reputationPoints`/`bountyPoints`/`contradictionCount` (D50: raw
  numbers are admin-only) plus status/role/perms and recent moderation history.

**User-lifecycle + lever mutations (write the already-defined audit actions):**
- `moderation.banUser` / `suspendUser` (sets `suspendedUntil`) / `unbanUser` — **moderator-level** (per
  the 2026-07-23 split); patch `status` + `statusReason` + `moderatedByUserId`, write the
  `ban`/`suspend`/`unban` audit row, **and lock/unlock the Clerk user** (belt + suspenders — Clerk
  Backend API from a Convex action).
- `admin.grantRole` / `admin.revokeRole` — **admin-only**, audited (`grant_role`/`revoke_role`).
- `moderation.setPostingPermission` — flip `canPostReports`/`canPostHazards`/**`canPostComments`**
  (moderator-level; the D57 lever), audited.
- `waterBodies.merge` — the missing D36 mutation: pick survivor, **re-point child `reports`/`hazards`/
  `bounties`** to it, soft-tombstone loser (`dedupStatus: merged`, `mergedIntoId`), audit
  `merge_waterbody`. Read paths already follow `mergedIntoId`; also add `waterBodies.reject` (audit
  `reject_waterbody`) to complete the review triad (`approve` exists).
- `support.create` (**web + mobile**, any signed-in user; pre-auth optional) auto-capturing context
  (appVersion/platform/deviceModel/recent Sentry event id); `support.assign` / `support.resolve` (admin).

**`canPostComments` (D57 extension):** add optional boolean to `profiles`; `assertCanPostComments` in
`lib/auth.ts`; gate `comments.create`. Migration-free (absent ⇒ allowed).

**Operator alerts (D38 — Resend + React Email):** a Convex **action** (Node runtime) that emails the
founder on every new `supportTickets` row and every safety-priority flag (`unsafe_false_report`,
`category: safety`), deep-linking into `/admin`. **All Resend env vars ship as placeholders**; the
action **no-ops (logs) when the key is absent** so it never blocks the build. Founder drops real keys +
verifies the domain at the end (see **Resend checklist**).

### Backend — analytics (PR 7b)

Two tables + a cron, chosen to **avoid the read-cap-fragile whole-corpus-at-read-time trap** (the
`listInViewport` PR#10/#11 lesson):

- **`bountyGateEvents`** (append-on-gate, **forward-only**) — one row per `bounties.create` gate
  decision: `{ waterBodyId, decision: suppressed|allowed|capped, suppressingReportId?, reportAgeH,
  netThumbs, trustClass, weatherReopened: bool, appliedWindowH, createdAt }`. Written from
  `bounties.createChecked`. Raw rows feed the scatter (queried over a bounded window).
- **`metricSnapshots`** (daily cron rollups) — `{ metric, date, scalar?, buckets?: number[], meta? }`.
  A `crons.ts` job computes bounded aggregates once/day (histograms as `buckets`, rates as `scalar`,
  time series as one row/day). Charts read snapshot rows — **never** scan the live corpus. This is the
  Phase-4 contribution-counter "maintain-on-write / sweep-by-cron" pattern generalized to metrics.
- Small, bounded live counts (flag-queue depth, oldest-open age) can be **computed live** off existing
  indexes — no snapshot needed.

### Web — the `/admin` route tree

TanStack Start file-based routing (`apps/web/src/routes/`). Add a **pathless layout** `_admin.tsx`
that role-gates (`profile.role` ∈ {moderator, admin}; some children admin-only) and renders admin chrome
(responsive sidebar → collapses to a drawer on phone widths). Children:

```
_admin.tsx                 → gate + chrome (sidebar/topbar, responsive)
  _admin.index.tsx         → /admin          Dashboard (KPI tiles + recent actions + queue depths)
  _admin.flags.tsx         → /admin/flags    Flag queue (priority lane for unsafe_false_report)
  _admin.users.tsx         → /admin/users    User search
  _admin.users.$id.tsx     → /admin/users/$id  User detail: contributor-trust panel + raw trust #
                                                (admin), ban/suspend/perm controls (mod), role (admin)
  _admin.water.tsx         → /admin/water    Water-body review (approve/reject) + dedup merge queue
  _admin.features.tsx      → /admin/features bodyFeatures promote/demote (from recurring hazards)
  _admin.support.tsx       → /admin/support  Support inbox (+ appeals via category:account) — ADMIN ONLY
  _admin.tuning.tsx        → /admin/tuning   Control-room: constants + charts — ADMIN ONLY
```

- **Route-level gating splits at moderator vs admin.** Moderators reach `index`/`flags`/`users`(+detail)/
  `water`/`features`; **`support` and `tuning` are admin-only** (PII + constants). The `_admin` layout
  redirects a moderator off an admin-only child, and the sidebar hides links the caller can't use. The
  server still hard-gates every underlying function regardless of what the client renders.
- Add shadcn `chart` component (Recharts) to `apps/web/src/components/ui/` via the shadcn CLI; theme via
  `@skating/design` tokens; honor dark mode + a11y (D34).
- Gate the AppShell nav link with the existing `useIsModerator()` hook (`src/components/ModeratorActions.tsx`).
- **Contributor-trust panel** (D57): the private `contradictionCount` shown *alongside* a **tenure-aware
  good-vs-bad trend** — **bad** = weather-unexplained contradictions + upheld `unsafe_false_report`
  flags; **good** = corroborated + net-helpful-thumbed reports; plotted per-month against account age so
  a 10-yr contributor and a 1-mo account with the same raw count are distinguishable at a glance.
  Visible to **moderators** (it's their D57 lever's input); the **raw `reputationPoints` number stays
  admin-only** (D50).

### Web — in-context moderation (outside `/_admin`, web only)

The operator surface is **not only** the `/_admin` tree. A moderator reading the app normally must be
able to **act from where they are** — see a hateful comment in a thread, hide it *there*; open a report
drawer with a dangerously-false "ice is great" claim, take it down *there* — without hunting for it in a
queue. This is the natural extension of the already-shipped `src/components/ModeratorActions.tsx` (a
role-gated Hide/Remove dialog already dropped into report/comment views). Phase 7 **broadens that pattern
across the web app's existing surfaces** (web only — mobile has no operator affordances):

- **Report drawer / hazard pin / comment / photo:** hide / remove / restore + resolve-flag inline (extend
  `ModeratorActions`), plus a "flag context" peek (why it's flagged, by whom).
- **Profile / `u.$username`:** posting-permission toggles (`canPost*`, D57), ban / suspend / unban, and a
  link into the full `/admin/users/$id` detail.
- **Water-body detail (`_map.water.$id`):** set `curatedBoost`, and start a merge / approve-reject from
  the body itself.
- **Hazard pin:** promote a recurring hazard into a `bodyFeature` (D53) in place.

Every affordance renders `null` for non-operators (the existing `useIsModerator()` guard) and calls the
**same server-gated mutations** as the `/admin` tree — the dashboard and the in-context controls are two
front-ends over one audited backend. Admin-only actions (role grant/revoke) never appear in-context.

---

## Analytics spec — every magic number ↔ the chart that tunes it

`[CORE]` = built in PR 7b now. `[LATER]` = documented, built when corpus/traffic justifies.
Constants cited by their `@skating/core` names.

**Bounties** — `FRESH_REPORT_HOURS=48`, `BOUNTY_REOPEN_FREEZING_DEGREE_HOURS=180`,
`BOUNTY_REOPEN_THAW_DEGREE_HOURS=120`, `MAX_OPEN_BOUNTIES_PER_DAY=3`, `DEFAULT_BOUNTY_LIFETIME_MS=30d`,
`DEFAULT_BOUNTY_REWARD_POINTS=10`, `BOUNTY_ELIGIBILITY_WINDOW_HOURS=72`
- **[CORE]** Bounty **outcome funnel + expiry-without-fulfillment rate + time-to-fulfillment histogram**
  (the founder's motivating example; **backfillable** from existing `bounties` rows). Tunes lifetime /
  reward / eligibility window.
- **[CORE]** **Gate-decision breakdown** from `bountyGateEvents` (forward-only): suppressed-by-freshness
  vs capped-by-daily-cap vs allowed. Tunes `FRESH_REPORT_HOURS` + the cap.
- **[CORE]** The roadmap's two charts: **scatter** of *report age at attempt* vs *applied window* (dots
  above line = blocked), and the **weather-reopen-rate** time series. Tunes `BOUNTY_REOPEN_*`.

**Trust & points** — `TRUST_CLASS_THRESHOLDS {trusted:15, expert:60, leader:150}`,
`NEW_ACCOUNT_WINDOW_MS=14d`, `POINT_WEIGHTS`
- **[CORE]** **Reputation-points histogram across active users** with the 15/60/150 cutoffs overlaid —
  the single best view for whether class thresholds bunch or spread people.
- **[CORE]** **Point-source composition** (thumbs vs corroboration vs submission share). Tunes
  `POINT_WEIGHTS` so volume can't masquerade as trust.
- **[LATER]** Trust-class transition counts / new→trusted conversion within `NEW_ACCOUNT_WINDOW_MS`.

**Enforcement** — `CONTRADICTION_FLAG_THRESHOLD=3`, weather gate `48 FDH / 36 TDH`,
`AUTO_LOW_QUALITY_NET_UNHELPFUL=3`, `CORROBORATION_WINDOW_MS=7d`, `CORROBORATION_MAX_PER_REPORT=3`,
`HAZARD_CORROBORATION_MIN_CONFIRMS=2`
- **[CORE]** **Candidate-contradiction funnel**: detected → dropped-by-weather-gate → survived →
  auto-flagged → human **upheld vs dismissed**. If the weather gate explains away almost everything,
  `48/36` is too permissive; if most auto-flags get dismissed, `3` is too low. (No other way to tune it.)
- **[CORE]** **`contradictionCount` distribution** (also feeds the contributor-trust panel).
- **[CORE]** **`auto_low_quality` flag volume + disposition** — tunes `AUTO_LOW_QUALITY_NET_UNHELPFUL`.
- **[LATER]** Corroborations-per-report distribution (are we hitting the cap of 3? is 7d catching pairs?).

**Hazards** — `HAZARD_DECAY` per-type fresh/aging tiers, `HAZARD_CORROBORATION_MIN_CONFIRMS=2` removal
- **[CORE]** **Per-type confirmation outcomes** (still-here / healing-unsafe / fully-healed) + **age at
  confirmation vs the fresh/aging cutoffs**. If a type keeps getting "still here" past its stale line, it
  decays too fast — the empirical check on the whole D52 research table.
- **[LATER]** Archive-vs-re-report rate (D15 resurface) — high = archiving too eagerly.

**Display / map** — `DISPLAY_AREA_MIN/MAX_SQM`, `minVisibleZoom` curve, `curatedBoost`,
`MAX_VIEWPORT_LIMIT` *(256 when this was written; **1,000 since N1**, and now a render budget rather
than a read-cap guard — a viewport read is bounded by the cell index, not by this number)*
- **[CORE-lite]** **Viewport-truncation frequency** — the D5 truncation log **already exists**;
  surfacing how often it fires flags when the render budget / curve is dropping bodies. Cheap.
  *(`waterBodies:viewportReadStats` gives the same answer on demand for one viewport.)*
- **[LATER]** Body distribution by `minVisibleZoom` band.

**Recommended feed** — `RECOMMENDED_MIN_CORROBORATION=3`, `_MIN_PHOTOS=2`, `_RECENCY_HOURS=48`,
`RECOMMENDED_MAX_BODIES_PER_DAY=2`
- **[LATER]** Bodies clearing the recommended bar per day vs the daily cap (is the strip usually empty?).

**Operational health** (tunes *the operator*, not a constant)
- **[CORE]** **Flag queue**: open count, oldest-open age, time-to-resolution, safety-lane latency.
- **[CORE]** **Support-ticket** volume by category + resolution time (high value in alpha/beta).
- **[CORE]** **App-health strip**: reports/week, new signups, active contributors — the "how's it going"
  context every operator wants. *(Flagged as missing during planning — not tied to a constant but core.)*

**Drive-time** — `DRIVE_TIME_BANDS 30/60/90`, digest — **[LATER]**: notification opt-in / delivery
rates; low tuning value until notification volume exists.

**Additional stats flagged during planning (track the number even before charting):**
- Bounty **daily-cap hit rate** (`MAX_OPEN_BOUNTIES_PER_DAY`) — the empirical case for the deferred
  `activeBountyPostLimit` lever (D57).
- **Photo-orphan count** — feeds the deferred GC cron decision (roadmap Later).
- **Weather-since strip** render vs `aged` split (`minAgeHours=6`, `maxAgeDays=14`) — low priority.
- **Report-rejected-for-future-skate-time** rate (`SKATE_TIME_FUTURE_TOLERANCE_MS=1h`) — low priority.
- Per-`adminArea`/state **coverage** (bodies + reports) — informs Phase 2.5 regional expansion.

> **Standing ask (founder, 2026-07-23):** as we build, flag anything else worth charting or at least
> tracking as a single numeric stat — "I know there are things we're missing." Add them here.

---

## Role / capability matrix (server-enforced)

Per **D37** (role model refined 2026-07-23): moderators get the full *content + community-safety* toolkit
— including **ban/suspend/unban**, **`curatedBoost`**, and **`bodyFeatures` promote/demote**. The
admin-only line is drawn at exactly three things: **role-granting, support/PII, and constants/tuning**.
D37 in `01-decisions.md` has been updated to match this split.

| Action | moderator | admin |
|---|---|---|
| View queues (flags, dedup, users) | ✅ | ✅ |
| Hide/remove/restore content; resolve/dismiss flags (in `/admin` **and** in-context) | ✅ | ✅ |
| Set posting permissions (`canPost*`, D57) | ✅ | ✅ |
| Approve / reject / merge water bodies | ✅ | ✅ |
| Set `curatedBoost` | ✅ | ✅ |
| Promote / demote `bodyFeatures` | ✅ | ✅ |
| Ban / suspend / unban users | ✅ | ✅ |
| See a user's **raw** trust/bounty/contradiction numbers | contradiction panel only | ✅ (all raw #s, D50) |
| Grant / revoke roles | — | ✅ |
| Support inbox / `/admin/support` (PII) | — | ✅ |
| Tuning control-room / `/admin/tuning` (view + constants) | — | ✅ |

**Code impact:** `waterBodies.setCuratedBoost` and `bodyFeatures.create`/`promote`/`demote` are
`requireRole('admin')` today — **drop them to `requireRole('moderator')`.** New ban/suspend/perm
mutations gate at moderator; role-grant/revoke and support/tuning stay admin. Every mutation gates on
`role` **server-side** and writes exactly one `moderationActions` row.

---

## Commit breakdown

**PR 7a — Operator core**
1. `canPostComments` field + `assertCanPostComments` + `comments.create` gate (+ tests).
2. **Re-gate to moderator:** `setCuratedBoost` + `bodyFeatures.create`/`promote`/`demote` from admin →
   moderator (+ update tests).
3. Admin queue **queries** (`listFlags` priority-lane, `listActions`, `support.list`,
   `listDedupCandidates`, `userSearch`/`getAdmin`).
4. User-lifecycle **mutations** — `banUser`/`suspendUser`/`unbanUser` (**moderator**) + Clerk lock action;
   `grantRole`/`revokeRole` (**admin**); `setPostingPermission` (moderator) — all audited (+ tests).
5. `waterBodies.merge` + `reject` (re-point children, soft-tombstone, audit) (+ tests).
6. `supportTickets` functions: `create` (web + mobile) / `assign` / `resolve` (admin).
7. `_admin` route tree + chrome + queue/detail/support/water/features pages, moderator-vs-admin route
   gating (no charts yet).
8. **In-context moderator affordances** across web app views (extend `ModeratorActions` to profiles,
   water bodies, hazards, photos) — same server-gated mutations, web only.
9. Resend action + React Email templates behind **placeholder env** (no-op without key).

**PR 7b — Analytics & tuning** *(built as 7 commits, 2026-07-24)*
1. `metricSnapshots` + `bountyGateEvents` schema + the `@skating/core` metric vocabulary + write helpers.
2. Instrument the bounty gate — refactor `createChecked` from throw-to-reject into a returned decision
   so `suppressed`/`capped` events survive the transaction; append one gate event per attempt.
3. Maintain-on-write counters for the events that leave no trace (contradiction funnel, flag
   dispositions, future-skate-time rejections via a narrow client signal).
4. `analyticsRollup.ts` — the 6-hourly rollup + weekly corpus sweep + daily gate-event prune + backfill.
5. The admin read layer (`series`/`latest`/`catalogue`/`bountyGateScatter`) + the tenure-aware
   `contributorTrend`.
6. The themed Recharts chart kit (dataviz-validated palette) in `components/charts/`.
7. `admin.index` app-health strip + `admin.tuning` control-room + the contributor-trend panel on
   `admin.users.$id`.

**Naming note:** 7a shipped the route tree as **pathful `admin.*.tsx`** files (not the pathless
`_admin.*.tsx` sketched below) — TanStack resolves the gate + chrome from `admin.tsx` all the same.
Follow the code.

---

## Phase-8-deferred (dedup) — ✅ RESOLVED 2026-07-24

> **Phase 8 shipped the producer.** `waterBodies.create` is no longer a scaffold: it takes a recorded
> `activityId`, derives the polygon from the trusted path, runs `findMatchCandidates`, and stamps
> `dedupStatus` / `duplicateCandidateIds` — so the merge queue built here finally has rows flowing
> into it. `DEDUP_STATUSES` gained **`near_certain`** and `listDedupCandidates` surfaces both tiers,
> near-certain first. **Still deferred** (unchanged): the re-ETL overlap scan, auto-merge of
> very-high-confidence pairs, and community "same place?" confirmations. Original note follows.

Dedup review will be near-empty until Phase 8 ships match-on-create + user-drawn bodies (`waterBodies.create`
is still a scaffold with no dedup). Built now: the **merge mutation + review-queue UI**. Deferred to Phase 8:
- Populating `dedupStatus: suspected_duplicate` + `duplicateCandidateIds` at create time (the
  `findMatchCandidates` bbox + geospatial + Turf IoU / name-similarity scan — D36).
- Re-ETL overlap scan (auto-merge user→official at high confidence).
- Auto-merge of very-high-confidence pairs + community "same place?" confirmations.
The Phase-7 merge UI should degrade gracefully to an empty queue until then.

---

## Resend checklist (founder, at end of build)

- [ ] Create Resend account (D35 free tier); verify the sending **domain**.
- [ ] Set `RESEND_API_KEY` (+ from-address env) in Convex env — replaces the placeholder.
- [ ] Confirm the operator-alert address (founder inbox).
- Until done: the alert action logs-and-skips; no email sends, build unblocked.

---

## Testing (D40, cross-cutting)

- `convex-test` for every new query/mutation (role gates, audit-row-written invariant, merge re-points
  children, ban locks Clerk [mocked], posting-perm assertion).
- Pure rollup/aggregation logic in `@skating/core` where extractable → Vitest unit + property tests.
- Give convex-test/property suites explicit longer timeouts (CI 5s default flakes — see memory).
- Web: role-gate redirect for non-operators; a11y + dark-mode pass on charts (D34).

## Open questions — settled during the build

- **Snapshot granularity/retention** for `metricSnapshots`: **daily rows, kept forever** (one row per
  metric per day is tiny; revisit only if it grows). `bountyGateEvents` — the one append-per-attempt
  table — is **pruned at 180d** by the daily cron, both to bound storage and because it carries
  `requesterId` (don't keep a permanent behavioural record). Days are UTC (`metricDay`).
- **Clerk lock mechanism** — resolved in 7a (`banUser`/`unbanUser` lock/unlock the Clerk user via the
  Backend API from a Convex action; unban fully reverses). Not touched in 7b.
- **Metric channels** (settled during 7b): three ways a number enters the surface — a **rollup** (cron,
  backfillable), a **maintain-on-write counter** (event site, forward-only, for events that leave no
  queryable trace), and a narrow **client signal** (`analytics.recordClientSignal`, allowlisted +
  authenticated, only for the future-skate rejection the server can't see). Nothing that gates content,
  trust, or moderation is ever client-reported.
