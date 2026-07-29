# N5a — Seasons: seasonal visibility, the season filter, and departed-user redaction

*The map should show **this** season's ice. Everything else is history you go and look at on purpose,
not something that quietly shares the screen with a report from Tuesday.*

> **Status:** ✅ **built 2026-07-28**, **deployed to dev the same day** (all nine work items; the
> departure half shipped a day earlier as PR #30). Every suite green — core 934 / convex 779 / web 206 /
> mobile 79 — lint clean; **not device-tested, not on prod**. Splits from the roadmap's old N5, keeping
> its two **lifecycle** items; the three **authoring-UX** items become
> [N5b](./phase-N5b-hazard-authoring.md).

## What checking the code changed about the plan

The founder ask was: *"Reports from previous seasons should not remain visible on the map, nor should
skating paths."* Two of the premises underneath that — mine and the ask's — turned out wrong, and both
corrections make this phase **more** consequential rather than less.

### Correction 1: reports don't draw on the map at all

The map's sources are `water`, `sub-areas`, `photo-pins`, `put-in-pin`, `put-in-markers`,
`bounty-pins`, `hazards`, `tracks`, `body-features`, `hazard-draft`. There is no report layer. Reports
live in the **feed** and the **lake drawer's list**; what reaches the map *from* a report is its
**put-in marker**, its **track**, and its **photo pins** while it's open.

So "previous seasons on the map" decomposes into three different things with three different answers:

| On the map | Today | Under this phase |
|---|---|---|
| **Tracks** (`listTracksForBody`) | every published path ever, opacity = linked report freshness, **no age bound** | season-scoped ✔ |
| **Hazards** | see correction 2 — worse than expected | season-scoped ✔ |
| **Put-in markers** (`putIns.listForBody`, derived from reports) | every put-in ever | **deliberately exempt** — founder call, and S1 says access is the corpus's single most-discussed concern |
| Bounty pins | expire on their own cron | unchanged |
| Photo pins | only while a report is open | unchanged (follows the report) |

The put-in exemption needs saying out loud because it's a trap in the implementation:
`putIns.listForBody` derives its markers by reading **reports**. Season-scope the report read
carelessly and put-ins silently narrow with it — losing exactly the thing the founder asked to keep.

Reports themselves are still season-scoped, in the feed and the lake list. That's most of the felt
change; it just isn't a map change.

### Correction 2: hazards never age out — they accumulate forever

I assumed archived hazards were the stale ones and that a seasonal reset would be near-cosmetic. The
opposite is true.

`deriveHazardLifecycle` archives on **community "fully healed" votes only**. There is **no time-based
archival anywhere.** A hazard nobody ever revisits stays `status: 'active'` permanently. What time does
is move `deriveHazardFreshness` through `fresh → aging → stale`, and:

- in the **list**, `stale` goes behind a "show older" toggle;
- on the **map**, `hazardLayer` gives it a deliberate opacity **floor** — *"a stale hazard fades but
  never disappears and never goes below a floor you can still see"* — because D3 says decay is
  confidence, not safety.

That floor is right for a hazard from three weeks ago and wrong for one from two winters ago. Today a
pressure ridge reported in February 2025 is still on the map in July 2026, faintly, asserting a
position with no evidence behind it and nobody having said anything either way.

**So the hazard half is the most consequential part of this phase, not the tidy part** — and it also
means the recurring-hazard case is currently "handled" **by accident**: the stale pin never leaves, so
it happens to be there next winter, making an unevidenced claim. A seasonal reset plus a deliberate
promotion is strictly more honest than that, not a loss of safety information.

## Decisions taken at kickoff (2026-07-27)

**1. A season is July 1 → June 30, labelled `'24/'25`** (D63). July is the deadest point of the year in
the Northeast, so the boundary never cuts a live season and the reset lands when nobody is looking.

**2. Season is DERIVED, never stored.** `seasonOf(skateEndTime)`; the current season is `seasonOf(now)`.
No column, no backfill, no cron to advance anything, nothing to drift — the reset isn't an event, it's
the derived value changing and the queries following.

The mechanical payoff is large: `skateEndTime` is already the range field of
`by_water_body_moderation_and_skate_end_time`, `by_moderation_and_skate_end_time` and
`by_author_skate_end_time`, so adding a lower bound makes those reads **cheaper**. Seasonal visibility
costs nothing.

**3. Hazards reset on the same boundary; recurrence is D53's `bodyFeatures` promotion.** A hazard that
forms in the same place every winter becomes a persistent body feature, which no reset touches. So
"make it trivial to re-enable a recurring hazard" is **not new machinery** — it's an operator pass, and
this phase's job is to make that pass easy rather than to invent a parallel resurrect button.

> **The safety edge, written down because it's the thing to get wrong.** Hiding hazards at a boundary
> means the first skater in November sees a clean map where last winter there was a ridge. Promotion is
> what covers that, which makes the pre-first-ice pass a **safety task, not housekeeping** — so the
> admin surface has to say so, and this phase ships the list that makes it possible: last season's
> hazards ranked by likelihood of recurrence (confirm count, decay tier, type), promote one click away.

**4. The season filter lives on the water body, not globally.** A jump control in the lake detail
drawer/page: *This season · '25/'26 · '24/'25 …*. Past-season browsing is a curiosity ("what was this
bay like in December?"), not a safety surface, so it belongs where you're already asking about one lake
and nowhere near the map's default state.

**5. A departed user's content is redacted, not erased** (D62 **second** amendment, founder call the
same day — this decision was taken as "erased at 30 days" and reversed before the rest of the phase was
built). For an author whose profile is a D62 tombstone:

| | |
|---|---|
| **Redacted at 30 days past the skate** | `reports.notes` and the `note` on each thickness reading, `hazards.description`, photo captions, comment bodies (`createdAt` is a comment's clock) |
| **Erased at finalization** | private side-tables, unpublished recordings, unattached photos |
| **Erased immediately at the request** | **all** bounties, including open ones — a request from someone who left can't be fulfilled *for* them. At the *request*, not at finalize: a ghost stops asking the moment they leave, so an open bounty must not sit on the map for another 30 days collecting answers for nobody. |
| **Kept, anonymized** | the observation itself — reports, hazards, ratings, confirmations, flags, put-ins, point events, bodies; and published tracks, severed from identity |

The seam is **what a person typed versus what they observed**. See the D62 second amendment for the
full argument; the two consequences that matter to *this* phase are that hazard history survives a
departure (so recurrence detection has something to work with) and that put-ins survive by the ordinary
derivation instead of by a special case.

**6. Flat 30 days, not the D59 freshness curve.** The curve is more principled — a corroborated report
earns a longer life — but the consequence is *irreversible*, and a rule you can verify by reading one
field beats one that depends on other people's later votes. N3/N4 shipped a bug caused by a
subtly-wrong predicate on exactly this shape of sweep. (Hazards are the one place the clock reads a
community-maintained field, `lastConfirmedAt` — but there the consequence is redaction of a
description, not deletion of the pin, so a wrong predicate costs a sentence rather than a warning.)

**7. Suggested crossings decay in the opposite direction from hazards** (D64, founder call
2026-07-27). Moved here from N5b by this phase's own rule — anything that touches
`deriveHazardLifecycle` belongs with the lifecycle work.

`ridge_crossing` is a **passage marker, not a danger** (D51), and it currently inherits the hazard
lifecycle wholesale: Tier A\* decay (`freshH: 12`, `agingH: 36`), but archival only on two
`fully_healed` votes, and a map opacity **floor** so that stale never means gone. For a hazard that
floor is conservative — it over-warns. For a crossing it is **anti-conservative**: a marker placed in
November still says "reported crossable" in March, and nobody has looked since. Same rule, opposite
safety meaning, applied to the one type it doesn't fit.

So passage markers get their own lifecycle, inverted at every point:

| | Hazard | Suggested crossing |
|---|---|---|
| Absence of evidence | **keeps it alive** — assume the danger is still there | **kills it** — assume the crossing is gone |
| Positive votes | optional; refresh the clock | **required to survive**, and more of them |
| One negative vote | counts quietly toward a 2-vote archive | **shows as disputed**; two still needed to close |
| Past its window | fades to a visible floor, never disappears | **expires — stops rendering** |

The asymmetry falls straight out of D3 rather than being invented for it. Getting a crossing wrong in
the *remove* direction costs a skater a longer walk; getting it wrong in the *keep* direction walks
them onto ice nobody has checked. One of those is recoverable.

Consequences for the build:
- **Several crossings per ridge** — already expressible (each is its own `ridge_crossing` row); what's
  missing is authoring and rendering them as a set belonging to one ridge.
- **A third lifecycle state: `disputed`.** One "closed" vote is invisible today — `goneCount` hits 1,
  `status` stays `active`, and `healingState` only tracks `healing_unsafe` — so a skater saying "you
  can't cross here" changes nothing. `HAZARD_HEALING_STATES` gains `disputed`, derived from
  `goneCount >= 1 && goneCount < removalThreshold`, rendered with *"the safety of this crossing has
  been disputed — be careful."* Two votes still close it. **Passage markers only**: on a hazard the
  same signal would invite skaters to discount a live warning, which is the unsafe direction.
- **Copy is "suggested crossing", never "safe crossing"**, and every surface repeats that judging the
  crossing in the moment is the skater's, not ours. The existing verdict relabelling
  (*still crossable / dicey now / ridge closed*) gets tightened in the same pass.
- The `isHazardVisibleByDefault` floor needs a passage-marker branch — this is the one place a pin is
  allowed to leave the map on time alone, and it needs to be obvious in the code why.

**8. This narrows D33 as well as D62 — but far less than it first appeared.** D33's rationale was that
community value lives in report history, so content is anonymized rather than erased. This decision was
taken as "that no longer holds after 30 days", on the founder's reasoning that *holding a departed
person's data past its usefulness is the least respectful option available* — and then reversed the
same day once the consequences were followed through. D33's posture stands for the **observation**; what
this phase narrows is the **prose**, which is erased at 30 days and never comes back. See the D62 second
amendment.

**9. A deletion request makes you a ghost immediately** (founder call, 2026-07-27; **built in this
pass, ahead of the rest of the phase**, because it changes shipped behavior). Two corrections in one
conversation, and the second reversed the first's premise.

*The first:* N3/N4 shipped the 30-day window as "fully functional — sign in, post, and cancel".
Reading decision 5 back exposed the flaw: if someone can post until the final hour, their newest and
most relevant report is erased a month later while it's still the freshest thing on the lake.

*The second, and the bigger one:* the window shouldn't preserve the **person** either. Someone who
asks to be deleted should stop existing on the platform then and there. So the request now really
deletes — profile scrubbed, profile page and search not-found to everyone else, surviving content under
"Deleted skater", and every word they wrote more than 30 days ago gone for good — and only the **login**
waits, so the decision can be reversed, alongside the **observations**, which are kept for the community
rather than for the person.

> *A third correction followed* (D62 second amendment, same day): what the 30-day clock removes is the
> **free text**, not the content. Everything above about the person is unchanged.

| | |
|---|---|
| **Blocked** (`requireContributor`) | reports, comments, hazards, hazard confirmations, thumbs, bounties, photo uploads, native track ingest, new provider connections, skater-created water bodies |
| **Open** | flagging, blocking, support, export, `excludeTracksFromAggregate` (its own mutation — it governs the tracks that outlive the account), and cancelling |
| **Blocked, added by the second amendment** | *every* profile field — `updateProfile`, `setHome`, `setFeedFilterPrefs`, `setNotificationPrefs`. The request clears those exact fields; a ghost could type them back in, which made the wipe read as a suggestion |

**Cancelling keeps the account, not the person**: the profile stays empty and they go back through
onboarding, and the redacted words are gone. The handle is *reserved* through the window so nobody can
take it. `dateOfBirth` is the one PII field held to finalization — scrubbing it derives to *adult*, so
a minor who cancelled would come back with an adult's posting rights.

**The clients empty out to match** — the affordance goes, not just the permission, so nobody writes a
report and *then* learns it won't be accepted. Both apps drop every closed control and put one labelled
line in its place; the owner's own profile shows the cleared row with an explanation. That page is
unreachable to everyone else, which is the point: to the rest of the platform, a ghost does not exist.

Three notes that matter to the rest of this phase:

- **It's a separate helper, not `requireProfile`** — that one gates *queries* too, and reading is most
  of what "you can still change your mind" means.
- **It's why the redaction is a finalize stage rather than a deferred sweep** — see *Departed-user
  redaction* below. This is the decision that pays for itself.
- **The accepted cost:** a skater on bad ice during their window can't file the hazard. Cancelling is
  one tap and the error says so, but it's a real trade, not a free win.

## Settled at build kickoff (2026-07-28)

Eight questions the design left open, all of them answerable only by someone who knows what the app is
for. Recorded here in the order they were asked, with the reasoning that decided each.

**1. A hazard's season is its `firstReportedAt`.** The alternative — `lastConfirmedAt`, the clock the
app judges a hazard by everywhere else — would have made the boundary **soft**: one skater confirming a
March ridge in November carries it into the new season with no operator in the loop, which quietly
re-answers the question the promotion pass exists to ask. Hard boundary instead: last season's hazards
are reachable only through the season selector and the admin promotion list.

> ⚠ **This is the opposite field from the one `lib/contentPurge` ages hazards on**, and both are
> correct. Redaction asks *"is the community still maintaining this?"* — a clock other people move.
> Seasons ask *"when was this first seen?"* — a clock nobody can move. Two questions, two fields; the
> code has to say so at both sites or someone will "fix" one to match the other.

**2. The season selector governs the whole lake view** — list, hazards *and* tracks, map included. A
re-listed sidebar over a current-season map would put two seasons on screen at once, which is precisely
the confusion this phase exists to end.

**3. The global feed falls back to last season, labelled.** Season-scoping the feed empties it on
July 1 and it *stays* empty until first ice — five months of a dead home screen, which the design
hadn't followed through. When the current season has nothing, the feed shows the previous season under
a divider that says so. Labelled is what keeps it honest; silently mixing is what D63 forbids.

**4. A profile's report list is never season-scoped.** A person's contribution history is not a claim
about the state of the ice. It's also the index `lib/contentPurge` sweeps — see the build note.

**5. The two D64 constants.** Expiry gets its **own 72-hour window** rather than reusing `agingH: 36`,
so "faded" and "gone" aren't the same instant and a weekday-quiet lake doesn't lose its Sunday
crossing by Monday night. **Two** independent confirmations to stop being provisional, against every
hazard's one — that's what "more corroboration" is, literally double.

**6. `never_existed` pools with `fully_healed` toward the same 2-vote archive, and files a moderation
flag** (D65). The two verdicts disagree about history and agree about the present, and the map shows
the present — requiring two of a kind would leave a genuinely-clear hazard up because its witnesses
explained it differently. The flag is the half `fully_healed` doesn't get: "there was never anything
here" is a claim about the *report*, and two of them is a pattern a moderator should see rather than
an archive that happens quietly.

**7. Confirmers are named, subject to `profileVisibility`** (D65). Public profiles are named, private
ones counted. A confirmation is sharper than a report — it says a named person stood at a *point* at a
*time* — so it reuses the consent signal the user already gave rather than inventing a new one. Minors
are forced private (D41), so they're never named by construction.

**8. The departed-skater photo split is in this phase** (D66), promoted out of the deferred register.
Hazard photos kept, everything else expiring at the end of its season. The argument that moved it: the
clock it needs *is* this phase's boundary, so deferring it means inventing a per-photo TTL later and
then reconciling the two.

## The design

### Seasonal scoping

`@skating/core` gains the vocabulary — `SEASON_START_MONTH`, `seasonOf(ms)`, `seasonStartMs(season)`,
`formatSeason(season)` → `'24/'25` — and every seasonal read takes a lower bound derived from it.

**Scoped:** the lake report list, the global feed, aggregate tracks (via the linked report's
`skateEndTime`), per-body hazards, and the offline cache (already windowed; the season bound only
tightens it).

**Deliberately not scoped, each for its own reason:**
- **Put-ins** — founder call; see correction 1 for the implementation trap.
- **Analytics rollups** — their entire job is the historical record.
- **The bounty gate and `recommended`** — already ≤6d and 48h windows, strictly inside any season.
- **Moderation queues** — a flag on an old report is still a flag.
- **`bodyFeatures`** — persistent by definition (D53); that's the whole point of promotion.

### Two axes of hiding, kept separate

After this phase a hazard can be hidden for two unrelated reasons: it's **stale** (nobody has checked
recently, within this season) or it's **from another season**. These mean different things and should
not collapse into one control — "show older" answers *"has anyone verified this lately?"*, the season
selector answers *"what did this lake look like last winter?"*. Conflating them would make the first
one silently mean the second in July.

### Departed-user redaction

**The governing principle, stated because two rules in this phase look similar and aren't** (founder,
2026-07-27, as revised by the D62 second amendment):

