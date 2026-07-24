---
name: phase-7-operator-surface
description: Phase 7 (operator surface — admin/moderation/analytics) status, architecture, and the key build calls
metadata:
  type: project
---

**Phase 7 — operator surface** ✅ COMPLETE on dev (prod deferred) 2026-07-24. Two PRs: **7a operator core** (merged, #24) + **7b analytics & tuning** (branch `phase-7b-analytics-tuning`). The founder-facing back office: role-gated `/admin` route tree in the web app (D37), in-context moderation, in-house Convex analytics, read-only tuning control-room. See `plans/phase-7-operator-surface.md` (authoritative) + `plans/07-roadmap.md` Phase 7.

**Role model:** `member | moderator | admin`. Moderators get the full content+safety toolkit incl. ban/suspend/unban, `curatedBoost`, `bodyFeatures`; **admin-only line = role-granting, support/PII, tuning/constants**. Every mutation gates on `role` server-side + writes one `moderationActions` row.

**7b analytics architecture — the core design:** charts NEVER scan the live corpus (the [[pr4-fix-listinviewport-first]] read-cap lesson generalized). Two tables: `metricSnapshots` (one row per metric+UTC-day; daily rows kept forever) + `bountyGateEvents` (forward-only, one per bounty-create attempt, **carries `requesterId`**, pruned 180d). Vocabulary single-sourced in `@skating/core/metrics.ts` (like [[phase-6-bounties-trust]]'s reputationConfig). Three write channels: **rollup** (cron, backfillable), **maintain-on-write counter** (event site, for events that leave no trace — contradiction funnel, flag dispositions), **client signal** (`analytics.recordClientSignal`, allowlisted+authed, only the future-skate rejection the server can't see). Crons: 6-hourly rollup (recomputes today+yesterday, idempotent), weekly corpus sweep (self-chaining paginate), daily gate-event prune.

**Key build calls / gotchas:**
- **The bounty gate had to STOP THROWING to be observable.** A thrown Convex mutation rolls writes back, so a throwing gate could only log ALLOWED attempts. `bounties.createChecked` now RETURNS its verdict (`{ok:false, decision}`) and `create` re-raises it; `bountyFreshnessInputs` returns `capped`/`unavailable` instead of throwing. Auth failures (minor/anon/missing) still throw (not tuning signals). Cap checked BEFORE freshness.
- Two planned metrics changed shape to stay honest: `viewport_truncated`→`zoom_band_distribution` (client can't observe truncation — post-query refine drops rows); `weather_strip_renders`→`weather_strip_coverage` (strip state is client-side).
- Constants are **read-only in-dash** (settled decision #1): founder edits the constant in `@skating/core` + redeploys. `/admin/tuning` shows live value + chart + "requires a redeploy". `appConfig` override table = documented future seam, NOT built.
- Chart kit: **Recharts** in `apps/web/src/components/charts/`; palette **validated with the dataviz skill's checker** (not eyeballed), light + stepped-dark orders. Every categorical chart has a legend + "view as table" (D34). Web test setup needs `matchMedia` + `ResizeObserver` stubs for charts to mount.
- Contributor-trust trend (`analytics.contributorTrend`, D57) is **moderator-visible** (their lever's input) but returns good-vs-bad-per-month + `accountCreatedAt`, NEVER raw reputation (D50 admin-only). Bad = settled contradictions + UPHELD flags only (open/dismissed = accusation, not finding).

**Post-review fixes (2026-07-24, folded into 7b before PR):** (1) rollup was one fat mutation — SPLIT into per-transaction scheduled jobs: `runRollup` fans out `rollupDayJob`×2 + 3 point-in-time chunks (distributions/activity/operational) via `runAfter(0)`; `backfill` self-chains one day/txn via `backfillStep`. Reason: sum of scan caps > Convex's ~16k-doc per-transaction budget at scale. Tests invoke each job directly (that's how prod runs them) + assert fan-out wiring via `_scheduled_functions`. (2) `recordClientSignal` now per-user rate-limited (≤10/hr, `clientSignalEvents` table pruned daily, drops silently over cap). (3) contradiction funnel metrics relabeled — `detected` counts PAIRS, `escalated` counts REPORTS; not a strict subset chain.

**Dedup review queue = near-empty until Phase 8** (match-on-create is Phase 8); merge mutation + UI built now.
