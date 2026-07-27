# N3/N4 — Account lifecycle + storage hygiene

*The D33 phase: delete, export, anonymize — plus the two storage-hygiene crons that used to be their
own entry (the old N4 and N3 respectively), bundled because **N4 creates exactly the storage problems
N3 exists to solve**.*

> **Status:** in build (2026-07-27). Kickoff decisions below are settled; the roadmap's N3/N4 entries
> are merged into this one.

## Why these two are one phase

The roadmap listed storage-hygiene crons (old N3, "tiny — a half-day") and account lifecycle (old N4)
as separate chunks. They aren't, once you look at what the lifecycle work actually emits:

- An **export bundle** is a generated blob in Convex storage. It needs a TTL sweep — the same cron
  shape as the photo-orphan GC.
- **Deletion strands photo blobs** (a departing user's unattached uploads). The GC cron is the backstop
  that makes deletion's cleanup non-load-bearing.
- The 30-day grace window needs a **finalize cron** — a third job in the same family, sharing the same
  paging and test shape.

So the crons aren't filler bundled to save a Greptile run; they're the phase's own cleanup path. One
phase doc, one PR, commits split by workstream.

## What the roadmap's N3 and N4 entries got wrong

**1. D33's central premise is now false.** It reads: *"Since all reports are public (D13), there's no
private content to selectively remove — every report is anonymized-not-erased uniformly."* True when
written. Not true now: **Phase 4** added `homeCoord` + `cachedIsochrones` (a home address and three
polygons derived from it), and **Phase 8** added `gpsActivities.path` (raw GPS traces) plus
`activityConnections` (live OAuth tokens). D33 predates both. "Anonymize, don't erase" is the right
rule for the *community ice record* and the wrong rule for a private location trace. Amended as **D62**.

**2. N3's photo-orphan entry doesn't know its own evidence gate exists.** Phase 7b built the
`photo_orphans` metric *and* the `photos.by_created_at` index expressly "to decide whether the deferred
GC cron is worth building" (`analyticsRollup.countOrphanPhotos`). Neither the N3 entry nor the design
sketch at the bottom of the roadmap mentions it. Measured on dev 2026-07-27: **0 photos, 0 orphans, 0
`weatherCache` rows, 1 report, 2 profiles.** The metric reads zero because there is no data at all, not
because orphans don't happen — so both crons are built on first principles, and the roadmap should stop
implying a trigger fired. (They're still worth building: pure downside-avoidance, and the phase now
creates its own orphans.)

**3. "The mechanism is fully unblocked" is true of deletion and false of export *delivery*.** Emailed
delivery needs the Resend key + a verified sending domain, which the roadmap itself files under the
prod-cutover blockers. See *Export delivery* below for how that's handled without leaving the phase
unverifiable.

**4. N4 undersells the schema landmines and oversells the UI sprawl.**
- *Undersells:* `profiles.by_clerk_user_id` is read with `.unique()`. Scrub `clerkUserId` to a shared
  constant and the **second** deleted account makes every auth lookup in the app throw. Same trap on
  `by_username`. Both need per-row-unique sentinels, not a shared `'deleted'`.
- *Oversells:* "making an anonymized author render gracefully everywhere" is smaller than it reads.
  `reports.ts`, `bounties.ts` and `comments.ts` already funnel a missing author through one shape —
  `{ displayName: 'Unknown', username: '', trustClass: null }`. The work is making that shape mean
  "deleted skater" and honoring it, not 24 bespoke fixes.

**5. What N4 didn't say at all:** `weatherCache` growth is now **multiplied by N2**. The cache key is
`(samplePointKey, windowStartMs, windowEndBucketMs)`, and N2 shipped the `weatherSamplePoints` writer —
so a big lake samples at several points, and rows accrue per hour *per point*, not per hour per lake.

## Decisions taken at kickoff (2026-07-27)

**1. Bundle old-N3 into old-N4.** One phase, one PR. See above — the coupling is real, not budgetary.

**2. Deletion gets a 30-day grace window, finalized by cron.** Not immediate. Reversible-by-default
matches the ethos every other destructive path in this app already has (hazard archive D15, merge
tombstone D36, demotion D53) and protects against the rage-quit and the misclick.

> **A correction to this decision's own first draft.** The kickoff option said "Clerk-BAN during the
> grace window (reversible), delete the Clerk user at finalize." That is wrong and would have shipped a
> trap: **banning the Clerk user locks them out of the very sign-in they need to undo.** So Clerk is not
> touched until finalize. During the grace window the account stays fully functional — they can sign in,
> post, and cancel — and a persistent banner says when it will be deleted. Cancelling is an **explicit
> button**, never an implicit side effect of signing in; silently cancelling on sign-in would mean a
> user who logs in once to save a photo has quietly un-deleted themselves.

**3. Three buckets on finalize, not two.** D33's binary (anonymize public / erase private) can't express
what we want from GPS tracks, so there's a third:

| Bucket | Rule | Contents |
|---|---|---|
| **Erase** | private artifacts with no community value | `activityConnections` (OAuth tokens), `oauthStates`, `notifications`, `notificationQueue`, `waterBodyFavorites`, `blocks` (both directions), `clientSignalEvents`, `supportTickets`, unattached `photos` + blobs, unlinked `gpsActivities`, and the profile's own PII fields |
| **Anonymize** | the public ice record — author pointer → tombstone, content untouched | `reports`, `comments`, `hazards`, `hazardConfirmations`, `reportRatings`, `bounties`, `pointEvents`, `contentFlags.flaggerId`, `moderationActions.actorId`, `putIns`, `bodyFeatures`, `waterBodies`/`waterBodySubAreas` `createdByUserId` |
| **Keep, severed from identity** | published GPS tracks | `gpsActivities` linked to a visible report — path preserved, provider handles scrubbed |

**4. The GPS rule is the aggregate layer's own predicate, reused.**

> **A `gpsActivities` row is kept iff it is linked to a visible report. Otherwise it is erased.**

That is not a new rule invented for deletion — it is literally gate (1) of `listTracksForBody`,
*publish-is-consent* (D58). An **unlinked** activity is a private recording the person never published:
raw movement data, no community value, so it goes with the rest of the private bucket. A **linked** one
was already public, is already drawn on the lake, and is part of the ice record the whole
anonymize-don't-erase posture exists to preserve.

The consequence worth stating plainly rather than burying: because each deleted user keeps their **own**
tombstone (they must — `reports.authorId` is a required ref, and merging tombstones would be a mass
rewrite), their surviving tracks remain linkable *to each other* under a pseudonym. That is inherent to
anonymize-don't-erase and is already true of their reports. What stops it pointing at a house is the
put-in clip, which is decision 6.

**5. The aggregate heatmap needs no changes — and that's a property of D58's design, not luck.** All
four privacy gates read data that survives deletion:

| Gate | Reads | After finalize |
|---|---|---|
| 1. Publish-is-consent | `activity.linkedReportId` → report `visible` | report survives, anonymized → **passes** |
| 2. Minors excluded | falls out of "minors can't post" | unchanged |
| 3. Put-in clipping | `report.showPutIn` | unchanged → **clip rule preserved exactly** |
| 4. Global opt-out | `profiles.excludeTracksFromAggregate` | tombstone survives → honors their last choice |

The operative constraint on the implementation is therefore a **negative** one, and it's easy to get
wrong while "being thorough about privacy": **finalize must not set
`excludeTracksFromAggregate`.** Flipping it on would look like the cautious choice and would silently
delete the contribution the founder explicitly asked to preserve.

**6. Fix the put-in clip bypass, in this PR, clipping for non-authors.** Found while verifying decision
5. `showPutIn === false` is honored in exactly two places — `putIns.listForBody` (hides the pin) and
`listTracksForBody` (clips 150 m off both ends). It is **not** honored in `gpsActivities.getForReport`,
which returns `activity.path` raw to every viewer of the report. The doc comment at `gpsActivities.ts:377`
says *"The report's own detail view still shows **its author** their full path"* — but there is no owner
check in that query. So a skater who withheld their put-in has their first and last 150 m drawn on the
public report-detail map today, and the aggregate layer's structural privacy is walked around by the
simpler query 60 lines above it.

In scope here because there is no point making *deletion* respect a clip rule the live product doesn't
respect. The fix: clip in `getForReport` when `showPutIn === false`, unless the viewer is the author or
a moderator — which makes the code match what its own comment already claims.

**7. Export is emailed, and also listed in settings until it expires.** Email is the delivery mechanism
(founder call). Because Resend is unprovisioned, an email-only path would ship the entire export half of
the phase unverifiable and would make a bounced or spam-filtered email a dead end for the user. So the
settings screen also lists a completed export with its download link. Same log-and-skip posture as
`operatorAlerts` when the Resend env is absent.

**8. The bundle embeds photo bytes, not photo URLs.** D33 says "a JSON bundle … plus their uploaded
photo files". Linking would have been easier, but it fails at the one moment the export exists for: a
URL into our storage **dies when the account is deleted**, so a link-based export is worthless precisely
when someone exports-then-deletes. Photos are base64-embedded under a total size budget, with anything
beyond the budget listed explicitly rather than silently dropped (the Phase 7 "no silent caps" rule).

## The design

### Deletion, end to end

1. **Request** (`userLifecycle.requestDeletion`) — stamps `profiles.deletionRequestedAt`. Status stays
   `active`. Clerk untouched. Nothing else changes.
2. **Grace** — 30 days. The account works normally; every client shows a banner with the finalize date
   and a Cancel button. `cancelDeletion` clears the stamp.
3. **Finalize** (cron → self-continuing paged job) — sweeps `profiles.by_deletion_requested_at` for
   stamps older than the window, and runs the three buckets. Ends by scheduling the Clerk delete.
4. **Clerk delete** (`clerkAdmin.deleteUser`, an `internalAction`) — same shape as the existing
   `setBanned`: retry ladder, operator alert with the manual fix on terminal failure, never throws.
   Convex is the security boundary either way; `requireProfile` already rejects `status: 'deleted'`.

**The tombstone.** `status: 'deleted'`, `deletedAt` stamped, and every PII field scrubbed:
`displayName → 'Deleted skater'`, `bio`/`homeCoord`/`homeTownLabel`/`profileImageUrl`/`cachedIsochrones`/
`outerRadiusMeters`/`feedFilterPrefs`/`riskAck*` dropped, `dateOfBirth` → a fixed sentinel.

The two uniqueness landmines get **per-row-unique** sentinels derived from the profile id —
`username → deleted-<id>`, `clerkUserId → deleted:<id>` — because both are read with `.unique()` and a
shared constant would make the second deletion break authentication for the entire app.

### Storage hygiene — three crons

All three are the shape of the three prune crons already shipped (`pruneGateEvents`,
`pruneClientSignals`, `pruneOAuthStates`), so they share one test pattern.

- **Photo-orphan GC** — sweeps `photos` past a grace window that no `reports.photoIds` /
  `hazards.photoIds` references, deleting row + both blobs. Windowed exactly like
  `countOrphanPhotos` already is, and for the same reasons: a photo uploaded minutes ago is
  mid-submission, not abandoned, and references are gathered from a *wider* window because a photo is
  uploaded before the report that attaches it.
- **`weatherCache` prune** — drops rows whose window is older than the longest read window (the
  unified 7-day decay/strip window), not merely "old". Pruning inside that window is safe but
  self-defeating: every pruned row is a refetch against Open-Meteo.
- **Finalize deletions** — decision 2's window sweep.

Plus the **export-bundle sweep**, which rides in the photo-orphan job's transaction budget rather than
taking a fourth cron slot.

## Work breakdown

1. ✅ Plans — this doc, D62, the merged roadmap entry.
2. ✅ The put-in clip fix (decision 6) — standalone, live behavior, own commit.
3. ✅ Schema + core — `deletionRequestedAt`, `dataExports`, the tombstone vocabulary, `notificationQueue.by_user`.
4. ✅ Deletion machinery + Clerk delete action.
5. ✅ Export machinery.
6. ✅ Author rendering: the tombstone shape, everywhere.
7. ✅ The crons.
8. ✅ Web + mobile settings UI.

## What the build found

### The finalize sweep would have deleted every account

The one that matters — and **tests didn't find it, running the cron against dev did.** The first real
tick of `finalizeDueDeletions` returned `due: 2, started: 2` on a deployment where nobody had requested
anything.

A Convex index on an **optional** field is *not sparse*. Rows without the field are in it, and
`undefined` sorts **before every number** — so `lte('deletionRequestedAt', cutoff)` matched every
profile in the table. The schema comment claiming the index was "sparse in practice — only pending rows
carry the field" was the assumption, written down and never checked, which is the part worth carrying
forward: it read as documentation and was actually a guess.

**Nothing was lost.** `finalizeAccount` re-reads the stamp and returns `stopped: 'cancelled'` before any
stage runs. That guard was written for a user changing their mind mid-flight, and it turned out to be
the only thing between a query bug and every account in the app. Both dev profiles, the one report and
N2's nine sub-areas were verified intact afterwards. Two independent guards is now the deliberate
posture for this job rather than a happy accident.

The regression test was checked the only way worth checking one: revert the fix, confirm it fails with
the exact dev symptom (`due: 2, skipped: 2`). It does — so **convex-test reproduces the ordering and
this was always catchable.** The original test only covered two accounts that had *both* requested
deletion, which is the case that works.

*Swept for siblings:* every other bare upper-bound index range in the codebase (`analyticsRollup`,
`notifications`, `strava`, and the two new sweeps) is on a **required** field, and the two ranges over
an optional `resolvedAt` are bounded below by `gte`. The class is contained to the one query.

### The `showPutIn` bypass (decision 6, found while verifying decision 5)

`gpsActivities.getForReport` served the raw path to every viewer, so a skater who withheld their put-in
had the first and last 150 m of their track drawn on a public page — while the aggregate layer 60 lines
below carefully clipped exactly that. Fixed, with the author/moderator exemption the aggregate layer's
own doc comment had already claimed was there.

### `weatherCache` retention is stronger than "stale"

The roadmap said "disk growth, not staleness". It's neither, quite: `resolveWeatherSince` looks the
cache up **by exact key triple**, and the triple contains `hourBucket(now)`. So a row is reachable only
during its own hour — the previous hour's rows are *unaddressable*, not merely old. Kept 24h anyway as
margin against clock skew, with a test asserting the margin so nobody tunes it to 1h and finds out.

### The continuation path was untestable, so it became testable

A stage that keeps some of what it reads can't re-`take()` its first page (it loops on the same kept
rows), and one that paginates must actually resume from its cursor or a heavy account's deletion stops
partway through **while reporting success** — leaving private rows behind for precisely the people with
the most of them. That path was unreachable in a test at `PAGE = 200`, so the page size is a real
argument now. Verified by sabotaging the cursor threading: the test fails with "too many iterations —
check for infinitely recursive scheduled functions", which is the failure the design comment predicts.