> **Aging never removes anything. An intentional account deletion erases what is private, redacts what
> is personal, and keeps the observation either way.**

Staleness and seasons only ever **hide** — for everyone, reversibly, with a labelled way back. Erasure
has exactly one trigger, and it's a person deciding to leave; even then it reaches their private
artifacts and their prose, never the ice record. The 30-day clock isn't "old content expires"; it's how
long a departing skater's own words stay up, and it doesn't apply to anybody who's still here.

**✅ Built** (`lib/contentPurge`), and the read-only rule is what made it simple. The first design
stamped a `contentPurgeDueAt` at finalize and swept it later off a range bounded on both sides —
carefully, because the N3/N4 postmortem is exactly that shape: an index on an optional field is not
sparse, `undefined` sorts before every number, and a bare upper bound matches every row that never set
it.

None of that was needed. With posting closed at the request, a ghost's newest `skateEndTime` can't
postdate their request, so every row they hold is due by the finalize date. The redaction runs **at the
request**, on **every sweep tick while pending** (content ages during the window — three days old at
the request is thirty-three three weeks later), and as a **stage of the finalize chain**, where it
necessarily catches the rest. No stamp, no index, no second cron.

**What the second amendment deleted from this design, and why that's the good news.** The hardest part
of the first version was the report cascade — seven tables point at one report, and each needed its own
answer. None of it exists now, because nothing is deleted:

