# A08 — The notification pipeline: the inbox, the missing producers, and the reverse reach index

> **Status:** ✅ **COMPLETE (2026-09-15)** — four PRs off `phase-n8-notification-pipeline`, all on
> dev: **PR 1** (inbox + settled queue + producers §2.1–§2.3) #52; **PR 2** (§2.4/§2.4a, §1.5 purge, §3
> timezone) #53; **PR 3** (transports: push, email, offline inbox cache) #55; **PR 4** (the coverage
> audit's findings: the Clerk mirror refresh, change-email on both clients + the Clerk webhook, the
> Android small icon, the pipeline to 100% lines) — branch `phase-n8-notification-pipeline-4`. Push credentials
> are in for both platforms; the Clerk webhook endpoint + secret are registered on dev. What is
> still owed is listed under [Deferred](#deferred), and none of it is code this phase left unwritten.
> Prod deferred with everything else. Scoped 2026-07-30 with a
> founder call of **no A08 code until every A06 phase has shipped**; A06 closed 2026-09-10.
> **Scope grew at kickoff (founder, 2026-09-11):** push (Android via FCM now; iOS APNs key once
> enrolled) and **email** (Resend is live on dev) come *in*, as transports over the same rows — see
> [What this phase does not cover](#what-this-phase-does-not-cover) for what that changed.
> **Depends on:** nothing. It touches no water-body data and no A06 surface.
> **Touches:** `notifications` / `notificationQueue`, `profiles.notificationPrefs`, the Phase 03 comment
> path, the Phase 07 moderation queue, the Phase 09a hazard-confirmation loop, the Phase 08 recorder, and
> both clients' shells.
> **Decisions:** logged as **D170–D174** in [`01-decisions.md`](../01-decisions.md) — the numbers this
> document proposed (D77–D81) were taken by A05c and A06b before it was built. The mapping: D77→**D167**
> (inbox first), D78→**D168** (producer + renderer or no type), D79→**D171** (hazards don't broadcast),
> D80→**D172** (reverse index filters candidates; deferred), D81→**D169** (settle + re-check).
> **D173** (`bounty_answered`) was found at kickoff; **D173** is Workstream 3's call; **D174** is the
> transports — see the built records below.

---

## Why this is its own pass

The roadmap's A08 entry is two bullets — per-user digest timing and a reverse spatial index — grouped
because neither needs push credentials. Both are real, both are correctly described, and **neither is
the thing wrong with the notification pipeline.**

Every phase since Phase 03 has said some version of *"push delivery is deferred; this lands an in-app
`notifications` row."* Phases 03, 04 and 06 all say it. It is the sentence that made deferring push
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
| `report_rated` | `ratings.ts:140` (a thumb on your report **or hazard**) | Phase 06 |
| `report_rated` | `reports.ts:448` (your report was corroborated) | Phase 06 |
| `bounty_request` | `bounties.ts:662` (a bounty on a water body you recently reported) | Phase 06 |
| `bounty_fulfilled` | `bounties.ts:760` (your bounty was answered) | Phase 06 |
| `favorite_report` | `notifications.ts` flush | Phase 04 |
| `nearby_report_digest` | `notifications.ts` flush | Phase 04 |
| `great_report_nearby` | `notifications.ts` flush | Phase 04 |

That is the phase. Everything else here is smaller.

### Correction 2: four of the ten declared types have no producer

`NOTIFICATION_TYPES` and `NOTIFICATION_PREF_KEYS` (`lib/enums.ts`) are ten long and kept in lockstep, so
`/settings` renders ten toggles. Four of them cannot fire:

- **`report_commented`** — deliberate and documented (`comments.ts:8,40`, D21/Phase 03).
- **`hazard_confirmation`** — never produced. The string is *also* used by
  `packages/core/src/hazardQueue.ts:95,161` for the Phase 09b on-ice **local** alert queue, which never
  touches this table. One name, two mechanisms, no connection between them.
- **`content_flag_resolved`** — never produced. `moderation.resolveFlag` (`moderation.ts:95`) writes the
  terminal status and an audit row, and tells the flagger nothing.
- **`activity_detected`** — never produced, and *its source was cut*: D24 framed it as "an ice-skate
  detected on any linked provider", and Phase 08 replaced provider **pull** ingest with our own recorder
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
  (`FANOUT_PAGE_SIZE`), self-continuing, off the write path since A01. With dozens of users it is one
  page.
- **Per-user digest timing** has nothing to derive a timezone from. `profiles` stores `homeCoord`
  (optional, private) and no timezone field. `nextZonedHourMs` (`core/schedule.ts`) is already per-call
  parameterized on hour + zone, so the *math* is done — the missing piece is data, not code.

Neither is wrong. Both are behind the inbox in every ordering that a user would recognize.

### Correction 5: the hazard channel is already decided, and it isn't this one

Hazards generate **no** `notifications` rows at all — `hazards.ts` contains no notification code. That
looks like an omission and isn't: Phase 09b made the hazard channel a client-side **proximity** alert
fired while you're on the ice, deliberately local and offline-capable. Founder call, 2026-07-30:
**keep it that way** (D79). A push about a hazard on a water body you are not standing on is a different
product decision, and not this phase's.

The distinction that survives: **author-directed** hazard notifications are in scope (§2.2 — someone
confirmed or disputed *your* hazard), because that's feedback on your own contribution, not a broadcast.

---

## Decisions proposed at scoping (2026-07-30)

### D77 — A notification nobody can read is not deferred delivery, it's a dropped feature

Push is a **transport**. The in-app row was always meant to be the product, and every "delivery
deferred" note since Phase 03 assumed a surface that reads the table. Until that surface exists, six
notification types are dead code with a settings page in front of them.

**So the inbox ships first**, and from here on the rule is: *a notification type may not be added
without a producer **and** a place it renders.* The push layer, when the credentials land, becomes a
second transport over the same rows — not the moment the feature starts existing.

### D78 — Every declared type has a producer, or it isn't a type

Four inert toggles are worse than four missing ones: they tell a user they've configured something.
Founder call — **generate them** (§2.1–§2.4) rather than strike them. Where a producer genuinely cannot
exist yet, the type and its toggle come *out* until it can, so the settings page never advertises a
channel that can't fire.

### D79 — Hazards do not broadcast; on-ice proximity remains the hazard channel

Founder call, 2026-07-30. A hazard alert is a *presence* signal — it matters when you're on that ice,
which is exactly what Phase 09b built, offline and without a server round trip. Adding a "new hazard
near you" push would put safety content on the least reliable transport we have (deferred, throttled by
iOS at its discretion, D54) for a skater who by definition isn't there.

**In scope regardless:** `hazard_confirmation` to the hazard's **author** (§2.2). Feedback on your own
contribution is not a broadcast.

### D80 — The reverse reach index filters candidates; it never replaces the eligibility test

The fan-out's cost is that it *examines* every profile. It is not that it examines them wrongly: each
check is a real polygon test (`bandForCoord`, `core/driveTime.ts:50`) against that viewer's own cached
isochrones. A cell index can cheaply say *"these profiles could plausibly reach this water body"* — it cannot
say who qualifies, because a bbox is not a band.

So the index returns **candidates**, and the exact test still runs per candidate — the same discipline
A01 established for `waterBodyCells`, where cells cover a bbox and the caller still filters. And because
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

## §1 — The inbox (the deliverable)

### §1.1 — The read path

Three functions in `notifications.ts`, all public:

- **`list`** — paginated over `by_user`, newest first, for the signed-in user only. Paginated rather
  than capped: a year-old notification history is unbounded, and `.collect()` on a per-user table is
  the pattern A01 spent a phase removing.
- **`unreadCount`** — for the badge. Add an index on `['userId', 'readAt']` and query
  `eq('userId', me).eq('readAt', undefined)`. Worth being explicit, because this repo has been bitten
  here: an index on an optional field is **not sparse**, and `undefined` sorts before every number — but
  that trap is about **range** bounds (`lte`), and this is an **equality**, which is exactly the shape
  that behaves. (See the A03 finalize-cron bug in [`phases/A03-A04-account-lifecycle.md`](./A03-A04-account-lifecycle.md).)
  If the count proves hot, the fallback is a denormalized counter on `profiles` in the Phase 04
  contribution-counter pattern — but measure first.
- **`markRead`** — stamp `readAt` on one row or on everything up to a timestamp. Owner-only.

Rows already die with the account (`accountDeletion.ts:537`); their *own* retention is A5.

### §1.2 — The resolver, and why it's the actual work

A notification row is ids in a `v.any()` payload. Rendering "Ellie found your report on Lake Morey
helpful" means resolving those ids, and the resolution has to survive the content having changed since:

- **The target may be hidden or removed** (D32 moderation) — render the notification degraded
  ("a report that's no longer available") and never make it a dead tap. It must not vanish either: a
  disappearing inbox row reads like a bug.
- **The actor may have departed.** Under the D62 second amendment they're anonymized, not erased, so
  the existing `{ displayName: 'Unknown', … }` shape from `reports`/`comments`/`bounties` is reused —
  not reinvented.
- **The actor may be blocked.** Block == mute (Phase 03): a block doesn't hide content, but it must not
  ring your phone. The inbox filters actor-keyed notifications through `loadBlockedAuthorIds`
  (`lib/reportVisibility.ts`) at **read** time, so an old block applies to old rows too.
- **`report_rated` needs discriminating** (Correction 3) — one type, two shapes, and hazards riding the
  report-shaped channel. The resolver is where that gets typed; the alternative is two clients guessing.

Batch-load per page. One notification page must not become N round trips — the N+1 shape that
`contradictionCluster` hid inside A01's read path.

### §1.3 — Where it renders

- **Web:** a bell in `AppShell.tsx` (:41 is the existing nav row) with an unread dot, opening
  `/notifications`. A route, not a popover-only surface, so it's linkable and testable.
- **Mobile (founder call, 2026-07-30):** the tab bar stays **five co-primary tabs** (D28/`00-vision`,
  `app/(tabs)/_layout.tsx`) — no sixth tab. The path is **You tab → bell in the top corner of the
  profile page → the list**, and the unread signal is a **dot on the avatar** in the You tab, so the
  badge is visible from anywhere in the app without spending a tab on it.

  Worth naming because it constrains §1.1: the avatar dot is rendered on *every* screen with the tab bar,
  so `unreadCount` is effectively a subscription running app-wide. It has to stay a single indexed
  count — a boolean "any unread" would be cheaper still, and is the fallback if the count is ever hot.

Both surfaces read the same three functions and the same resolver output, so "web and mobile agree" is
structural rather than a review checklist item.

### §1.4 — What the inbox must not become

Not a feed. The newsfeed (Phase 05) is the place for *what happened on the ice*; the inbox is *what
happened to you and your contributions*. If a notification type would be equally at home in the feed, it
probably belongs there instead — which is most of the argument for D79.

### §1.5 — Retention: the inbox empties at the season boundary

Founder call, 2026-07-30: **purge notifications each July**, on A05a's season rollover (July 1, D63).

It's the right clock rather than a convenient one. Every notification we generate is about a *moment* —
someone thumbed your report, a bounty opened on a water body, three water bodies near you had new ice. None of that
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
the record of what happened to their contributions, that's the **data export** (A03), which reads the
live tables — not the inbox.

---

## §2 — The four missing producers (D78)

### §2.1 — `report_commented`

**Trigger:** `comments.create` (`comments.ts`), after the insert. Notify the **report author**, and for
a reply, also the **parent comment's author**.

**Gates:** never self; `canReceiveNotifications` (`lib/auth.ts:171`); `prefs.reportCommented`; skip if
the recipient blocks the commenter (block == mute — and the §1.2 read-time filter is a backstop, not a
substitute).

**Coalesce it.** A busy report gets a burst of comments, and the `notificationQueue` already solves
exactly this: a fourth `kind` (`comment`) keyed `(user, report, kind)` with the existing `DEBOUNCE_MS`
gives *"3 new comments on your report"* instead of three rows. This is reuse of built machinery, not new
machinery — the queue was designed generically and has only ever had report buckets in it.

**Already handled elsewhere:** a departed author. `setNotificationPrefs` carries a note about a ghost's
kept reports still drawing comments while the mute switch is closed (A05a review, item 3); the answer
landed in `canReceiveNotifications` at both enqueue *and* flush (`notifications.ts:261–279`). §2.1 inherits
both gates by using the same path.

### §2.2 — `hazard_confirmation`

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

### §2.3 — `content_flag_resolved`

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

### §2.4 — `activity_detected`, re-derived from a source that exists

D24's premise — "detected on any linked provider" — was retired with the Phase 08 pivot to push (L7), and
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

#### §2.4a — One skate, several sources: dedup before the prompt (founder ask, 2026-07-30)

Someone can connect two things that both saw the same session — most plausibly a watch **and** an
aggregator, e.g. Garmin plus Apple HealthKit, where HealthKit is re-exporting the Garmin recording. One
skate, two rows, and — once §2.4 exists — **two "add a report?" prompts for the same afternoon**, which is
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
and both want one round of eyeballing against real dual-source data, the way A06d's 250 m parking radius
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

## §5 — Settle before you send (D81)

*Lettered E because it arrived after the first pass; it **sequences with B**, since it changes the shape
every producer is written to.*

### §5.1 — Route every producer through the queue

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

### §5.2 — What "still true?" means, per type

The flush loads the trigger and drops the row if it no longer holds:

| Type | Deliver only if |
|---|---|
| `report_rated` (thumb) | the rating row still exists **with the same verdict** |
| `report_rated` (corroboration) | the corroborating report is still `visible` |
| `report_commented` | the comment still exists and is `visible` |
| `hazard_confirmation` | the lifecycle state is still the one that triggered it (§2.2) |
| `bounty_request` / `bounty_fulfilled` | the bounty is still in the state that triggered it |

A dropped row is deleted, not retried: the thing that would have made it true again is a *new* action,
which enqueues its own row.

**The flip-flop case falls out for free.** Helpful → unhelpful → helpful inside one window is a single
queue row (coalesced) whose trigger re-reads as `helpful` at flush ⇒ exactly one notification. Helpful →
unhelpful ⇒ the row is dropped, and the author is never told about a thumb that isn't there.

### §5.3 — Where it doesn't apply

The digest and `activity_detected` already wait far longer than any settle window — to 8pm and to the
pending sweep respectively — so they inherit the re-check (B4a's dedup is the same idea at hours rather
than seconds) and need no debounce of their own.

---

## §3 — Per-user digest timing

Today: `DIGEST_HOUR = 20`, `DIGEST_TIMEZONE = 'America/New_York'` (`notifications.ts:36–37`), applied
identically to everyone.

**Scoped down by the founder, 2026-07-30: the hour stays 20:00 for everybody. What becomes per-user is
only the *zone*.** No sunset (§3.2), and no user-set hour — 8pm local is the whole feature, and a setting
for it would be a preference nobody asked for on a settings page that already has ten toggles. That
also keeps this workstream a data change plus one argument, rather than a new pref.

**The code change is small.** `nextZonedHourMs(now, hour, zone)` is already parameterized, and the
fan-out has the recipient's profile in hand when it computes `flushAfter` — so it becomes
`nextZonedHourMs(now, hour, profile.timezone ?? DIGEST_TIMEZONE)`. The work is the data.

### §3.1 — Where a timezone comes from

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

### §3.2 — True sunset: **dropped** (founder call, 2026-07-30), and the reason is the season

The roadmap named "true-sunset" timing as the deferred idea, so it gets a recorded answer rather than a
quiet disappearance. Sunset in Vermont is **~16:20 in early January** and ~20:30 in late June. A digest
whose job is *"here's where to go tomorrow"* would arrive mid-workday at exactly the point in the season
when skating is happening, and late in the evening when it isn't — the signal it tracks runs opposite to
the one we want.

A fixed 20:00 needs no astronomical calculation, no per-body sunrise/sunset fetch, and no explanation to
a user about why their digest moved. **8pm local, everywhere.**

### §3.3 — The edge worth writing down

`flushAfter` is stamped at **enqueue**, so a user who changes timezone between enqueue and 8pm gets one
digest at the old target. That's acceptable and should be a comment, not a mechanism: the alternative is
re-resolving every queued row on a profile write, which is a lot of machinery for one late-by-an-hour
digest. Coalescing already keeps the earliest `flushAfter` (`enqueue`, `notifications.ts:66`), so the
failure direction is "slightly early", not "never".

---

## §4 — The reverse reach index

### D1 — What it replaces, precisely

`fanOutNearbyNotifications` paginates **the entire `profiles` table** per report and runs `bandForCoord`
on each row. Cost is `users × reports`. It is bounded, self-continuing and off the write path (A01) —
it is not a crash risk, it is a bill.

### D2 — The shape, using machinery A01 already built

A01 left a general ladder-grid toolkit: `core/spatialCells.ts` (`cellForPoint`, `indexLevelFor`,
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
   range bound is the exact A03 trap (`undefined` sorts first ⇒ `lte(cutoff)` matches everything). Use a
   required field with a sentinel, or an equality on a version literal.
3. **Prove it before retiring the walk.** Run both paths and compare recipient sets on real reports —
   the `waterBodies:viewportReadStats` posture from A01, where the claim stays checkable instead of
   trusted. Keep the walk as a flagged fallback until the comparison is clean.

### D4 — Do this when

There is no user-visible symptom to wait for, so the trigger is cost: **~1,000 profiles**, or the first
report whose fan-out spans more than a handful of pages. Below that, the walk is one page and this index
is machinery guarding nothing. Building it *before* the inbox would be optimizing a pipeline whose
output nobody can see.

---

## Built record — PR 1 (2026-09-11)

What shipped, and where it departed from the sections above. The sections are left as written; this
is the diff.

**Shipped:** §1.1 (`list` paginated + resolved, `unreadCount` on a new `by_user_read` index capped at
99, `markRead` one-or-all-before), §1.2 (`lib/notificationResolve.ts` — degraded targets, tombstone
names via `publicAuthor`, read-time block filtering, an `unknown` variant for unparseable payloads,
one memoized loader per page), §1.3 (web `/notifications` + bell in `AppShell`; mobile `You → bell →
modal list` with a dot on the You tab icon), §5.1/§5.2 (`lib/notificationQueue.ts` — every actor
producer enqueues with `SETTLE_MS = 60 s` and a typed `trigger` the flush re-reads), §2.1, §2.2, B3.

**Departures worth knowing:**

0. **Review pass (local, high):** `list` fails soft (empty page, not a throw) for the frame before
   the client has its token; `markRead` walks the unread index **newest-first** so the rows a page
   just showed are the ones stamped; both lists mark read **once, on first load** — a notification
   arriving while the page sits open stays unread until the next visit.
   *Second pass (xhigh):* the bound is the **server's now**, not the newest unread row the list
   showed — `list` omits rows whose actors are all blocked but `unreadCount` counts them, so a
   list-derived bound left the bell lit forever for a row nobody could see. The once-latch sets on
   the first page landing — regardless of whether it had rows, so an inbox opened all-read no
   longer stamps the next arrival on sight — and is gated on `useConvexAuth`, not on rows being
   present (Greptile pass): an inbox whose every row is a blocked actor's lists nothing while the
   bell still counts them, so a rows guard would never clear it. Also: `answeredByMyReport` counts
   fulfilled/expired bounties too (open-only made the line vanish the moment the requester's thumb
   landed), and only the author subscribes to it.
   *Third pass (xhigh, post-merge):* the row dot was dead UI — the list is reactive, so the moment
   `markRead` landed every row re-rendered as read. `markRead` now returns the ids it stamped and
   both clients draw the dot from a visit-scoped set (seeded from the page in hand, widened by the
   server's answer), so "new since last visit" survives the stamp. `enqueueActorNotification`
   derives `type` from the trigger kind (`TYPE_FOR_KIND`) instead of taking it as a second argument.
   *Fourth pass (founder, post-Greptile):* the flush was re-batched. `FLUSH_BATCH_CAP` 1,000 → **250**
   — it was sized when a row cost two reads, and an actor row now costs ~3 + N, so a full batch sat
   at the 4,096 read ceiling with zero coalescing and would have wedged on the same rows every
   minute. A full or budget-stopped batch (`FLUSH_READ_BUDGET` 3,000, a running tally) **schedules
   its own continuation**, so the cap bounds a transaction, not throughput. And **a digest is
   assembled from `by_user`, not from the batch slice**: every digest row is due at the same 8pm, so
   `by_flush` interleaves users by creation order and a user's rows are never contiguous — the old
   "straddles the cap ⇒ two digests" edge is gone, with nothing re-run. The founder's first
   framing ("drop the user, reset the pointer to the start of them, re-run in full") assumed a
   contiguity the scan doesn't have; the per-user index gives the same guarantee without it.
1. **The plan miscounted the toggles.** Both settings pages rendered *three* (the Phase-04 set), not
   ten. They now iterate `NOTIFICATION_PREF_ORDER` from `@skating/core`, where the vocabulary, the
   labels and `describeNotification` (the sentence both clients render) now live.
2. **`bounty_fulfilled` was misdescribed** — it went to the fulfiller, and nobody told the requester a
   report had arrived. It is now `bounty_answered`, to the requester, on attach (D170). The pref key
   renamed with it (`bountyAnswered`); `backfillNotificationPrefs` migrates the profile objects.
   **⚠ Dev deploy recipe** (prod has no profiles, so this is dev-only): `boolFlags` is a strict
   `v.object`, so the narrow schema in this tree rejects every existing profile on push. Widen
   *locally and uncommitted* — in `schema.ts` replace `boolFlags(NOTIFICATION_PREF_KEYS)` with
   `v.object({ ...boolFlags(NOTIFICATION_PREF_KEYS).fields, bountyAnswered: v.optional(v.boolean()),
   bountyFulfilled: v.optional(v.boolean()) })` — push (`convex dev --once`), run
   `profiles:backfillNotificationPrefs`, revert the local edit, push again. Recorded here rather than
   committed because the transitional shape is one deploy long and would otherwise look like the
   schema.
3. **The queue-kind rename had stored state.** §2.2 said "no database rows, no wire format" — but
   `draftStore` persists the `kind` in a SQLite column *and* inside the JSON blob. Renamed anyway
   (founder: "now is the time"), with a one-shot `UPDATE … json_set` in `ensureSchema`, tested against
   a real SQLite engine like the existing column migration.
4. **`hazard_confirmation` fires on a *phase* transition** — `hazardLifecyclePhase()` in core:
   `archived > disputed > healing_unsafe > confirmed > provisional` — and a slide *back to provisional*
   stays quiet (a confirmer changing their mind is not news the author can act on). Archive is sticky in
   `deriveHazardLifecycle`, so the flip-flop case in §5.2 resolves to `archived`, not back to active.
5. **The "still true?" table gained a column.** Coalesced triggers accumulate ids (`actorIds`,
   `commentIds`, `byReportIds`, `reportIds`) and each is re-verified individually at flush, so a
   retracted thumb drops out of the *count* rather than dropping the row. The recipient's own toggle
   and block set are re-read at flush as well.
6. **`payload` stays `v.any()`.** Typing it in the schema would have forced a migration for four
   never-seen rows; the resolver types it at the boundary and the season purge retires the old shapes.
7. **`unreadCount` answers 0 without a profile** rather than throwing — both shells subscribe from a
   layout that can render a frame before the row exists.
8. **Workstream 4 is deliberately unbuilt** (D172). Dev has three profiles.
9. **`bounties.answeredByMyReport`** backs the post-submit "at least N skaters were looking forward to
   it" line on both report-detail views; it answers 0 to anyone but the author.

## Built record — PR 2 (2026-09-11)

**Shipped:** §2.4 (`gpsActivities.sweepUnpromptedActivities`, hourly; `by_prompt_state_detected` index;
`ACTIVITY_PROMPT_DELAY_MS = 3 h`), §2.4a (`core/activityDedup.ts` — overlap + 10-minute start window +
compatible body, the four-rung ladder, `supersededByActivityId`, the link moves to the winner; the
sweep runs it per user over that user's recent rows, not only the due ones), §1.5
(`storageHygiene.purgeLastSeasonNotifications`, daily, `notifications.by_created_at`), C
(`profiles.timezone`, `profiles.setTimezone` validated through `Intl`, both shells write it on app
open via core's `deviceTimeZone`/`timezoneNeedsSync`; the fan-out stamps `nextZonedHourMs(now, 20,
p.timezone ?? DIGEST_TIMEZONE)`). Logged as **D173**.

**Departures worth knowing:**

1. **The sweep flips a superseded loser to `dismissed`** as well as stamping `supersededByActivityId`,
   so every existing reader that filters on `dismissed` (the You-tab list) hides it without learning
   the new field; `listMine` also filters on the field directly.
2. **The sweep marks `prompted` even when the toggle is off** — "considered" is what the state means,
   and a row that stayed `pending` would be re-examined every hour for ever.
3. **Found and fixed on the way:** `profiles.backfillNotificationPrefs`'s hand-written
   `PROFILE_FIELDS` had drifted six fields behind the schema, so running it (as the PR 1 rename
   requires) would have stripped `deletionRequestedAt`, `excludeTracksFromAggregate`,
   `activeBountyPostLimit`, `photosExpiredForSeason` and `photoReconcileStartedAt` from every profile.
   It now reads the schema's own field list.
4. **The dedup ladder is exercised end-to-end in a test with a hand-inserted `garmin` row**, since no
   adapter produces one; the constants are pinned by tests, not by data, as the plan said they would be.
5. **Review pass (xhigh):** the link *moves* (the loser's `linkedReportId` is cleared, and only for
   an intact pair — otherwise the aggregate layer drew the skate twice); a loser already `prompted`
   or `dismissed` hands that answer to the winner so a phone copy flushing a day after the watch copy
   never asks twice; minors and `canPostReports === false` are flipped to `prompted` but never nudged
   toward a form that refuses them; the sweep reads 50 due rows × a 50-row window each per tick (worst
   case ~2.7k reads; see 7 for the window) and unions the due rows into the candidate set so none can be
   stranded; the
   purge self-continues while truncated; `activity_detected` shows the skate's time as its detail.
6. **"Not now" on the recorder's stop card is a deferral, not a dismissal — deliberately.** The card
   clears its own state and leaves the row `pending`, so the sweep nudges once, three hours later.
   That is the reminder "not now" asks for; the You-tab list's "Not reporting this one" is the
   `dismissed` that means never, and the sweep respects it. Recorded because the review read the stop
   card as a bug; changing it would mean carrying a decline through the offline track queue to
   `ingestTrack` for a behaviour nobody wants.
7. **Greptile pass (latent, multi-provider only):** the dedup candidates are now read as **one
   start-time window per due row** (new `by_user_start_time` index, ±`ACTIVITY_DEDUP_START_WINDOW_MS`)
   rather than the user's fifty most recently *inserted* rows — the latter dropped an already-prompted
   copy behind fifty later syncs and asked about the skate twice. A consequence worth knowing: an
   *unrelated* due skate no longer pulls a not-yet-due pair into an early dedup; the pair waits for
   one of its own copies to come due, which is the tick that can see it. And `listTracksForBody`
   decides a superseded copy that *kept* its link against its winner — skipped if the winner draws
   on its own terms (track + visible report), drawn if it can't (a path-less stub, or a report hidden
   since, walking the whole supersession chain so an undrawable intermediate can't let an older copy
   render beside the terminal winner) — so both copies reported from draws once, and a published skate never vanishes because its
   better-ranked copy can't draw (the blanket "superseded never draws" of the first cut did exactly
   that; the second cut checked the path but not the report). The aggregate read now **scans until
   `limit` drawable tracks are in hand** (`TRACK_SCAN_CAP` = 2×), instead of `take(limit + 1)` and
   skipping inside the slice — every skip reason, not only this one, used to spend a slot; and
   `truncated` is now an honest flag (a drawable past the limit, or a scan that hit its cap). `listMine`'s filter-before-take was
   already in from pass 5. *Second pass (xhigh):* a late `linkActivityToReport` follows the dedup
   chain to the winner, stopping short of a path-less one or one already reported (it links the copy
   it was filed from — the sweep's own can't-move state); the sweep's move refuses a path-less winner
   and carries the loser's water body onto an unresolved one; dedup body-matching considers every body a
   spanning skate touched. Also: `PastWeatherPanel.test.tsx` (A06h) waited on a heading that renders
   in the loading state too, then asserted synchronously — a race a slow CI runner lost; it now
   waits for the loading line to clear.

## Built record — PR 3 (2026-09-12)

**Shipped (D174):** `pushTokens` table + `pushTokens.register/unregister`; `notificationDelivery.ts`
(`loadForDelivery` → `deliverBatch` → `markDelivered`; `checkPushReceipts` 15 min later;
`disableTokens` on `DeviceNotRegistered`) scheduled by the flush in batches of 200; `lib/expoPush.ts`
(chunked send, receipts, never throws); email via `lib/resend.ts` (now with headers, and a 429
retry that honours `Retry-After` — Resend's default is 2 req/s, a digest batch is faster) rendered
by `lib/notificationEmail.ts`; `profiles.email` mirrored from the identity's `email` claim,
`profiles.channelPrefs`, `profiles.emailUnsubscribeSecret`, `profiles.setChannelPrefs`; the
`/unsubscribe` HTTP route (GET is a confirm page that changes nothing — link scanners follow every
URL in a mail — and POST is the one-click, from the page's button or the mail client's);
`notifications.pushedAt/emailedAt` stamps, the push stamps written before the email pass starts.
Mobile: `pushRegistration.ts` (register-if-permitted on open, the "this phone" switch, device opt-out
in the prefs db), tap handling in the tabs layout (`data.target` → `notificationRoute`), the offline
inbox cache + read overlay + replay (`notificationCache*.ts`), the tab dot reading the cache offline.
Web: the two channel checkboxes. `app.config.ts` picks up `google-services.json` when present.

**Founder tasks to make it live** (none block the merge; the code is credential-blind):
1. Firebase project → `google-services.json` → EAS file env `GOOGLE_SERVICES_JSON` + FCM V1 key via
   `eas credentials`; new Android build. Recipe in
   [`05-accounts-and-credentials.md`](../05-accounts-and-credentials.md) §11.
2. `eas credentials` → iOS → push key (Apple Developer account is enrolled). Untestable without an
   iPhone; the code path is identical.
3. Confirm the Clerk `convex` JWT template maps `email` (the default does). If not, the sender's
   Clerk fallback covers it at one call per person, once.

**Departures worth knowing:**
1. **No `expo-device`.** Whether a token can be minted is learned from the token call itself rather
   than a native dependency for one boolean.
2. **Collapse ids are hashed** to iOS's 64-byte cap from the coalesce key (FNV-1a suffix), so a later
   push on the same key replaces the earlier one on the lock screen.
3. **The delivery action is idempotent by stamp**, not by scheduler guarantee: `loadForDelivery`
   returns a channel `null` once the row is stamped for it, so a batch that ran twice sends nothing
   twice.
4. **Email defaults on.** The eligible types are low-volume and mostly opt-in already (the digest is
   off by default); every mail can be silenced in one click.

## Built record — PR 4 (2026-09-14 → 15)

A coverage audit against every commitment above — ten producers, one writer, both shells, both
transports, offline, deletion — found the matrix built and deployed. What it changed and what it left:

**Fixed — the Clerk mirror never populated.** PR 3 (and D174) said `profiles.email` was refreshed at
`upsertFromClerk` "every cold start". Both clients call that mutation from the **onboarding screen
only**, so every dev profile had `email: undefined` — including the founder's, after an app open that
same afternoon — and the JWT template was never the problem (it maps `email`; checked). The sender's
Clerk fallback hid it (one lookup per person, cached onto the row), but a cached address is exactly
what goes stale when someone changes it. `profiles.syncFromClerk` — claims only, no identity args,
fail-soft, the same never-un-scrub guard — now fires beside `setTimezone` in both shells, and picks
up the avatar mirror (`profileImageUrl`), which had had the same hole since Phase 03. Founder task #3
above is therefore closed in the other direction: the template was right, the caller was missing.

**Built — change-email on both clients, and the Clerk `user.updated` webhook that goes with it.**
`syncFromClerk` closes the stale-address window at the next app *open*, which leaves open exactly
the email channel's own user: someone who changed their address and then didn't open the app for a
season, still receiving the digest at the old one. Two things closed it in the same pass, because
neither is complete without the other:

- **Neither client had a way to change your Clerk email** — no `<UserProfile>`, no custom flow —
  so the window could only be opened from the Clerk dashboard. Now: `@skating/core`'s
  `changeEmail.ts` (add → code → verify → make primary → release the old one; written against a
  structural slice of Clerk's `UserResource`, so core carries no Clerk dependency and the fake-driven
  tests are the contract), rendered as `ChangeEmail` in web Settings and in the mobile You tab.
  Once primary has moved, the old address has three fates and the copy names each: *removed*;
  *kept* because it is the identifier for a connected sign-in (read from `linkedTo` ahead of time,
  never inferred from a thrown error — Clerk refuses to destroy such an address, and primary is
  what the mirror follows, so the change is still complete); or *remove failed* for some other
  reason (a network error), which is told as exactly that with a "Remove old address" retry. The
  first cut had collapsed the last two into one story about Google — Greptile's one finding on
  PR #57.
- **`POST /clerk-webhook`** (`http.ts`), verified by `standardwebhooks` — the library under Clerk's
  own `verifyWebhook`, taken directly because `@clerk/backend` would have pulled `@clerk/shared`
  into the Convex bundle, and that package is the one this repo carries in two majors. A signed
  `user.updated` runs `profiles.applyClerkMirrors`, the *same* helper `syncFromClerk` uses (an
  address removed in Clerk clears the mirror; a ghost is never un-scrubbed). Bad signature,
  tampered body, stale timestamp, missing headers ⇒ 400; no secret configured ⇒ 500, so the
  misconfiguration is loud and Svix retries. `user.deleted` is acknowledged and not acted on:
  finalization deletes the Clerk user itself, so the ordinary arrival is for a tombstone, and a
  dashboard deletion of a live account is a founder action the D62 lifecycle should own, not a
  half-erase from a webhook.
- **The two writers are ordered by Clerk's clock.** Svix retries are unordered, and a launch-time
  sync can run on a template token Clerk cached *before* the change the webhook already applied
  (about a minute's window). Both carry Clerk's `updated_at` — the JWT template already mapped it —
  so `applyClerkMirrors` stamps `profiles.clerkUpdatedAt` and refuses a write stamped older. Found
  by the xhigh review pass, along with a real dead end: Clerk refuses to re-verify an address it
  already holds verified (a Google-linked one that stayed as a secondary, or a retry after
  make-primary failed), so `changeEmail` skips the code for a verified address and both clients go
  straight to make-primary. And `primaryEmailOf`'s fallback now takes the first *verified* address
  or nothing — the first address on an account mid-change is the unverified one it just added.

**Founder task, per Clerk instance:** register the endpoint and set `CLERK_WEBHOOK_SIGNING_SECRET`
— recipe in [`05-accounts-and-credentials.md`](../05-accounts-and-credentials.md) §11b. Until then
the route answers 500 and the launch-time sync is the only refresh.

**Not yet exercised.** No `notifications` row on dev carries `pushedAt` or `emailedAt` — the rows
that exist predate PR 3 — and no profile has an `emailUnsubscribeSecret`, which is minted on the
first mail. So the 2026-09-14 Android push proved the credentials, not `flush → deliverBatch`; the
`/unsubscribe` route has never been hit outside tests. One deliberate trigger from a second account
(a thumb for the push-only path, a bounty on a water body the founder reported for the email path) is the
outstanding smoke.

**Credentials are complete on both platforms** — FCM V1 key, `google-services.json` and the APNs
key all landed on EAS on 2026-09-14 (founder tasks 1 and 2 above). iOS stays untested only for
want of an iPhone; the code path is the Android one.

**Shipped 2026-09-14:** the Android **small icon**. The status bar had shown a solid disc — Android
treats the small icon as an alpha mask and paints every opaque pixel, and the launcher icon's navy
background is all opaque. Now `['expo-notifications', { icon, color }]` with a white-on-transparent
96 px wordmark tinted in the ice accent (`ice[500]`); native config, so it rode a preview rebuild
that also carried the post-Greptile JS and `syncFromClerk` to the phone.

**Coverage.** Every A08 file is at 100% lines except two dead-by-construction spots left dark on
purpose (`notifications.ts:452`, a digest row with no body the enqueue never writes; the five
TypeScript-narrowing fallbacks in `mergeTriggers`). `lib/clerkEmail.ts` had had no test file at all.
Branch coverage was deliberately *not* chased past that: the remaining partials are `??` and spread
fallbacks whose other side can't happen, and pinning them would mean writing rows the code can't
produce. The one reachable case — a skate the recorder couldn't place on a water body — was added.

**Founder tasks closed this PR:** Android small icon (needed an asset — arrived inverted the first
time, wordmark transparent and surround white, flipped in place; then re-cut heavier), preview
build `a09708e6`, the Clerk webhook endpoint + `CLERK_WEBHOOK_SIGNING_SECRET` on dev.

## Deferred

Everything A08 still owes, in the order it should happen. None of it is unwritten code; each is a
run, an install, a decision, or a scale trigger.

1. **The end-to-end smoke of `flush → deliverBatch` on dev.** No `notifications` row on dev has
   ever carried `pushedAt` or `emailedAt`, and no profile has an `emailUnsubscribeSecret` (minted
   on the first mail) — the 2026-09-14 Android push proved the credentials with a direct call, not
   the pipeline. One deliberate trigger from a second account: a thumb on a founder report (the
   push-only path) and a bounty on a water body the founder has reported (the email path, and the first
   real `/unsubscribe` link). Then check the stamps, the secret, and the inbox at `updates@…`.
2. **Install preview build `a09708e6`** on the Pixel — it carries the small icon, `syncFromClerk`
   and the post-Greptile JS. The first push after install is what shows the icon.
3. **Change-email, exercised once for real** (founder chose to wait): change the address from web
   Settings, watch the endpoint's *Messages* tab in Clerk show a 200, confirm `profiles.email`
   moved and `clerkUpdatedAt` was stamped. Until then the webhook is verified only by signed
   fixtures.
4. **iOS** is untested end to end for want of an iPhone; the code path is the Android one and the
   APNs key is on EAS. The first iOS build needs `eas device:create` + a distribution cert.
5. **Prod cutover items that are A08's:** a webhook endpoint in the *prod* Clerk instance pointing
   at `diligent-guanaco-965.convex.site` and its own `CLERK_WEBHOOK_SIGNING_SECRET`;
   `EXPO_ACCESS_TOKEN`, `RESEND_API_KEY` / `RESEND_FROM_EMAIL` and `WEB_APP_URL` on prod Convex;
   the `production` EAS environment populated. Per-instance, nothing carries over from dev
   (`docs/deployment-and-release.md`, cutover list 6–07-2).
6. **A `user.deleted` policy for a live account.** The webhook acknowledges and logs it; our own
   finalization deletes the Clerk user *after* the tombstone, so the ordinary arrival is a no-op.
   A founder deleting a live user from the Clerk dashboard leaves a profile the D62 lifecycle never
   started on. Founder call whether that should begin the deletion request automatically.
7. **The reverse reach index** (Workstream 4 / D172) — build at ~1,000 profiles, or the first
   report whose fan-out spans more than a handful of pages. Design is complete above.
8. **Web push** — service worker, VAPID keys, a second token type. Web = inbox + email until then.
9. **Silent background-refresh push to a closed app** (D54) — a privacy decision (the biggest
   departure from D12) plus accepting iOS's throttling; not a notification-pipeline change.
10. **Grouping across types in the inbox** — a UI question that wants a season of real rows.

## What this phase does not cover

*Revised at kickoff (founder, 2026-09-11): push and email moved **into** scope as PR 3. The original
exclusions are struck rather than deleted, so the reasoning survives.*

- ~~**Push delivery.** Still blocked on APNs/FCM credentials, token registration and a server sender.~~
  **→ PR 3.** Android via Expo Push + FCM (a Firebase project + service-account key in EAS — founder
  task); iOS via an APNs key from the Apple Developer Program the founder has since enrolled in, code
  shipped for both, only Android testable (no iPhone). The `coalesceKey` seeds the collapse-id as
  planned. D167's point stands: the inbox was never a waiting room for this.
- **Nearby-hazard notifications** (D171) — on-ice proximity is the hazard channel, deliberately.
- ~~**Email notifications.** Resend exists for *operator* alerts (D38) and is credential-blocked anyway.~~
  **→ PR 3.** Resend is live on dev (`updates@skating.teaganatwater.com`). Not a 10×3 matrix: per-type
  toggles stay, two channel switches (push, email) are added, and which types are *email-eligible* is
  fixed in code (the digest, `activity_detected`, `bounty_request`, `bounty_answered`,
  `content_flag_resolved` — never per-thumb mail). The primary email is mirrored from Clerk onto
  `profiles` (private, scrubbed on deletion, like `profileImageUrl`) so a send is not a Clerk call per
  recipient, and so a one-click unsubscribe route can exist.
- **Web push.** Deferred — no service worker, VAPID keys, or a second token type yet. Web = inbox +
  email.
- **Offline.** Mobile only, and for the inbox only *reading*: the last page and the unread count are
  cached in SQLite (the `reportCache` pattern), mark-as-read applies locally and replays. The hazard
  channel is already offline by construction (Phase 09b), which is the offline case that matters.
- **Notification grouping across types.** One digest already groups bodies within itself
  (`flushNotificationQueue`); grouping *across* types is a UI question that needs a real inbox to answer.

---

## Sequencing

1. **§1.1 + §1.2 + §1.3 — the inbox.** The deliverable. Nothing else in this phase is visible without it.
2. **§5.1 + §5.2 — route the existing producers through the queue.** Before the new producers, not after:
   §2.1–§2.4 should be written against the settled shape rather than converted to it a week later.
3. **§2.1 (`report_commented`)** — the highest-volume missing producer and the one that makes the inbox
   feel alive.
4. **§2.2 / §2.3 (`hazard_confirmation`, `content_flag_resolved`)** — §2.3 needs the `origin` field first;
   §2.2 carries the queue-kind rename.
5. **§2.4 + §2.4a (`activity_detected`)** — the `promptState` index and one sweep. **B4a's dedup ladder is
   design-only until a second provider exists** — write the rule and its tests, and note in the sweep
   that it currently has one source to choose between.
6. **§1.5 — the July purge.** One cron in the `storageHygiene` family. Deliberately *after* the producers,
   so it's written against the full set of types rather than half of them.
7. **C — per-user digest zone.** Needs a `timezone` field and a client that writes it; the server half
   is a one-line change.
8. **D — the reverse reach index.** Last, and only past its trigger (D4). It changes no behavior when
   it works, which is precisely why it goes after everything that does.

Steps 1–3 are a shippable phase on their own. If A08 has to be cut short, cut from the bottom.

---

## Settled at scoping (founder, 2026-07-30)

The five questions this document opened with, and their answers — recorded here rather than deleted,
because the *reasoning* is what a later reader needs:

1. **Where the inbox lives on mobile** → **You tab → bell at the top of the profile page → the list**,
   with an unread **dot on the avatar** in the tab bar. No sixth tab; D28's five stand (§1.3).
2. **`hazard_confirmation` cadence** → **lifecycle transitions, never per vote** (§2.2).
3. **Retention** → **purge every July**, on A05a's season boundary. Not a TTL — the same clock D66
   already uses for condition photos (§1.5).
4. **Sunset-timed digests** → **no**. 8pm local stays; only the *zone* becomes per-user (§3.2).
5. **Notifications whose target was hidden or removed** → **shown, degraded, untappable**. A row that
   silently vanishes reads as a bug (§1.2).

## Settled in the second pass (founder, 2026-07-30)

6. **Auto-filed flags never notify** (§2.3). Not because there's no human — there always is, the field is
   required — but because it's the **wrong** human: the rater whose thumb crossed a threshold, not
   someone who filed a report. Needs a new `origin: 'user' | 'auto'` on `contentFlags`, defaulting to
   silence when absent.
7. **The `hazard_confirmation` collision resolves by renaming the outbox** (§2.2): the offline queue's
   `kind` becomes `confirmation_vote`. Local to mobile, no stored rows, no wire format — a
   find-and-replace, against a migration on the notification type.
8. **One skate from several sources dedups before it prompts** (§2.4a). Overlap-based matching plus a
   four-rung precedence ladder that sorts on fidelity **and** displayability — D24's Strava
   cross-user restriction is why the second axis exists. Loser rows are superseded, never deleted.
9. **Notifications settle before they send** (D81 / Workstream 5). 60-second window, and the trigger is
   **re-read at flush** rather than cancelled at undo — one place to get right instead of every undo
   path in the app.

## Open questions remaining

None blocking. Two constants want one round of real data before they're trusted, both flagged in place:
B4a's overlap/start-time thresholds (needs an actual dual-source user) and D4's reverse-index trigger
(needs a profile count we don't have yet). Neither gates the build.


---

## Relocated from the roadmap (2026-09-16)

*The roadmap entry for A08 as it stood before the 2026-09-16 rewrite, kept verbatim so nothing it said is lost. The roadmap now carries a one-paragraph summary; this is the long form.*

**A08 — The notification pipeline.** ✅ **COMPLETE 2026-09-15** (PRs #52/#53/#55 + PR 4 on
`phase-n8-notification-pipeline-4`, [`phases/A08-notification-pipeline.md`](./A08-notification-pipeline.md),
D167–D174). Push credentials in on both platforms, the Android small icon shipped, the Clerk
webhook registered on dev; what's still owed — the end-to-end smoke, an install, a change-email
run, the prod-cutover items, the scale-triggered reverse index — is the plan's **Deferred** list,
none of it unwritten code. The scoping pass
found the real problem was neither bullet below: **nothing in the app could read a notification** —
six types were being written and had never been seen. So the phase is the inbox first, then every
declared type gets a producer, then the transports, and the two original bullets move to the back.
- **PR 1 ✅ built:** `notifications.list / unreadCount / markRead` + a typed resolver; web
  `/notifications` + bell, mobile You-tab bell + tab dot; every actor-triggered type now **settles
  60 s in the queue and is re-checked at flush** (D169 — a retracted thumb never sends); producers for
  `report_commented`, `hazard_confirmation` (phase transitions only), `content_flag_resolved`
  (user-origin flags only, new `contentFlags.origin`), and `bounty_answered` to the requester (D170,
  replacing the misdirected `bounty_fulfilled`). Both settings pages render all ten toggles.
- **PR 2 ✅ built:** `activity_detected` from the recorder's un-prompted skates (hourly sweep, 3 h
  delay) + the §2.4a dedup ladder (`supersededByActivityId`, the link moves to the winner; one provider
  today, so exercised only in tests); the **season-boundary inbox purge** (daily); **per-user digest
  zone** (`profiles.timezone` from the device; the hour stays 20:00 — true-sunset dropped, D173).
- **PR 3 ✅ built (D174):** the transports — Expo Push (server posts to `exp.host`; dead tokens
  disabled from tickets/receipts; **credentials are the founder's step**: FCM key + `google-services.json`
  for Android now, APNs key via `eas credentials` for iOS), **email via Resend** for the digest-class
  types with two channel switches and a one-click unsubscribe route (primary email mirrored from
  Clerk onto `profiles`), and the mobile offline inbox cache with a replayed read overlay.
- **PR 4 ✅ built (2026-09-15):** the coverage audit's findings — `profiles.syncFromClerk` (the
  email/avatar mirrors had never refreshed after onboarding; docs said "every cold start" and were
  wrong), **change-email on both clients** (`core/changeEmail.ts`) + the **Clerk `user.updated`
  webhook** (`standardwebhooks`, writers ordered by `clerkUpdatedAt`), the Android **small icon**,
  and the pipeline to 100% lines (`lib/clerkEmail.ts` had no tests at all).
- **Deferred, by design:** the **reverse reach index** (D172 — filters candidates, never replaces the
  polygon test; trigger ~1,000 profiles); **true-sunset digest timing** (dropped — sunset runs opposite
  to the season); **web push** (no service worker yet; web = inbox + email). The full owed list is
  the plan's Deferred section.
