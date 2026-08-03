# N8 — The notification pipeline: the inbox, the missing producers, and the reverse reach index

> **Status:** 📋 Scoped, not built (2026-07-30). Founder call the same day: **no N8 code until every N6
> phase has shipped** (N6a's ETL run, N6b, N6c, N6d). This document is the design record so the scope
> stops drifting in the meantime.
> **Depends on:** nothing. It touches no water-body data and no N6 surface; it can be built the day
> N6 closes.
> **Touches:** `notifications` / `notificationQueue`, `profiles.notificationPrefs`, the Phase 3 comment
> path, the Phase 7 moderation queue, the Phase 9 hazard-confirmation loop, the Phase 8 recorder, and
> both clients' shells.
> **Decisions:** **D77–D81**, proposed here and to be logged in [`01-decisions.md`](./01-decisions.md)
> at build kickoff (D76 is the last one logged).

---

## Why this is its own pass

The roadmap's N8 entry is two bullets — per-user digest timing and a reverse spatial index — grouped
because neither needs push credentials. Both are real, both are correctly described, and **neither is
the thing wrong with the notification pipeline.**

Every phase since Phase 3 has said some version of *"push delivery is deferred; this lands an in-app
`notifications` row."* Phases 3, 4 and 6 all say it. It is the sentence that made deferring push
acceptable — the value was supposed to survive the deferral, just quieter.

It didn't. **Nothing in the app can read a notification.** The rows are written and never seen.

So this phase is the pipeline's missing half: make the notifications readable, give every declared type
a producer, and only then optimize the fan-out that produces them. The two roadmap bullets stay — they
move to the back.

---

## What checking the code changed about the register entry

### Correction 1: the pipeline has no reader at all

`packages/convex/convex/notifications.ts` exports exactly two things — `fanOutNearbyNotifications`
(:151) and `flushNotificationQueue` (:242), both `internalMutation`s. There is **no query, no
mark-as-read mutation, and no unread count**, anywhere in the codebase.

The table is ready for one and always was: `notifications` (`schema.ts:1073`) carries `userId`, `type`,
`payload`, an unused **`readAt`**, and a `by_user` index that nothing reads. The only code that touches
it outside the flush is `accountDeletion.ts:537`, which drains a departing user's rows.

Six notification types are being generated today and have never been visible to anyone:

| Type | Producer | Since |
|---|---|---|
| `report_rated` | `ratings.ts:140` (a thumb on your report **or hazard**) | Phase 6 |
| `report_rated` | `reports.ts:448` (your report was corroborated) | Phase 6 |
| `bounty_request` | `bounties.ts:662` (a bounty on a lake you recently reported) | Phase 6 |
| `bounty_fulfilled` | `bounties.ts:760` (your bounty was answered) | Phase 6 |
| `favorite_report` | `notifications.ts` flush | Phase 4 |
| `nearby_report_digest` | `notifications.ts` flush | Phase 4 |
| `great_report_nearby` | `notifications.ts` flush | Phase 4 |

That is the phase. Everything else here is smaller.

### Correction 2: four of the ten declared types have no producer

`NOTIFICATION_TYPES` and `NOTIFICATION_PREF_KEYS` (`lib/enums.ts`) are ten long and kept in lockstep, so
`/settings` renders ten toggles. Four of them cannot fire:

- **`report_commented`** — deliberate and documented (`comments.ts:8,40`, D21/Phase 3).
- **`hazard_confirmation`** — never produced. The string is *also* used by
  `packages/core/src/hazardQueue.ts:95,161` for the Phase 9.5 on-ice **local** alert queue, which never
  touches this table. One name, two mechanisms, no connection between them.
- **`content_flag_resolved`** — never produced. `moderation.resolveFlag` (`moderation.ts:95`) writes the
  terminal status and an audit row, and tells the flagger nothing.
- **`activity_detected`** — never produced, and *its source was cut*: D24 framed it as "an ice-skate
  detected on any linked provider", and Phase 8 replaced provider **pull** ingest with our own recorder
  plus a Strava **push** (L7). What remains is a narrower and better-defined case — see B4.

D16 says every type is toggleable. It is satisfied on paper while **four of the ten toggles are inert
switches**, which is the kind of thing that reads as working until someone checks.

### Correction 3: `report_rated` is two payload shapes and one misnomer

The same type is inserted with `{ targetType, targetId, raterId }` from `ratings.ts:140` and with
`{ kind: 'corroboration', reportId, byReportId }` from `reports.ts:448`, and `ratings` covers **hazards**
too, so `targetType` can be `'hazard'`. `payload` is `v.any()`, so nothing catches a shape mismatch.

That matters only once something renders these — which is exactly what this phase does. It is the
strongest argument for A2's typed resolver, and it's cheaper to fix now than after a second reader
exists.

### Correction 4: both roadmap bullets are invisible at alpha scale, and one has no clock

- The **reverse index** is a cost optimization with no user-visible effect until the app has enough
  profiles for the walk to cost real money. Today the fan-out pages 200 profiles at a time
  (`FANOUT_PAGE_SIZE`), self-continuing, off the write path since N1. With dozens of users it is one
  page.
- **Per-user digest timing** has nothing to derive a timezone from. `profiles` stores `homeCoord`
  (optional, private) and no timezone field. `nextZonedHourMs` (`core/schedule.ts`) is already per-call
  parameterized on hour + zone, so the *math* is done — the missing piece is data, not code.

Neither is wrong. Both are behind the inbox in every ordering that a user would recognize.

### Correction 5: the hazard channel is already decided, and it isn't this one

Hazards generate **no** `notifications` rows at all — `hazards.ts` contains no notification code. That
looks like an omission and isn't: Phase 9.5 made the hazard channel a client-side **proximity** alert
fired while you're on the ice, deliberately local and offline-capable. Founder call, 2026-07-30:
**keep it that way** (D79). A push about a hazard on a lake you are not standing on is a different
product decision, and not this phase's.

The distinction that survives: **author-directed** hazard notifications are in scope (B2 — someone
confirmed or disputed *your* hazard), because that's feedback on your own contribution, not a broadcast.

---

## Decisions proposed at scoping (2026-07-30)

### D77 — A notification nobody can read is not deferred delivery, it's a dropped feature

Push is a **transport**. The in-app row was always meant to be the product, and every "delivery
deferred" note since Phase 3 assumed a surface that reads the table. Until that surface exists, six
notification types are dead code with a settings page in front of them.

**So the inbox ships first**, and from here on the rule is: *a notification type may not be added
without a producer **and** a place it renders.* The push layer, when the credentials land, becomes a
second transport over the same rows — not the moment the feature starts existing.

### D78 — Every declared type has a producer, or it isn't a type

Four inert toggles are worse than four missing ones: they tell a user they've configured something.
Founder call — **generate them** (B1–B4) rather than strike them. Where a producer genuinely cannot
exist yet, the type and its toggle come *out* until it can, so the settings page never advertises a
channel that can't fire.

### D79 — Hazards do not broadcast; on-ice proximity remains the hazard channel

Founder call, 2026-07-30. A hazard alert is a *presence* signal — it matters when you're on that ice,
which is exactly what Phase 9.5 built, offline and without a server round trip. Adding a "new hazard
near you" push would put safety content on the least reliable transport we have (deferred, throttled by
iOS at its discretion, D54) for a skater who by definition isn't there.