| Referrer | Then | Now |
|---|---|---|
| `comments.reportId` | deleted with the report, `commentCount` decremented | untouched — the report survives |
| `gpsActivities.linkedReportId` | activity and path deleted | kept, severed at finalize (D62 bucket 3, which this is what *makes reachable*) |
| `bounties.fulfillingReportIds` | id pulled from someone else's array | untouched |
| `contentFlags` targeting it | deleted | untouched — a flag on a surviving report is still a flag |
| `hazards.originReportId` | deleted | untouched |
| `putIns.originReportId` | survived only because the purge materialized a row first | untouched; the marker derives from the live report like anyone else's |
| `pointEvents.refId` | left alone deliberately | left alone, now trivially |

> **The decision the first build found to be false, and the second build made true for free.**
> *"Put-ins survive"* was not true in the code: derived markers aren't stored, `putIns.listForBody`
> recomputes them from live reports on every read, so erasing a departed skater's reports erased the
> access points they revealed. The fix was to materialize the marker before deleting its report. With
> reports kept, the report *is* the preservation and that machinery is gone. The stored-row reader in
> `putIns` stays — rows written by the old path exist on dev — and markers now carry `lastUsedAt`, so
> an access point from three winters ago can say so rather than rendering like last week's.

**Three bugs the erasure design was carrying, fixed in the same pass** — each worth remembering because
each was invisible in review and green in the suite:

1. **Bucket 3 was dead code.** `severTracks`' keep-branch could never fire in production: the purge
   deleted every report first and each deletion took its linked activity with it. Every test reached
   finalization through `finalizeNow`, which stamps and finalizes in the same instant, so content never
   aged and the branch always looked alive. There is now a test that advances the clock 30 days and
   goes in through `finalizeDueDeletions`.
2. **Hazards past the first page were never swept at all.** The sweep `.take()`-ed 100 rows off
   `by_author_and_water_body` — ordered by *water body*, not time — filtered by age in memory, and
   never reported "more". Redaction keeps the row it touches, so the query doesn't shrink and the same
   page comes back forever. Everything is cursor-paginated now, one category per call (Convex allows
   one `.paginate()` per function execution).
3. **The pending-ghost sweep starved itself.** It read the whole pending range and dropped the *due*
   rows with a post-filter — but the range is ordered by request time, so due accounts are always
   oldest, always at the front, and always filling the page. On a tick with a full page of due
   accounts, not one pending ghost was thinned. Bounded in-index now.

**Three more in the end-to-end walkthrough that followed (2026-07-27), sharing one cause.** The finalize
`redact` stage reused the ghost window's age cutoff — in the one place where **no later pass exists**.
`writeTombstone` clears `deletionRequestedAt`, the row leaves `by_deletion_requested_at`, and nothing
can reach it again, so whatever the cutoff spared on that pass was kept permanently:

1. **Hazard descriptions the community kept confirming.** `lastConfirmedAt` is the one clock *other
   people* move, so a hazard being actively maintained arrived at finalization "fresh" and kept its
   text forever. That's the common case, not a corner — decision 5 above specifically celebrates it.
2. **Every `finalizeNow`.** It stamps and finalizes in the same instant, so the cutoff sat 30 days in
   the past and *nothing* was due. The operator's compliance lever redacted the least of any path, and
   no test noticed because every finalization test went in through it — the same blind spot that hid
   dead bucket 3.
3. **An hour of skate-time overhang.** `SKATE_TIME_FUTURE_TOLERANCE_MS` allows a future skate time, so
   "a ghost's newest `skateEndTime` can't postdate their request" was true ±1h and the overhang never
   came due.

Fixed by a `final` mode in `lib/contentPurge` that the finalize stage alone sets. **The design
consequence worth carrying:** decision 6's "flat 30 days, not the D59 curve" was the right instinct and
didn't go far enough — the problem isn't only that a community-driven predicate is hard to verify, it's
that an *irreversible terminal pass* shouldn't consult a clock at all. Any future "keep it while it's
still useful" rule needs its terminal case written down at the same time as the rule.

Two free-text fields the seam had missed came out of the same pass: `contentFlags.note` (prose the
person typed, on a row that survives because it's about *content* — and the field most likely in the
schema to name a second user), and `profiles.statusReason` (a moderator's written reason for a past
suspension, the one PII field on a profile the operator wrote rather than the user, which is why every
scrub walked past it). `moderationActions.reason` is deliberately untouched — that's the audit trail.

One stale promise, too: the export email still said *"this link works for 7 days"* after the TTL moved
to 30, in a file whose own comment says the number is single-sourced "because a promise that disagrees
with the sweep is worse than no promise". It now interpolates `DATA_EXPORT_TTL_DAYS`.

## What this unlocks: hazard memory (founder ask, 2026-07-27)

Worth recording because the connection isn't obvious, and because it changes what "hidden, not deleted"
is *for*.

**Seasonal scoping is what turns hazards into a per-season historical record.** Today a hazard is a
single mutable row with no season semantics — `lastConfirmedAt` moves, `status` flips, and the question
*"which hazards existed on this lake in '24/'25?"* has no answer you can query. Once season is a
derived, first-class dimension, it does. Repeat that across seasons and a new class of question opens:

> *This lake has had a pressure ridge within ~80 m of this point in 3 of the last 4 seasons, always
> between late December and February.*

That is the substrate for two things the founder wants:

1. **Automated promotion suggestions.** Instead of an operator eyeballing last season's hazards before
   first ice, the admin surface ranks them by observed recurrence across seasons and proposes
   `bodyFeatures` promotion for the ones that keep coming back. The pre-first-ice pass stops being a
   memory test.
2. **"Potential hazard" surfacing** — a body-level advisory ("ridges have formed here most winters")
   shown *before* anyone reports anything this season, which is precisely the window where the map is
   emptiest and a skater is least warned.

**Both are deferred, and the reason is data, not difficulty.** Recurrence needs several seasons of real
hazard rows to mean anything; with one season it's noise dressed as insight, which is the D3 trap.
Logged as a deferred-register entry with its trigger — *three seasons of in-app hazard data on at least
a handful of bodies* — alongside the sibling calibration items (decay-magnitude refit, GPS-path hazard
deduction) that wait on the same corpus.

**Two design notes to carry forward so the option stays open.** First: the departure sweep must not
silently destroy the record this depends on — which was a live risk under the first amendment, where a
departed user's hazards were deleted outright and recurrence would have been computed over a corpus
quietly missing rows. The second amendment removes it: hazards are kept and anonymized, only their
descriptions go. That is the main reason redact-don't-erase matters to *this* phase and not only to the
deletion flow. Second: any recurrence claim must be phrased as history, never as a prediction of
current conditions (D3), because "ridges usually form here" and "there is a ridge here" are different
sentences and only one of them is ours to say.

## Work breakdown

0. ✅ **The ghost (decision 9)** — `requireContributor` and its exemptions; the request-time profile
   wipe; the ghost read gates (`getPublicProfile`, `searchProfiles`, `publicAuthor`, and the launch
   sync that would otherwise re-mirror a name out of Clerk); `lib/contentPurge`; re-onboarding after a
   cancel; the emptied-out client surfaces and the rewritten copy. Done ahead of the phase because it
   changes behavior already in `main`, and because every later item's retention story assumes it.
0b. ✅ **The second amendment** — redact-don't-erase across `lib/contentPurge`; hazards aged on
   `lastConfirmedAt`; comment shells + the client rendering; the three sweep bugs (dead bucket 3,
   unreachable hazard pages, starved pending sweep); every profile-field mutation behind
   `requireContributor` with the aggregate opt-out split out; the 30-day export TTL that survives
   finalization; `lastUsedAt` on put-in markers; the cron-path test that would have caught bucket 3.