### One author shape, not four

The feed card, report detail, comment thread and bounty list each built the same three lines by hand.
Harmless until a tombstone — a profile row that still exists, still carrying `reputationPoints` — made
every copy render a trust ring for someone with no account, with `publicByIds` fixed by hand and the
others not. Extracted to `lib/authorView`, with a test asserting all three surfaces agree. Both
`BountyDetail`s also carried a guard reading "a missing/deleted requester has no username", which the
tombstone falsified: it has a *synthetic* handle that passes an emptiness check and routes nowhere.

## Verification

- **Full suite green:** core 862 · convex 683 · web 197 · mobile 79 · design 61 · etl 22 · admin-areas 14.
- **Deployed to dev**, five indexes added (`dataExports.by_user`, `dataExports.by_expires_at`,
  `notificationQueue.by_user`, `profiles.by_deletion_requested_at`, `weatherCache.by_window_end`).
- **All four crons run against dev**: `pruneWeatherCache` 0, `sweepOrphanPhotos` 0/0/0,
  `sweepExpiredExports` 0, `finalizeDueDeletions` **0** (2 before the fix).
- **`dataExport.collect` run against real dev data** — returns the profile with `clerkUserId` absent
  and the one real report (Fairlee, VT), so the export read path is exercised against the live corpus
  and not only fixtures.

**Not verified end-to-end on dev: an actual account deletion.** Dev holds only the two founder admin
accounts and there was no throwaway to delete. The staged job has 19 convex-test cases including the
multi-page continuation, but nobody has watched a real account go through it. Worth doing against a
disposable account before the alpha.

## Open / accepted residue

- **`bountyGateEvents.requesterId` is not swept.** It's a high-write analytics table with no
  `by_requester` index, already pruned at 180 days. Adding an index solely for a rare job costs more
  than it buys; the pointer resolves to a tombstone and the rows self-expire well inside a year.
- **`supportTickets` are erased, not anonymized.** They're private correspondence between the user and
  the operator — free text likely to contain a name or email — not community record. The
  `moderationActions` audit trail is a separate table and survives regardless.
- **Policy copy still waits on Q10/L3.** This phase builds the machinery only, per the roadmap.
- **A still-valid Clerk session between the tombstone and the Clerk delete** can call `upsertFromClerk`
  and get a *fresh, empty* profile. Not a leak — it's the same thing signing up again gives them, and
  the Clerk delete closes the window seconds later — so it's logged rather than guarded.