**In scope regardless:** `hazard_confirmation` to the hazard's **author** (B2). Feedback on your own
contribution is not a broadcast.

### D80 — The reverse reach index filters candidates; it never replaces the eligibility test

The fan-out's cost is that it *examines* every profile. It is not that it examines them wrongly: each
check is a real polygon test (`bandForCoord`, `core/driveTime.ts:50`) against that viewer's own cached
isochrones. A cell index can cheaply say *"these profiles could plausibly reach this lake"* — it cannot
say who qualifies, because a bbox is not a band.

So the index returns **candidates**, and the exact test still runs per candidate — the same discipline
N1 established for `waterBodyCells`, where cells cover a bbox and the caller still filters. And because
a missing index row is a **silent** non-delivery (D5: a silent wrong answer is worse than a slow one),
the index ships with a reconciliation path and a measured comparison against the walk before the walk
is retired.

### D81 — Notifications settle before they send, and the trigger is re-checked at send

Founder ask, 2026-07-30. A misclick is a normal thing to do: thumb the wrong hazard, notice, click again
to undo. Today that sends its notification instantly and the undo cannot recall it — the author is told
someone found their report helpful, by someone who no longer does.

**So every actor-triggered notification goes through the coalescing queue with a short settle window,
and the queue re-reads the triggering state at flush.** Delivery asks *"is this still true?"*, not
*"was this true a minute ago?"*

**Re-check at send rather than cancel at undo**, which is the load-bearing half. Cancelling means every
undo path — retract a thumb, flip a verdict, delete a comment, remove a report, a moderator hiding it —
has to know the queue exists and find the right row; miss one and a phantom notification ships. Re-check
is one place, it covers paths nobody thought of, and it covers content that vanished for reasons that
were never an "undo" at all.