1. Plans — this doc, D63, the D62 amendment + second amendment, the roadmap re-scope, the
   deferred-register entry for hazard memory.
2. `@skating/core` season vocabulary + tests (pure functions; property-tested across the boundary).
3. Seasonal scoping across the read paths — with put-ins explicitly exempt.
4. The season filter (server arg + both clients), and the two-axis UI.
5. The recurring-hazard promotion list on `/admin/water/$id`, framed as a safety task.
6. ✅ Departed-user redaction — shipped with items 0/0b (`lib/contentPurge`): free text cleared at 30
   days, private leftovers erased, the observation kept, running at request / while pending / at
   finalize.
7. ✅ The two folded-in lifecycle items — the `never_existed` verdict and named confirmers, designed at
   kickoff as **D65**.
8. ✅ The passage-marker lifecycle inversion (D64) + the "suggested crossing" copy pass.
9. ✅ The departed-skater photo split (**D66**), moved up from the deferred register at kickoff.

## What the build found (2026-07-28)

**Everything above is built and on dev** — core 934 / convex 779 / web 206 / mobile 79 green, lint
clean. Six things came out of the build that the design hadn't reached.

**1. Tracks needed an index, and the reason is the N1 bug class.** The design says the aggregate layer
is scoped "via the linked report's `skateEndTime`". `gpsActivities` has no time index at all —
`by_water_body` orders by creation — so that could only have been a filter over the newest 200 *rows*,
and on a lake with more than that in lifetime tracks last season's would fill the window while this
season's silently didn't draw. `by_water_body_start_time` bounds it in the index instead, on the
activity's own `startTime`: it differs from the linked report's `skateEndTime` by the length of one
skate, and the boundary is the one week of the year no skate spans.

**2. `usePaginatedQuery` drops everything but the page.** The feed's fallback returns `season` and
`isPastSeason` from the server, and no client can read them — the hook hands back flattened pages. The
label is derived from the cards instead, which works because the server bounds *one* season per read,
so the first card answers for all of them. The server fields stay: they're what the tests assert, and
they're the only way to know the served season when the page is empty.

**3. The season had to be shared state, not drawer state.** The selector lives in the lake drawer; two
of the three things it governs (hazard pins, aggregate tracks) are drawn by the map behind it. A local
`useState` would have moved the list to last December and left this winter's ice on screen — two
seasons on one screen, which is the confusion this phase exists to end. It goes through
`MapSelectionContext` on both clients, and resets on lake change *and* on unmount, because the map
outlives the drawer.

**4. The on-ice banner reads the same query and must never be told about browsing.** `HazardBanner`'s
call to `hazards.listForBody` is now textually identical to the map's minus one argument, which makes
it exactly the line a future reader will "fix". A skater standing on ice must not be alerted about last
winter's ridge because a sheet they opened an hour ago was reading '24/'25 — nor stop being alerted
about this winter's. It carries the loudest comment in the file for that reason.

**5. Two test files had to pin their clock, and one pre-existing test was already time-dependent.**
Once a report has a season, a fixture dated January is in *this* season for half the year and hidden
for the other half — a test that passes for seven months and then fails on a real behavior change,
reading as a flake. `reports.test.ts` and `gpsActivities.test.ts` pin `now` inside their fixtures'
season, the same convention `accountDeletion.test.ts` already documents. Separately, two
`analyticsRollup` tests seeded a report "an hour ago" and asserted against `metricDay(now)`: between
00:00 and 01:00 UTC those are different days, so they failed for one hour in twenty-four. Found by
running the suite at 00:49 UTC; fixed in its own commit, since it predates this phase.

**6. `never_existed` needed one more decision than D65 wrote down.** Whether it pools with
`fully_healed` toward the archive was settled at kickoff (it does), but the *flag* shouldn't fire on a
mixed pair — two people who disagree about whether a hazard ever existed are not the pattern a
moderator needs to see. So the archive pools and the flag counts `never_existed` alone.

## What the review pass found (2026-07-28, after the dev deploy)

Six defects, every one of them green in the suite and none of them visible in a diff read. Recorded
because five of the six share a shape worth naming: **a call site that was correct until the value it
handled changed meaning.**

**1. The names D65 added were rendered lowercase.** Both drawers wrote
`confirmerSummary(...).toLowerCase()`, which was exactly right while the string read *"confirmed by 3
other skaters"* and became wrong the instant it carried names: *"confirmed by alex r. and 3 others"*.
The lowercasing was there to fit the clause mid-sentence, so the fix is a `confirmerClause` that lowers
the leading word and nothing else — a shared function rather than a convention, because the convention
is what failed. The same file already reasons carefully about a name ending in a full stop; the call
site three lines away then lowercased it.

**2. `HazardView.expired` was read by nobody.** It was computed, and its docstring said it existed *"so
a permalink can say the marker aged out rather than 404"* — a promise no client kept. An expired
suggested crossing opened by link rendered as an ordinary live pin with the confirm buttons offered.
Both apps now show it, and the same pass added the **season label on a hazard permalink** that reports
already had: a past-season hazard is off the map entirely, so the link is the only way anyone reaches
it, and it should say which winter it is from. *A field with no reader is a design document, not a
feature* — and this one read as done.

