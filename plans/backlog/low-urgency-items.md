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
- **GPX import from third parties** (founder, 2026-09-17: "we'll build this soon enough") — let a skater
  who already records with a watch or another app pick a GPX file and file a report from it, the way
  stopping the in-app recorder does. Lands the track in Phase 08's own store (B in the A→B→C
  pipeline) as first-party data the skater brought, so it's legal to draw on the report and
  aggregate — the *file* comes from a third party, the *data* never does (L7 is about pulling from a
  platform's API, not about a user handing us their own export). Needs: a file picker on both
  surfaces, GPX parse in `@skating/core` (tracks → the recorder's point shape, time from `<time>`
  elements, tolerate missing elevation), the same `pathToBody` resolution and dedup the recorder uses,
  and a provenance value so the track says "imported" rather than "recorded here." Pitched in
  [`00-vision.md`](../00-vision.md) § On the ice; no partner approval involved, which is what makes it
  the cheapest of the capture inputs.