**This isn't new machinery, and there's precedent for the exact move.** `notificationQueue` already
debounces two minutes for favorites and coalesces `(user, body, kind)`, and `flushNotificationQueue`
already re-checks recipient eligibility at delivery instead of trusting enqueue-time state — a PR #30
review fix, made because a person can request deletion inside the window. D81 applies the same rule to
the *trigger* that the flush already applies to the *recipient*.

**One consequence worth stating:** the queue becomes the only path into `notifications`. That is also
what a push sender needs later — one place to add a transport, rather than six insert sites.

## Workstream A — The inbox (the deliverable)

### A1 — The read path

Three functions in `notifications.ts`, all public:

- **`list`** — paginated over `by_user`, newest first, for the signed-in user only. Paginated rather
  than capped: a year-old notification history is unbounded, and `.collect()` on a per-user table is
  the pattern N1 spent a phase removing.
- **`unreadCount`** — for the badge. Add an index on `['userId', 'readAt']` and query
  `eq('userId', me).eq('readAt', undefined)`. Worth being explicit, because this repo has been bitten
  here: an index on an optional field is **not sparse**, and `undefined` sorts before every number — but
  that trap is about **range** bounds (`lte`), and this is an **equality**, which is exactly the shape
  that behaves. (See the N3 finalize-cron bug in [`phase-N3-N4-account-lifecycle.md`](./phase-N3-N4-account-lifecycle.md).)
  If the count proves hot, the fallback is a denormalized counter on `profiles` in the Phase 4
  contribution-counter pattern — but measure first.
- **`markRead`** — stamp `readAt` on one row or on everything up to a timestamp. Owner-only.

Rows already die with the account (`accountDeletion.ts:537`); their *own* retention is A5.

### A2 — The resolver, and why it's the actual work

A notification row is ids in a `v.any()` payload. Rendering "Ellie found your report on Lake Morey
helpful" means resolving those ids, and the resolution has to survive the content having changed since:

- **The target may be hidden or removed** (D32 moderation) — render the notification degraded
  ("a report that's no longer available") and never make it a dead tap. It must not vanish either: a
  disappearing inbox row reads like a bug.
- **The actor may have departed.** Under the D62 second amendment they're anonymized, not erased, so
  the existing `{ displayName: 'Unknown', … }` shape from `reports`/`comments`/`bounties` is reused —
  not reinvented.
- **The actor may be blocked.** Block == mute (Phase 3): a block doesn't hide content, but it must not
  ring your phone. The inbox filters actor-keyed notifications through `loadBlockedAuthorIds`
  (`lib/reportVisibility.ts`) at **read** time, so an old block applies to old rows too.
- **`report_rated` needs discriminating** (Correction 3) — one type, two shapes, and hazards riding the
  report-shaped channel. The resolver is where that gets typed; the alternative is two clients guessing.

Batch-load per page. One notification page must not become N round trips — the N+1 shape that
`contradictionCluster` hid inside N1's read path.

### A3 — Where it renders

- **Web:** a bell in `AppShell.tsx` (:41 is the existing nav row) with an unread dot, opening
  `/notifications`. A route, not a popover-only surface, so it's linkable and testable.
- **Mobile (founder call, 2026-07-30):** the tab bar stays **five co-primary tabs** (D28/`00-vision`,
  `app/(tabs)/_layout.tsx`) — no sixth tab. The path is **You tab → bell in the top corner of the
  profile page → the list**, and the unread signal is a **dot on the avatar** in the You tab, so the
  badge is visible from anywhere in the app without spending a tab on it.

  Worth naming because it constrains A1: the avatar dot is rendered on *every* screen with the tab bar,
  so `unreadCount` is effectively a subscription running app-wide. It has to stay a single indexed
  count — a boolean "any unread" would be cheaper still, and is the fallback if the count is ever hot.

Both surfaces read the same three functions and the same resolver output, so "web and mobile agree" is
structural rather than a review checklist item.

### A4 — What the inbox must not become

Not a feed. The newsfeed (Phase 5) is the place for *what happened on the ice*; the inbox is *what
happened to you and your contributions*. If a notification type would be equally at home in the feed, it
probably belongs there instead — which is most of the argument for D79.

### A5 — Retention: the inbox empties at the season boundary

Founder call, 2026-07-30: **purge notifications each July**, on N5a's season rollover (July 1, D63).