**3. `sweepDepartedPhotos` never finished.** It fanned out to every `status: 'deleted'` profile daily
with nothing marking an account complete, so a 2026 tombstone had its whole photo table re-paginated
every day forever and the cost grew with every departure the app had ever had. A
`photosExpiredForSeason` marker makes it one pass per account per season. The index it reads,
`by_status_photos_expired`, is **the non-sparse-optional-field behaviour being useful for once** —
never-swept accounts have no value, `undefined` sorts before every number, so `lt(currentSeason)`
returns exactly the work queue with no backfill. That is worth saying beside the warning two lines up
in the same file, where the same behaviour nearly deleted every account on dev.

The season is resolved **once by the sweeper** and threaded through each account's continuations, so a
July 1 rollover can't land mid-account and mark a pass done for a boundary its earlier pages weren't
judged against. And a capped hazard scan deliberately *doesn't* mark the account, so the next tick
retries rather than accepting an unanswered question as finished.

**4. A hazard's author could be named among its own confirmers.** `confirmCount` excludes the author by
construction (D54 — vouching for your own report isn't independent evidence), but the clients named
every public `still_there` voter, so the drawer could print more names than the count above them, and
print the reporter as their own corroborator one line under *"reported by"* them. The vote is real and
a moderator should see it, so `listForHazard` flags it as `isAuthor` rather than dropping it.

**5. `listPromotionCandidates` collected a lake's entire hazard history.** `by_water_body` has no status
or time key, so this was an unbounded read — on the one table this phase's own design note points out
*never ages out*. Bounded to the newest 500, which is where last season's rows are, and it logs when the
cap bites so it can't be the silent kind.

**6. Two smaller ones.** `season` arrives as a bare `v.number()`, so `NaN` or `1e15` became index bounds
matching nothing and rendered an empty lake — which reads as *"nobody skated here that winter"* rather
than as a malformed request; `resolveSeason` lands those on the same default as no argument at all.
And `applyConfirmation`, the offline optimistic path, had no `isPassage` option, so it could never
reach `disputed`: a skater casting *"ridge closed here"* saw nothing change until the next sync, on the
one verdict a crossing most needs shown.

> **The pattern to carry.** Four of these six are a *widening* — a verdict added to an enum, a name
> added to a string, a field added to a view, an account state that now persists — landing on code that
> was right about the narrower version. None of them break a type. The lesson isn't "write more tests",
> it's that the diff to review after widening a value is **every existing reader of it**, not just the
> new ones.

## Settled after the design review (2026-07-27)

**Hidden reports still resolve by permalink**, labelled *"from the '24/'25 season"*. Hiding governs the
**default view**, not reachability: someone may hold a link, a bookmark or an old notification, and a
404 on a URL that used to work is a worse lie than an old report clearly marked old. It also keeps the
season filter's own rows clickable without a special case.

**The redaction is retroactive** — at finalize, the words come off *everything* past 30 days, not just
this season's. So someone deleting in July 2027 with content from '25/'26 has all of their prose
cleared in one sweep. The alternative would leave a departed person's older writing sitting there
forever, which is the retention this rule exists to prevent. What it does *not* touch, at any age, is
the observation.

> **The semantics are "all at finalize"; the implementation still pages.** A single mutation cannot
> walk a prolific contributor's whole history — that's a read/write budget wall, not a policy choice —
> so this is the same self-continuing staged job N3/N4 already uses, one paginated category per call
> (Convex allows one `.paginate()` per function execution). Worth stating so nobody "fixes" the paging
> back into one transaction to match the sentence.

**Both hiding controls stay.** "Show older" answers *"has anyone verified this lately?"*; the season
selector answers *"what did this lake look like last winter?"*. Collapsing them would make the first
silently mean the second come July, and the within-season distinction between a hazard confirmed
yesterday and one untouched since November is exactly what D3's decay model exists to draw.

## Deferred, with the reason (2026-07-27 review)

Everything here came out of walking the deletion flow end to end with the founder. Each is a real gap
with a decided answer; what's missing is build time or an external dependency, not a decision.

**1. Email-confirmed deletion with step-up re-auth.** Today one click, behind a live session, starts an
immediate and irreversible destruction — the profile scrub and the redaction can't be undone by
cancelling. The classic job of a 30-day window is protecting against a misclick or a stolen session,
and this design has moved the irreversible part *before* the window rather than inside it.

The founder's shape, which is better than a plain re-auth because it adds a factor and a tripwire:
`requestDeletion` sends an email instead of scrubbing; the link lands on a route that forces Clerk
reverification **even with a live session**; only then does the ghost state begin. Three factors
(session, password, mailbox) and — the part a re-auth alone can't do — a message arriving in the
victim's inbox saying *this is happening*, with a "this wasn't me" link that burns the token.

*Blocked on:* Resend provisioning (prod cutover). **Ship a fallback in the same pass:** if
`RESEND_API_KEY` is absent, fall back to reverification-only and log it — a mail outage must never
strand somebody's right to erasure. Single-use token, 48h TTL, invalidated by a password change.

**2. A GDPR path for banned and suspended users.** `requestDeletion` and `requestExport` both take
`requireProfile`, which rejects `banned` and `suspended`. Erasure and access rights don't depend on
good standing, and a banned user is among the likeliest people to file. Two halves, because the two
statuses fail differently:

- **Suspended** — an in-app path works. A `requireSelfService` helper resolving the profile and
  rejecting only `deleted`/`deleting`.
- **Banned** — permanent bans are Clerk-banned (D37), so they **cannot sign in at all** and no in-app
  button can reach them. This needs an operator surface: export and `finalizeNow` runnable on someone
  else's behalf from `/admin/users`, plus a documented contact address. Founder call, 2026-07-27.

Decide alongside it whether a banned user's deletion should destroy content that is moderation
evidence. `moderationActions` is a separate table and survives regardless; under redact-don't-erase the
flagged content survives too, so this is now much less sharp than it was.

**3. Notifications keep arriving for a ghost, and the mute switch just closed.** `setNotificationPrefs`
moved behind `requireContributor` with every other profile field, which is right — but a ghost's
reports are *kept* now, so people go on commenting on them and the rows go on landing. The fix is to
stop **generating** notifications for an account with `deletionRequestedAt` set rather than to reopen
the switch: a person who no longer exists on the platform shouldn't be receiving mail about it. Small,
and only in-app rows today (push delivery is still deferred), which is why it's here rather than above.

**4. Comment redaction is server-side and client-rendered; the moderator view isn't checked.** A
redacted comment renders as *"This comment was deleted"* in both apps. Not yet audited: what the
moderation queue shows for one, and whether `commentCount` should follow a redaction (it currently
doesn't — the comment still exists, which is arguably correct and worth confirming).

**5. ~~What to do about a departed skater's photo *images*.~~ → decided at kickoff as [D66](./01-decisions.md#d66--a-departed-skaters-photos-split-on-evidential-value-and-expire-at-the-season-boundary-n5a),
and built in this phase as work item 9.** The founder's shape below is what was taken, with one
implementation consequence the write-up hadn't reached: because finalization lands 30 days after the
request and therefore mid-season, the expiry sweep has to **outlive the tombstone** — it runs off
`profiles.by_status` (`deleted`) rather than the pending index, which `writeTombstone` drops the row out
of. The original framing is kept below, since the alternatives it weighs are the record of why.

Today a photo attached to a surviving report or hazard is kept whole — bytes, timestamp, coordinate —
and only the caption is redacted. The coordinate is ice record and earns its place. The **image** is
the largest identifiability surface in the system and nothing touches it: faces, a licence plate, a
house behind the put-in, the departed skater themselves. Every other bucket in D62 was argued from the
"what a person typed vs what they observed" seam, and a photograph sits awkwardly across it — it is
*observation*, which is why it was never questioned, but it is also the richest personal data we hold.

The founder's shape, and the reason it's promising: **split on evidential value, expire the rest at the
season boundary.** A photo documenting a hazard is kept — a picture of an open lead is worth more than
any sentence describing one, and it's exactly what the next skater on that shore needs. Everything else
(the beautiful-morning shots, and — a real cost — the put-in documentation, which S1 says is the
corpus's most-discussed concern) expires at the end of the season in which it was taken. The loss is
accepted because it falls only on the small number of people who chose to leave.

This phase is where it belongs if it lands, because the expiry clock it proposes is **this phase's
season boundary** rather than a fourth deletion timer — which is also the argument for doing it here
rather than inventing a per-photo TTL later.

Alternatives not yet weighed against it: keep hazard photos indefinitely and drop *all* others at
finalization (simpler, no seasonal machinery, loses more); keep everything but strip EXIF and
re-encode (addresses metadata, not the pixels, so it misses the actual concern); or offer the choice at
delete time (a consent record we'd then have to honor forever, and one more decision at the worst
possible moment to be asking for one).

**6. Season browsing will be quietly incomplete, and that's accepted.** Browsing `'24/'25` shows what
survived deletion, not what happened. Under redact-don't-erase this is now only about the *words*, so
the empty state needs no special caveat — noted so the next person doesn't rediscover it as a bug.

## Build notes for the seasonal work

- **The redaction query must not inherit a season lower bound.** Item 3 adds season bounds to reads off
  `by_author_skate_end_time`, which is the same index `lib/contentPurge` sweeps. If the bound leaks in,
  a departed user's pre-season content silently stops being redacted — a privacy regression that no
  test would catch, because everything visible would look right.
- **`putIns.listForBody` derives from reports and must stay season-unscoped** (correction 1). Now
  doubly load-bearing: it's also how a departed skater's access point survives.
- **The promotion pass and the departure clock don't line up.** Decision 3 makes recurring-hazard →
  `bodyFeatures` promotion the safety cover for the seasonal reset, run pre-first-ice. Hazards are no
  longer erased on departure, so the corpus that pass reads is intact — which is the main reason the
  second amendment matters to *this* phase rather than only to deletion.

## Open questions

- ~~**Whether the reset needs an announcement.**~~ **Answered at kickoff, and the answer was bigger
  than the question.** No announcement: the empty state carries it, on the lake ("no reports yet this
  season" plus the season selector) and in the feed — where the honest empty state turned out to be a
  **labelled fallback to last season**, because the feed doesn't go blank for a day in July, it goes
  blank until first ice. See kickoff decision 3.
- **What the map does with a body whose only hazards are last season's.** Probably nothing — but
  prominence scoring (D49) partly reflects activity, and a reset changes its inputs.
- **Whether `'24/'25` is the right label** for a region where ice spans one calendar year. Fine for the
  Northeast; revisit if the corpus moves south.
