# Low-urgency items — do opportunistically or when a trigger fires

> **Backlog — moved out of `07-roadmap.md` in the 2026-09-16 rewrite, verbatim.** The old 'A08 — the unbundled remainder' list. Genuinely independent, genuinely low-urgency; none is a phase.

- **Apple HealthKit capture adapter** — notable as **the one watch adapter needing no partner
  approval** (entitlement + dev build only), so it's unblocked while Garmin/COROS/Polar wait on review.
  Shares the iOS device-verification dependency.
- **Server-tracked "recommended" caps/dedup** — the impressions store + `acknowledgeRecommended`
  read/write split. Fully designed **including the fail-open guardrail** (never suppress on uncertain
  state); trigger is real data showing the feature feels spammy, plus per-hour pacing if per-day is too
  sparse.
- **Code-level GPS replay rig for CI** — the Android emulator's GPX playback covers manual QA today.
- **First-class in-app avatar upload** — Clerk manages avatars for now; revisit only if its UX bites.