It's the right clock rather than a convenient one. Every notification we generate is about a *moment* —
someone thumbed your report, a bounty opened on a lake, three lakes near you had new ice. None of that
survives a summer, and a July inbox holding February's ice reports is landfill with a badge on it.
Reusing the season boundary also means no new concept: D66 already expires a departed skater's
condition photos on exactly this line, for exactly this reason.

**Shape:** a sweep in the `storageHygiene` cron family, alongside `sweepDepartedPhotos` — which already
runs **daily rather than annually** for a clock that turns over once a year, because accounts are
tombstoned continuously and waiting for the boundary would hold rows for eleven months. Same posture
here: sweep daily, delete anything created before the current season's start (`seasonStartMs` from
`core/season.ts`, already the app's single definition of the boundary).

**Read state doesn't matter.** An *unread* notification about last season's ice is worth less than a
read one, not more — keeping it would be the only mechanism in the app that treats an unopened row as
more durable than an opened one. Delete both.

**One consequence to state rather than discover:** this makes the inbox non-archival. If someone wants
the record of what happened to their contributions, that's the **data export** (N3), which reads the
live tables — not the inbox.

---

## Workstream B — The four missing producers (D78)

### B1 — `report_commented`

**Trigger:** `comments.create` (`comments.ts`), after the insert. Notify the **report author**, and for
a reply, also the **parent comment's author**.

**Gates:** never self; `canReceiveNotifications` (`lib/auth.ts:171`); `prefs.reportCommented`; skip if
the recipient blocks the commenter (block == mute — and the A2 read-time filter is a backstop, not a
substitute).

**Coalesce it.** A busy report gets a burst of comments, and the `notificationQueue` already solves
exactly this: a fourth `kind` (`comment`) keyed `(user, report, kind)` with the existing `DEBOUNCE_MS`
gives *"3 new comments on your report"* instead of three rows. This is reuse of built machinery, not new
machinery — the queue was designed generically and has only ever had report buckets in it.

**Already handled elsewhere:** a departed author. `setNotificationPrefs` carries a note about a ghost's
kept reports still drawing comments while the mute switch is closed (N5a review, item 3); the answer
landed in `canReceiveNotifications` at both enqueue *and* flush (`notifications.ts:261–279`). B1 inherits
both gates by using the same path.

### B2 — `hazard_confirmation`

**Trigger:** `hazardConfirmations.confirm` (`hazardConfirmations.ts:56`) → notify
`hazard.createdByUserId`.

**Notify on transitions, never per vote** (founder call, 2026-07-30). Per-vote notifications turn a
confirmation loop into a scoreboard, and D65's *"this never existed"* verdict makes it worse: that
verdict also **files a moderation flag** (`hazardConfirmations.ts:264`), so a per-vote notification
would forward what is effectively an accusation, one voter at a time. So the trigger is the
**lifecycle change** — your hazard was confirmed still present, marked healed, or archived — which is
both quieter and the only part the author can act on.

Concretely: the producer hangs off `deriveHazardLifecycle`'s output changing, not off the confirmation
insert. Same event the map already re-renders on.

#### The name collision, and which one moves

Two things carry the string `hazard_confirmation`, and they point in **opposite directions**:

| | Where | What it is |
|---|---|---|
| **Inbox** | `NOTIFICATION_TYPES` + the `hazardConfirmation` pref key (`lib/enums.ts`) | a message *to the hazard's author*: someone confirmed or disputed your hazard |
| **Outbox** | `QueuedHazardConfirmation.kind` (`core/hazardQueue.ts:95,161`) | a vote *you cast* on the ice, sitting in the phone's offline queue waiting to flush |

One is mail arriving; the other is an unsent letter on your own desk. They're adjacent in the domain,
which is exactly why the shared name misleads — a reader who greps the string finds two mechanisms with
no connection and reasonably assumes they're one.

**Rename the queue one** — it's local to mobile, has no database rows, no wire format and no stored
history, so it costs a find-and-replace plus its tests. `confirmation_vote` says what it is: a vote,
outbound. The notification type stays, because renaming it means touching `NOTIFICATION_TYPES`, the
`notificationPrefs` object on every profile, and any stored row.

### B3 — `content_flag_resolved`

**Trigger:** `moderation.resolveFlag` (`moderation.ts:95`) → notify `flag.flaggerId` that their report
was actioned or dismissed.

**Say nothing about the outcome beyond the verdict.** "We reviewed this and took action" / "we reviewed
this and left it up". Not what was done, not to whom, not by which moderator. The flagger isn't owed the
target's identity and the moderator isn't owed the exposure.

#### The auto-flag problem, stated correctly

