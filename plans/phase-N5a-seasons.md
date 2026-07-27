# N5a — Seasons: seasonal visibility, the season filter, and departed-user erasure

*The map should show **this** season's ice. Everything else is history you go and look at on purpose,
not something that quietly shares the screen with a report from Tuesday.*

> **Status:** design settled 2026-07-27, not yet built. Splits from the roadmap's old N5, keeping its
> two **lifecycle** items; the three **authoring-UX** items become [N5b](./phase-N5b-hazard-authoring.md).

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

**5. A departed user's content is erased 30 days after its skate** (D62 amendment). For an author whose
profile is a D62 tombstone:

| | |
|---|---|
| **Erased at 30 days past `skateEndTime`** | the report (with its cascade), its GPS activity + path, hazards they created, their photos |
| **Erased immediately at finalize** | **all** bounties, including open ones — a request from someone who left can't be fulfilled *for* them |
| **Kept** | put-ins, and anything still inside the 30-day window |

**6. Flat 30 days, not the D59 freshness curve.** The curve is more principled — a corroborated report
earns a longer life — but the consequence is *irreversible deletion*, and a rule you can verify by
reading one field beats one that depends on other people's later votes. N3/N4 shipped a bug caused by a
subtly-wrong predicate on exactly this shape of sweep.

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

**8. This narrows D33 as well as D62, and that should be explicit.** D33's rationale was that community
value lives in report history, so content is anonymized rather than erased. For departed users that no
longer holds after 30 days. The founder's reasoning is the right one and belongs in the record: *at 30
days anything still true has fresh reporting behind it, and holding a departed person's data past its
usefulness is the least respectful option available.*

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

### Departed-user erasure

**The governing principle, stated because two rules in this phase look similar and aren't** (founder,
2026-07-27):

> **Aging never erases anything. An intentional account deletion erases everything that isn't of
> immediate value to the community.**

Staleness and seasons only ever **hide** — for everyone, reversibly, with a labelled way back. Erasure
has exactly one trigger, and it's a person deciding to leave. The 30-day window isn't "old content
expires"; it's the proxy for *immediate value*, which is why it's short and why it doesn't apply to
anybody who's still here.

A `contentPurgeDueAt` stamped at finalize (newest `skateEndTime` + 30 days), swept off a range
**bounded on both sides** — because the N3/N4 postmortem is exactly this shape: an index on an optional
field is not sparse, `undefined` sorts before every number, and a bare upper bound matches every row
that never set it.

Deleting a report is the expensive part, because seven tables point at one:

| Referrer | What happens |
|---|---|
| `comments.reportId` | deleted with the report — a reply to a thread that no longer exists is unreachable, and the thread UI is keyed by `reportId`. Each author's denormalized `commentCount` decrements via `bumpContributionCount`. |
| `gpsActivities.linkedReportId` | the activity and its path are deleted |
| `bounties.fulfillingReportIds` | the id is pulled from the array — someone *else's* bounty may cite it |
| `contentFlags` targeting it | deleted; nothing left to moderate |
| `hazards.originReportId` | those hazards are deleted too; cleared defensively |
| `putIns.originReportId` | **the put-in survives** with the pointer cleared |
| `pointEvents.refId` | **left alone** — an untyped string, and a `report_corroborated` row belongs to the *corroborated* author, whose count must not move because someone else left |

That last row is the one to argue with in review: deleting a departed user's `pointEvents` looks tidy
and would silently change other people's corroboration counts, which feed `reportFreshness` and the
recommended feed.

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

**Two design notes to carry forward so the option stays open:** the erasure sweep must not silently
destroy the record it depends on (a departed user's hazards do get deleted — that's decided, and it
means recurrence is computed over what remains, which is honest but worth knowing); and any
recurrence claim must be phrased as history, never as a prediction of current conditions (D3), because
"ridges usually form here" and "there is a ridge here" are different sentences and only one of them is
ours to say.

## Work breakdown

1. Plans — this doc, D63, the D62 amendment, the roadmap re-scope, the deferred-register entry for
   hazard memory.
2. `@skating/core` season vocabulary + tests (pure functions; property-tested across the boundary).
3. Seasonal scoping across the read paths — with put-ins explicitly exempt.
4. The season filter (server arg + both clients), and the two-axis UI.
5. The recurring-hazard promotion list on `/admin/water/$id`, framed as a safety task.
6. Departed-user erasure: the purge sweep + the report cascade.
7. The two folded-in lifecycle items — "this never existed" verdict, naming confirmers.
8. The passage-marker lifecycle inversion (D64) + the "suggested crossing" copy pass.

## Settled after the design review (2026-07-27)

**Hidden reports still resolve by permalink**, labelled *"from the '24/'25 season"*. Hiding governs the
**default view**, not reachability: someone may hold a link, a bookmark or an old notification, and a
404 on a URL that used to work is a worse lie than an old report clearly marked old. It also keeps the
season filter's own rows clickable without a special case.

**The purge is retroactive** — at finalize, *everything* past 30 days goes, not just this season's. So
someone deleting in July 2027 with content from '25/'26 has all of it erased in one sweep. That's the
most destructive case the design allows and it's intended: the alternative leaves a departed person's
older rows sitting invisibly forever, which is the exact retention the rule exists to prevent.

> **The semantics are "all at finalize"; the implementation still pages.** A single mutation cannot
> delete a prolific contributor's whole history — that's a read/write budget wall, not a policy choice —
> so the purge is the same self-continuing staged job N3/N4 already uses. Worth stating so nobody
> "fixes" the paging back into one transaction to match the sentence.

**Both hiding controls stay.** "Show older" answers *"has anyone verified this lately?"*; the season
selector answers *"what did this lake look like last winter?"*. Collapsing them would make the first
silently mean the second come July, and the within-season distinction between a hazard confirmed
yesterday and one untouched since November is exactly what D3's decay model exists to draw.

## Open questions

- **Whether the reset needs an announcement.** On July 1 a skater's favourite lake goes blank. That's
  correct and it will read as a bug unless the empty state says "no reports yet this season" and points
  at the season filter.
- **What the map does with a body whose only hazards are last season's.** Probably nothing — but
  prominence scoring (D49) partly reflects activity, and a reset changes its inputs.
- **Whether `'24/'25` is the right label** for a region where ice spans one calendar year. Fine for the
  Northeast; revisit if the corpus moves south.
