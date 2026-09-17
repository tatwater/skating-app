# Next-gen — GPS-provider partner applications: the longest pole nobody has confirmed is in

> **Jotted 2026-09-16 at the founder's ask, as a reminder rather than a scope.** The roadmap has said
> *"apply for Garmin / COROS / Polar partner programs now"* since Phase 00, and `05-accounts-and-
> credentials.md` still records the answer as **❔ unknown whether applied**. Approval takes weeks;
> everything downstream (watch capture adapters, the watch-wins ingest path) is gated on it. This is
> a backlog note that will most likely become a `B`-era phase; until then it exists so the
> reminder outlives the roadmap rewrite that removes the "Start now" block it used to live in.

## The reminder

**Start the applications.** Each is a form and a wait, not engineering:

| Provider | Program | Gate | Notes |
| --- | --- | --- | --- |
| Garmin | Garmin Connect Developer Program (Health / Activity API) | partner review, weeks | the one skaters ask for first |
| COROS | COROS Open API developer / partner application | partner review | |
| Polar | AccessLink API — <https://admin.polaraccesslink.com> | registration, lighter than Garmin | webhooks |
| Google Health Connect | Android permissions + Play **health-data access review** | needs a **Play account** ($25) first | the review is the slow part |
| Apple HealthKit | HealthKit entitlement + dev build | **no partner approval** | unblocked today; shares the iOS device-verification dependency |
| Whoop | its own API access | — | an additional *push* target, not capture |

## What it unblocks, and where that's written

- **Phase 08's deferred list** — third-party capture adapters (Garmin / HealthKit / Health Connect /
  COROS / Polar) and the **watch-wins ingest path**, each integrated individually. The A-input side of
  the A→B→C pipeline; the native recorder is A-input #1 and these are #2 onward. See
  [`phases/08-native-capture.md`](../phases/08-native-capture.md).
- **L8** in [`08-legal-feasibility-checklist.md`](../08-legal-feasibility-checklist.md) — per-provider
  ToS / brand / health-data review at integration time (D24).
- **`05-accounts-and-credentials.md`** — the account table, ordered by lead time; update the ❔ once
  the applications are in.

## When it becomes a phase

Once at least one approval lands, this is a `B`-era phase: the shared adapter shape (normalize any
track → `gpsActivities`, resolve to lake, link to report — the B spine Phase 08 already built), one
provider at a time, HealthKit first because it needs no approval. Not before — building adapters
against APIs we can't call is the speculative work the register exists to hold back.