*Founder call, 2026-07-30: don't notify auto-flaggers. The conclusion is right; the reason is not the
obvious one, and the difference decides how it's built.*

There is **no system account**. `fileOrBumpAutoFlag` (`lib/autoFlag.ts:86`) takes a required
`flaggerId: Id<'profiles'>`, and its own comment says what goes there: *"whose action crossed the
line — `reason`/`note` are what mark the row system-generated."* So a system flag names a **real
person** — just not a person who reported anything. All three callers:

| Caller | `flaggerId` is | What they actually did |
|---|---|---|
| `ratings.ts:120` | the rater whose unhelpful thumb crossed the threshold | clicked 👎 |
| `contradictions.ts:150` | the corroborated opponent | filed a report that contradicted another |
| `hazardConfirmations.ts:260` | the Nth "never existed" voter | voted that a pin was never real |

None of them filed a report. Notifying them would mean telling someone *"the report you filed was
actioned"* about a report they never filed — and worse, disclosing that **their thumb produced a
moderation flag against another user's content**, which is information we deliberately don't surface
anywhere else. The third case is the closest call and still wrong: the flag fires on a *threshold*, so
the notice would go to whoever happened to be Nth, and to nobody else who voted the same way.

**So the gate is real, and it needs a field.** `contentFlags` carries no marker today — auto rows are
distinguished only by their `reason` and a `note` string, which is a convention, not a discriminator.
Add `origin: v.optional(literals(['user', 'auto']))`, set at both write paths.

**Default to silence.** Rows written before this field exists have no `origin`, so the rule is *notify
only when `origin === 'user'`* — absent reads as auto. That is the fail-quiet direction: a missing
notification is invisible, an unexpected one about a report you never filed is alarming, and the
un-notified backlog is finite and historical either way.

### B4 — `activity_detected`, re-derived from a source that exists

D24's premise — "detected on any linked provider" — was retired with the Phase 8 pivot to push (L7), and
the remaining watch adapters are stuck behind approval queues (L8). Building the type against that
premise means building nothing.

**The case that does exist:** `gpsActivities.ingestTrack` (:162) inserts every recorded track with
`promptState: 'pending'`, and the recorder prompts on stop. When the app dies before prompting, or the
track flushes from the offline queue hours later on a different screen, that prompt never happens — and
a completed skate sits in the table that nobody was ever asked about. The `pending → prompted →
converted | dismissed` lifecycle (`setPromptState`, :233) is already there to hang this on.

**So:** a cron sweeps activities still `pending` after a few hours and files one `activity_detected`
notification — *"You skated on Lake Morey on Tuesday. Add a report?"* — flipping the row to `prompted`
so it fires once. That needs an index on `promptState` (`gpsActivities` has `by_user`,
`by_provider_activity`, `by_water_body` and no prompt-state index); `promptState` is **required**, so no
sparse-index trap here.

**Honest limit to record:** this is our own recorder only. The provider-detection half stays blocked on
L8, and the type's description in `06-data-model.md:61` ("on ANY linked provider") should be corrected
when this lands rather than left to imply a capability we cut.

#### B4a — One skate, several sources: dedup before the prompt (founder ask, 2026-07-30)

Someone can connect two things that both saw the same session — most plausibly a watch **and** an
aggregator, e.g. Garmin plus Apple HealthKit, where HealthKit is re-exporting the Garmin recording. One
skate, two rows, and — once B4 exists — **two "add a report?" prompts for the same afternoon**, which is
where the user notices a data problem we could have caught.

**What exists today:** `by_provider_activity` makes ingest idempotent on `(provider,
providerActivityId)` — *within* one provider. There is no cross-source rule, and there can't yet be a
duplicate: `native` is the only provider producing rows, and Strava is **push-only** (we send to them,
they send us nothing). So this is unreachable right now, and that is precisely the argument for settling
it here: the rule has to exist **before** the second source lands, because the first symptom is a
double notification.

**The match rule.** Same `userId`, time intervals that **overlap**, and a compatible resolved body
(equal, or one unresolved). Two recordings of one skate rarely share timestamps — a watch trims
differently, a phone starts in the parking lot — so a start-time equality test would miss most real
duplicates. Overlap plus a start within ~10 minutes is the shape; both constants are tunable with tests,
and both want one round of eyeballing against real dual-source data, the way N6d's 250 m parking radius
does.

