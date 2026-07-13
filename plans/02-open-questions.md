# Open questions

Decisions we're deliberately deferring, with current leanings. Resolved items are
moved to `01-decisions.md`; see the "Recently resolved" list at the bottom for
pointers.

---

## Still open

### Q8 — Forum / Facebook ingestion
Auto-ingesting Google Group / Facebook posts into summarized reports would crush
cold-start, but: FB/Google ToS, scraping/API limits, and consent are real. Strava's
2024 terms also restrict feeding Strava data to AI.
**Direction:** do it legally or not at all; pursue the *maximum legitimately
obtainable* as early as possible. Account/permission setup is deferred in
`05-accounts-and-credentials.md` until a feasibility/legal pass.
**Reply classification:** email threads mix comments and standalone reports; the
proposed AI classifier (on email content, not Strava data) routes each message —
comment vs. new report. See `04-integrations.md`.
**Status:** desired; feasibility + ToS research needed.

### Q9 — AI report summarization (beyond weather facts)
Baseline "weather since report" is now a **decision (D19)** — plain facts, no AI.
Anything further (LLM summarizing multiple human reports) stays deferred: **never**
predict actionable go/no-go (liability), and constrained by Strava AI terms if
Strava-sourced data is involved. **Status:** deferred; make reports great first.

### Q10 — ToS / assumption-of-risk / disclaimers
Needs real legal review before any broad launch. Shapes wording, data retention,
and how reports are framed in-UI.
**Interim (decided):** a signup **assumption-of-risk acknowledgment** (D45), an
**age gate at 16** (D41), and a **temporary privacy notice** (`PRIVACY.md`) cover the
friends alpha. The **License App Store exception** wording (D43) is also legal-gated
here. **Status:** interim guardrails in place; full legal review still required before
broad launch.

### Q11 — Strava-path hazard *deduction* (future edge)
If many skaters' paths on the same day detour around the same stretch, that's a
signal of an unreported hazard (pressure ridge / open water). Noisy (people detour
for many reasons), needs volume + privacy care. **Status:** future bet; logged
because it's a genuine advantage over email forums.

---

## Corpus-derived signals (logged, not committed)

Observations from analyzing 1,197 real community posts (`training_data/google_group/`, see
`08-legal-feasibility-checklist.md` L5a). Not open *questions* — future-facing signals recorded so
they aren't lost.

### S1 — Access / put-ins are a dominant concern
Access language pervades the corpus: `boat launch` (72), `town beach` (43), plus `shore`, `point`,
`beach`, `island`, `access`, and gear/rescue talk (`dry suit` 41, `rescue` 167). Skaters obsess over
**where to park and get on the ice** — which reinforces D18's "refine with put-in points later" note
and D3's safety framing. **Possible future feature:** per-water-body **put-in / access points**
(parking, launches) — not scoped to a phase yet, but clearly wanted. *(Also feeds the D18 drive-time
approximation: testing the actual put-in, not the water-body centroid.)*

### S2 — Big lakes are named by sub-area, spelling varies
Large lakes are referred to by named arms/bays and nicknames, not the parent name: Lake Champlain's
**Malletts Bay** appeared under **10 spellings** (Malletts/Mallets/Mallett's + Inner/Outer), and the
NE arm as **"Inland Sea"** (55). Implication for **D4/D36/D48/D49**: the detector/dedup and the
zoom-scored display should expect **named sub-areas** of one polygon and **spelling variants** — a
big lake isn't one label. Relevant when modeling Champlain-scale bodies + seeding `curatedBoost`.

---

## Recently resolved (see 01-decisions.md)

- **Q1 → D12** — No live GPS; opportunistic location on app-open + post-hoc Strava path.
- **Q2 → D13** — Mutual-follow=friends; 4 visibility levels; optional follower approval.
- **Q3 → D14** — User-created locations allowed (dedup deferred → Q12).
- **Q4 → D15** — Waze-style hazard lifecycle (time-decay + confirmation).
- **Q5 → D16** — Per-type notification toggles.
- **Q6 → D17** — Reward points cosmetic/reputational only.
- **Q7 → D18** — Real drive-time via cached per-user isochrone (radius fallback).
- **Q9 (baseline) → D19** — "Weather since report" = descriptive facts, no AI.
- **Q13 → D24** — All six GPS providers v1-scoped (provider-agnostic); apply for all
  approvals in Phase 0, ship fast-follow (Strava + Apple first, Garmin next, rest follow).
- **Q12 → D36** — User-location dedup: match-on-create (bbox + IoU + name) +
  soft-tombstone merge; v1 moderator queue, community/auto later.
- **Data model (06) → D21–D25** — comments v1, structured ice thickness, dual
  rating, GPS-only skated extent, units/edits/comment-depth.
- **Auth/hosting/nav → D26/D27/D28** — Clerk, Vercel, Map + Newsfeed co-primary.
- **Tooling → D39/D40** — Turborepo monorepo; Vitest + GitHub Actions CI.
- **Privacy/safety → D41/D42/D45** — 16+ age gate & derived visibility defaults;
  EXIF strip + geotag opt-in; signup assumption-of-risk ack.
- **License → D43** — AGPL-3.0 + App Store / Play distribution exception.
- **Skate→lake → D44** — GPS activities resolved to a `waterBodyId` (findable by lake).