**The precedence ladder (D68's discipline, second application).** Keep the best copy, and keep it *as*
the best copy rather than merging geometries — a merge invents a track nobody skated:

1. **Our native recorder** — full fidelity, our own idempotency key, and unambiguously ours to display.
2. **A direct watch connection** (Garmin / COROS / Polar) — watch-grade GPS, ingested under that
   provider's own terms.
3. **An aggregator** (Apple HealthKit / Google Health Connect) — usually carrying *someone else's*
   recording, often downsampled by the round trip.
4. **A Strava-sourced copy**, last — and for a reason that isn't fidelity. **D24 records that Strava's
   terms restrict showing one user's Strava data to other users**, so a Strava copy may be one we can't
   draw on the public aggregate layer at all. The ladder therefore sorts on two axes at once, fidelity
   *and* displayability, and displayability is the one that can't be fixed by better hardware.

**Don't delete the loser.** Mark it superseded (`supersededByActivityId`), the same posture as
water-body dedup: two devices genuinely saw this, the record of that is cheap, and a deletion is
unrecoverable if the ladder was wrong. If the loser already carries a `linkedReportId`, the link
**moves** to the winner rather than breaking — a report must never lose its path to a dedup.

**And it changes B4's timing.** The prompt sweep can't fire the moment a track lands, because the second
source may arrive minutes or hours later (a watch syncs when it feels like it). B4's "still `pending`
after a few hours" window happens to be exactly the settle window dedup needs — so the sweep dedups
first, then notifies **once, on the winner**. That's the same idea as D81 below, at a longer timescale.

---

## Workstream E — Settle before you send (D81)

*Lettered E because it arrived after the first pass; it **sequences with B**, since it changes the shape
every producer is written to.*

### E1 — Route every producer through the queue

Six insert sites write `notifications` directly today — `ratings.ts:140`, `reports.ts:448`,
`bounties.ts:662` and `:760`, plus the two in the flush. Under D81 the first four become `enqueue`
calls, and the flush becomes the only thing that inserts.

A **`SETTLE_MS` of 60 seconds** for actor-triggered notifications. The founder's instinct was "a few
seconds", and a few seconds is the *real* window — a misclick is corrected almost immediately. Sixty is
recommended anyway because the flush cron already ticks once a minute (`crons.ts:13`), so anything
shorter buys nothing measurable: effective latency is 0–60s either way. Sixty covers the slower version
of the same mistake — reading the hazard properly, realising you voted wrong, fixing it.

Coalescing keys on `(recipient, target, kind)`, so five thumbs inside a minute become one *"5 people
found this helpful"* rather than five rows. That is the same `coalesceKey` shape the report buckets
already use.

### E2 — What "still true?" means, per type

The flush loads the trigger and drops the row if it no longer holds:

| Type | Deliver only if |
|---|---|
| `report_rated` (thumb) | the rating row still exists **with the same verdict** |
| `report_rated` (corroboration) | the corroborating report is still `visible` |
| `report_commented` | the comment still exists and is `visible` |
| `hazard_confirmation` | the lifecycle state is still the one that triggered it (B2) |
| `bounty_request` / `bounty_fulfilled` | the bounty is still in the state that triggered it |

A dropped row is deleted, not retried: the thing that would have made it true again is a *new* action,
which enqueues its own row.

**The flip-flop case falls out for free.** Helpful → unhelpful → helpful inside one window is a single
queue row (coalesced) whose trigger re-reads as `helpful` at flush ⇒ exactly one notification. Helpful →
unhelpful ⇒ the row is dropped, and the author is never told about a thumb that isn't there.

### E3 — Where it doesn't apply

The digest and `activity_detected` already wait far longer than any settle window — to 8pm and to the
pending sweep respectively — so they inherit the re-check (B4a's dedup is the same idea at hours rather
than seconds) and need no debounce of their own.

---

## Workstream C — Per-user digest timing

Today: `DIGEST_HOUR = 20`, `DIGEST_TIMEZONE = 'America/New_York'` (`notifications.ts:36–37`), applied
identically to everyone.

**Scoped down by the founder, 2026-07-30: the hour stays 20:00 for everybody. What becomes per-user is
only the *zone*.** No sunset (C2), and no user-set hour — 8pm local is the whole feature, and a setting
for it would be a preference nobody asked for on a settings page that already has ten toggles. That
also keeps this workstream a data change plus one argument, rather than a new pref.

**The code change is small.** `nextZonedHourMs(now, hour, zone)` is already parameterized, and the
fan-out has the recipient's profile in hand when it computes `flushAfter` — so it becomes
`nextZonedHourMs(now, hour, profile.timezone ?? DIGEST_TIMEZONE)`. The work is the data.

### C1 — Where a timezone comes from

| Option | Cost | Problem |
|---|---|---|
| **Store the device timezone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`, refreshed on app open) | free, no dependency | drifts when someone travels; it's the skater's clock, not their home's |
| Derive from `homeCoord` via a tz-boundary lookup | a ~1 MB dependency + a lookup table | `homeCoord` is optional and private (D11); a user without one gets nothing |
| Longitude approximation | trivial | wrong near every zone boundary, and the Northeast has one |

**Recommended: store the device timezone**, fall back to `America/New_York`. The digest is a
*"when will this person look at their phone"* question, and travelling to a different zone is a case
where the device answer is the right one. `homeCoord` derivation stays available as a fallback if a
web-only user turns out to matter.

**Privacy note:** a coarse timezone is a much weaker signal than `homeCoord`, which we already hold and
treat as private. It carries no new exposure, and it doesn't go on a public profile.

### C2 — True sunset: **dropped** (founder call, 2026-07-30), and the reason is the season

The roadmap named "true-sunset" timing as the deferred idea, so it gets a recorded answer rather than a
quiet disappearance. Sunset in Vermont is **~16:20 in early January** and ~20:30 in late June. A digest
whose job is *"here's where to go tomorrow"* would arrive mid-workday at exactly the point in the season
when skating is happening, and late in the evening when it isn't — the signal it tracks runs opposite to
the one we want.

A fixed 20:00 needs no astronomical calculation, no per-body sunrise/sunset fetch, and no explanation to
a user about why their digest moved. **8pm local, everywhere.**

### C3 — The edge worth writing down

`flushAfter` is stamped at **enqueue**, so a user who changes timezone between enqueue and 8pm gets one
digest at the old target. That's acceptable and should be a comment, not a mechanism: the alternative is
re-resolving every queued row on a profile write, which is a lot of machinery for one late-by-an-hour
digest. Coalescing already keeps the earliest `flushAfter` (`enqueue`, `notifications.ts:66`), so the
failure direction is "slightly early", not "never".

---

## Workstream D — The reverse reach index

### D1 — What it replaces, precisely

`fanOutNearbyNotifications` paginates **the entire `profiles` table** per report and runs `bandForCoord`
on each row. Cost is `users × reports`. It is bounded, self-continuing and off the write path (N1) —
it is not a crash risk, it is a bill.

### D2 — The shape, using machinery N1 already built

N1 left a general ladder-grid toolkit: `core/spatialCells.ts` (`cellForPoint`, `indexLevelFor`,
`scanLevels`), `lib/cellIndex.ts` (`diffCells`, the three `sync*Cells` writers) and `lib/cellScan.ts`
(`scanCells`). A fourth index is the same pattern pointed at users instead of water:

**`profileReachCells`** — one row per (profile, level, cell) covering the bbox of that profile's
**reach footprint**: the union of `cachedIsochrones.band30` / `band60` and the `outerRadiusMeters`
circle, bounded by whichever of `allRadiusMinutes` / `greatRadiusMinutes` is larger. Isochrone bands run
roughly 0.5–2° across, so this sits at a coarse rung and a profile costs a handful of rows.

**Read:** for a report on body *B*, look up the cells containing `B.centroid` at every ladder level →
candidate profile ids → load those profiles → **run `bandForCoord` exactly as today** (D80). The walk
becomes a lookup; the eligibility test doesn't change at all, which is what keeps the behavior
byte-identical and the existing tests meaningful.

**Write (the part that will actually cause bugs):** every input to the footprint has to resync it —
`isochrones.storeBands` (:42), `profiles.setHome` (:329), `setNotificationPrefs` (:369, which writes
both radii *and* the digest/great toggles), plus deletion/ghosting and moderation status changes. One
writer, `diffCells`-style, called from all of them. Two or more writers is how a stale row gets born.

### D3 — Fail-open, because the failure is silent

A missing cell row means someone is **not told about ice near them**, and nothing anywhere reports it.
That is the D5 failure mode the fan-out's self-continuing design was chosen to avoid, reintroduced
through the back door.

Three guards, all cheap:

1. **Index only opted-in users** (digest or great enabled with a radius set) — a smaller index, but it
   makes a pref toggle a *reindex trigger*. Get that wrong and turning notifications on silently does
   nothing.
2. **A reindex stamp with a required field.** `reachIndexedAt` as an **optional** field read with a
   range bound is the exact N3 trap (`undefined` sorts first ⇒ `lte(cutoff)` matches everything). Use a
   required field with a sentinel, or an equality on a version literal.
3. **Prove it before retiring the walk.** Run both paths and compare recipient sets on real reports —
   the `waterBodies:viewportReadStats` posture from N1, where the claim stays checkable instead of
   trusted. Keep the walk as a flagged fallback until the comparison is clean.

### D4 — Do this when

There is no user-visible symptom to wait for, so the trigger is cost: **~1,000 profiles**, or the first
report whose fan-out spans more than a handful of pages. Below that, the walk is one page and this index
is machinery guarding nothing. Building it *before* the inbox would be optimizing a pipeline whose
output nobody can see.

---

## What this phase does not cover

- **Push delivery.** Still blocked on APNs/FCM credentials, token registration and a server sender. The
  `coalesceKey` groundwork from Phase 4 stays exactly what it is: a seed for a collapse-id.
  D77's point is that the inbox is not a waiting room for this.
- **Nearby-hazard notifications** (D79) — on-ice proximity is the hazard channel, deliberately.
- **Email notifications.** Resend exists for *operator* alerts (D38) and is credential-blocked anyway.
  Skater-facing email is a separate product decision, not a transport swap.
- **Notification grouping across types.** One digest already groups bodies within itself
  (`flushNotificationQueue`); grouping *across* types is a UI question that needs a real inbox to answer.

---

## Sequencing

1. **A1 + A2 + A3 — the inbox.** The deliverable. Nothing else in this phase is visible without it.
2. **E1 + E2 — route the existing producers through the queue.** Before the new producers, not after:
   B1–B4 should be written against the settled shape rather than converted to it a week later.
3. **B1 (`report_commented`)** — the highest-volume missing producer and the one that makes the inbox
   feel alive.
4. **B2 / B3 (`hazard_confirmation`, `content_flag_resolved`)** — B3 needs the `origin` field first;
   B2 carries the queue-kind rename.
5. **B4 + B4a (`activity_detected`)** — the `promptState` index and one sweep. **B4a's dedup ladder is
   design-only until a second provider exists** — write the rule and its tests, and note in the sweep
   that it currently has one source to choose between.
6. **A5 — the July purge.** One cron in the `storageHygiene` family. Deliberately *after* the producers,
   so it's written against the full set of types rather than half of them.
7. **C — per-user digest zone.** Needs a `timezone` field and a client that writes it; the server half
   is a one-line change.
8. **D — the reverse reach index.** Last, and only past its trigger (D4). It changes no behavior when
   it works, which is precisely why it goes after everything that does.

Steps 1–3 are a shippable phase on their own. If N8 has to be cut short, cut from the bottom.

---

## Settled at scoping (founder, 2026-07-30)

The five questions this document opened with, and their answers — recorded here rather than deleted,
because the *reasoning* is what a later reader needs:

1. **Where the inbox lives on mobile** → **You tab → bell at the top of the profile page → the list**,
   with an unread **dot on the avatar** in the tab bar. No sixth tab; D28's five stand (A3).
2. **`hazard_confirmation` cadence** → **lifecycle transitions, never per vote** (B2).
3. **Retention** → **purge every July**, on N5a's season boundary. Not a TTL — the same clock D66
   already uses for condition photos (A5).
4. **Sunset-timed digests** → **no**. 8pm local stays; only the *zone* becomes per-user (C2).
5. **Notifications whose target was hidden or removed** → **shown, degraded, untappable**. A row that
   silently vanishes reads as a bug (A2).

## Settled in the second pass (founder, 2026-07-30)

6. **Auto-filed flags never notify** (B3). Not because there's no human — there always is, the field is
   required — but because it's the **wrong** human: the rater whose thumb crossed a threshold, not
   someone who filed a report. Needs a new `origin: 'user' | 'auto'` on `contentFlags`, defaulting to
   silence when absent.
7. **The `hazard_confirmation` collision resolves by renaming the outbox** (B2): the offline queue's
   `kind` becomes `confirmation_vote`. Local to mobile, no stored rows, no wire format — a
   find-and-replace, against a migration on the notification type.
8. **One skate from several sources dedups before it prompts** (B4a). Overlap-based matching plus a
   four-rung precedence ladder that sorts on fidelity **and** displayability — D24's Strava
   cross-user restriction is why the second axis exists. Loser rows are superseded, never deleted.
9. **Notifications settle before they send** (D81 / Workstream E). 60-second window, and the trigger is
   **re-read at flush** rather than cancelled at undo — one place to get right instead of every undo
   path in the app.

## Open questions remaining

None blocking. Two constants want one round of real data before they're trusted, both flagged in place:
B4a's overlap/start-time thresholds (needs an actual dual-source user) and D4's reverse-index trigger
(needs a profile count we don't have yet). Neither gates the build.
