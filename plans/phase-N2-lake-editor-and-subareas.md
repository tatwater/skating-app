# N2 — The lake editor + named sub-areas

> **Status: building (kickoff 2026-07-26; build started 2026-07-26).** The second item in the roadmap's *Next-phase candidates*
> register ([`07-roadmap.md`](./07-roadmap.md) → *Later / deferred* → N2), picked second because the
> founder **is** the operator, and because the corpus models its most-skated destinations worst.

**Goal.** Give one sheet of ice the names skaters actually use for it, and give the operator one place
to say so. Two halves that only look separate: a **named sub-area** model (Malletts Bay is a region
*of* Lake Champlain, not a lake beside it) and a **per-lake editor** — look up a lake, get one canvas
locked to that lake carrying every per-body lever there is.

A skater sees their bay's name on the map, in search, on their reports, and on a bounty. The operator
stops doing curation through a CSV and an internal mutation.

---

## What the roadmap's N2 entry got wrong

The entry was written before Phase 8 shipped and had drifted. Corrections found while scoping
(2026-07-26), each verified against code:

1. **"Add the Champlain / Lake George bays OSM lacks" was unbuildable — and the shape it asked for was
   wrong anyway.** `waterBodies.create` is **path-only**: it takes a `gpsActivities` id, derives the
   polygon server-side from the trusted path, and refuses a client-supplied shape by doctrine
   (`waterBodies.ts` — *"There is no freehand drawing in this app and there is no argument by which a
   client can hand us a shape"*). So there was no operator path to add a bay at all.

   Then look at *what* the missing bays are. Every name the community seed failed to match is a region
   inside one existing polygon: **Malletts Bay · Northwest Bay · Dillenbeck Bay · Burlington Bay ·
   Shelburne Bay · Outer Bay · Appletree Bay · South Bay · Arnold Bay · Carry Bay · Little Eagle Bay ·
   Half Moon Cove · Broad Lake**, plus **"Inland Sea"** (S2, 55 mentions) — all Champlain or Lake
   George. Minting each as its own `waterBodies` row would split the reports, hazards, bounties,
   favorites and aggregate tracks for a single sheet of ice across a dozen rows, and hand the D36 dedup
   queue a permanent stream of parent-vs-child overlap pairs it has no verdict for.

   The corpus was never asking for more bodies. It was asking for **names inside one body**.

2. **"Fix the few bay mis-matches" has no surface that shows you the mistakes.** There is no index on
   `curatedBoost` and no query that lists boosted bodies. `WaterBodyModeratorControls` edits a boost on
   a body you already navigated to; nothing tells you *which* of the 116k carry one. The five known-bad
   from the 2.5 run — **South Bay, Button Bay, Half Moon Cove, Foster Pond** (matched Maine namesakes)
   and **Mill Pond** (a NY namesake) — are invisible until someone remembers them.

   And they aren't five separate bugs: four of the five are Champlain bays whose boost landed on a
   same-named lake elsewhere. The fix is one motion — **strip the wrong boost, draw the right
   sub-area** — which only exists once (1) is settled.

3. **"One map, one session, two jobs" understates the job, and `/admin` has no map at all.** Every
   admin route is a table; `MapView` lives only in the `_map` tree with its own selection context and
   query wiring. The founder's actual ask (2026-07-26) is bigger than a shared map: a **per-lake
   editor** — look up a lake, get a single editing canvas scoped to it, **not pannable away** but
   zoomable, carrying drawing, pin-dropping, hazard moderation and track review together.

4. **Contradiction re-flag bundling is not contradiction-specific, and the obvious fix would corrupt a
   Phase-7b rollup.** `ratings.ts maybeAutoFlag` carries the identical "one *open* flag per author"
   dedup — `contradictions.ts:121` says so in its own comment. So bundling belongs on `contentFlags`
   generally, not in one caller. The trap: `contentFlags.by_status_resolved_at` was built on the stated
   premise that *"`actioned`/`dismissed` accumulate forever"*, so flipping a resolved row back to `open`
   retroactively changes a past day's flag-resolution counts. Reopening is the wrong mechanism.

5. **`weatherSamplePoints` has no writer and no audit vocabulary.** The schema field
   (`schema.ts:249`) and the reader (`lib/sampling.ts`) both ship; there is **zero** mutation, and
   `MODERATION_ACTIONS` has no value to audit one with.

6. **`activeBountyPostLimit`'s own trigger said to wait** ("build it if a real spammer earns it"), and
   Phase 7b already ships the daily-cap-hit-rate metric that would make the case. Overridden at kickoff
   — see Decision 7. Also unnamed by the entry: `BountyForm.tsx` on **both** web and mobile hardcodes
   `MAX_OPEN_BOUNTIES_PER_DAY` into its "Up to 3 open bounties at a time" line, so a per-user limit that
   doesn't reach the copy makes the form lie to the one user it applies to.

7. **The "remove specific users' paths from the heatmap" ask collides with D58.**
   `gpsActivities.listTracksForBody` gates the aggregate layer on four *structural* properties and says
   why: *"there's no separate `sharedToAggregate` flag, because a second flag would let the two
   disagree and would ask people to consent twice to one thing."* A moderator-set per-track exclusion
   is exactly that second flag. Resolved by Decision 8.

---

## Decisions taken at kickoff (2026-07-26)

**Decision 1 — A bay is a named sub-area of one polygon, not a water body.**
New table `waterBodySubAreas`, each row a named region *inside* an existing parent body. Reports,
hazards and bounties keep belonging to the parent; the sub-area is the finer name they carry. This is
the **D4 model** (deferred since Phase 1 for rivers-as-named-reaches) finally instantiated — for lakes
first, where the corpus evidence is overwhelming. *Considered and rejected:* separate overlapping
bodies (fragments every per-body aggregate and poisons the dedup queue); doing nothing (leaves the
top-3 most-mentioned destinations in the corpus unnameable).

**Decision 2 — Sub-areas are drawn by moderators, and this does not breach the path-only doctrine.**
The doctrine exists because a client-supplied *water body* has no proof of presence and no frame of
reference — it would be a guess that then collects other people's reports. A sub-area has neither
problem: its geometry is constrained to lie **inside an already-trusted official polygon**, its author
is a role-gated human, and every write lands a `moderationActions` row. No water body is ever minted
from a drawn shape. `waterBodies.create` is untouched.

**Decision 3 — Membership is stamped at create and re-stamped on edit.**
A report's sub-area is denormalized onto the row at `reports.create`, exactly as `place` already is
from the `adminAreas` resolver. Unlike town boundaries, a drawn bay outline gets refined — so redrawing
or renaming a sub-area **schedules a re-stamp** over that parent's reports and hazards
(`by_water_body_skate_end_time`), which **runs to completion on a cursor and self-reschedules**, never
a capped scan. Maintain-on-write, the house pattern.
*Considered and rejected:* resolving point-in-polygon at read time — correct after every edit, but the
global newsfeed would need each body's sub-area polygons per row, which is an N+1 on the hottest read
in the app.

**Decision 4 — Sub-areas are full citizens: label, search, map, targeting.** All four capabilities land
in N2 (founder call). See *The design* for what each means and where the line falls inside "targeting."

**Decision 5 — The operator surface is a per-lake editor at `/admin/water/$id`.**
Look up a lake → one canvas whose camera is **locked to that body's bbox** (zoom freely, pan only
within it), carrying every per-body lever: prominence, sub-areas, put-ins, weather sample points,
hazards and crossings, aggregate tracks, and this body's review/dedup actions. The existing
`/admin/water` queue becomes the index that routes into it.

**Decision 6 — Auto-flag bundling is a shared `contentFlags` mechanism, and it never mutates a
resolved row.** A repeat occurrence bumps an **open** flag's counter; if the only prior is *resolved*,
it files a **new** row that carries the running count forward and points back via `supersedesFlagId`.
Terminal rows stay terminal, so the 7b resolution rollup keeps meaning what it says.

**Decision 7 — `activeBountyPostLimit` ships now** (founder override of its own trigger), including the
copy path on both clients and the applied-limit stamp on the gate event.

**Decision 8 — Aggregate-track control in the editor is view-only.** The editor lists each contributing
track with its author and linked report; the lever is the existing `setModerationStatus` on that
report, which already drops the track. D58's structural-consent argument stands unamended. An explicit
per-activity exclusion is logged as deferred with a written trigger: a real track that is bad on the
map but fine as a report.

**Decision 9 — Overlapping sub-areas stamp the *smallest containing* one.**
Two bays that share an edge are fine; two that overlap ("Inner" and "Outer" Malletts are exactly this
case) mean a point sits in both. The stamp takes the smallest by area — most specific name wins — and
the editor warns rather than rejects. Promoted from an open question to a decision on N1's evidence:
its whole correction series is one lesson about answers that depended on which row an index reached
first, and "smallest containing" is order-independent where "first match" is not.

**Decision 10 — A drawn shape is clipped to its parent, not rejected by it.** The write intersects the
drawn polygon with the parent and stores the *clipped* result; it refuses only when the clip removes
more than a threshold share of what was drawn (⇒ the shape is mostly off the lake, i.e. a misplaced
draw rather than a sloppy edge). Hand-tracing a bay along a real shoreline cuts across land on almost
every vertex, so reject-by-default means fighting the tool on every bay — and clipping makes the
stored geometry valid *by construction* rather than valid-because-validated. This is the Phase-9.5
`clippedFootprint` pattern (a hazard circle near shore is already clipped to the body polygon so it
can't imply danger across land), reused rather than reinvented. *Considered and rejected:* rejecting
with a which-edge-left message (the original plan text — too much redraw churn, and "a small tolerance"
against a MultiPolygon with islands has no clean definition); clipping silently with no threshold (a
wildly misplaced draw would save as a sliver instead of erroring, which is the silent-wrong-answer
class this repo keeps refusing).

**Decision 11 — A sub-area's visibility is derived from its parent's, and a merge repoints it.**
Sub-area cell rows exist only when the sub-area is not delisted **and** its parent `isListed`, so an
unlisted parent takes its bays dark with it. On `merge`, the loser's sub-areas repoint to the survivor
— a true duplicate's geometry lies inside the survivor's polygon, and merge already repoints reports,
hazards and bounties — with containment re-validated against the survivor and any failure delisted for
the operator to redraw. See *§What the build found* item 1 for the hole this closes.

**Decision 12 — The editor's canvas comes from refactoring `MapView` into a shared shell**, not from a
second map component (founder call, overriding the build's recommendation). One place for map bugs and
one style/layer pipeline beats two diverging canvases, even though the refactor lands on the most
load-bearing untested-by-design file in the web app. The skater path must come out behaviourally
identical; terra-draw stays lazy and admin-only regardless of who owns the shell.

**Decision 13 — The curation session is drawn from the corpus, then corrected.** The build draws all
fourteen Champlain / Lake George sub-areas on dev by inferring each bay's extent from OSM shoreline
geometry plus the S2 mention data, and records every drawn boundary in this doc so the founder can
correct them in the editor after. The alternative — hand the empty canvas over — leaves the phase's
own acceptance test unrun. The tradeoff is explicit: some of these boundaries are inference, and the
doc says which.

**These add two entries to the decision log** — **D60** (named sub-areas; the lake instantiation of D4)
and **D61** (the per-lake operator canvas). Written when the code lands, not before.

---

## What the build found in the plan

Reviewed against the landed post-N1 code at build kickoff (2026-07-26), same discipline the plan
applied to the roadmap entry. Seven corrections, each verified against a file:

1. **Nothing cascaded parent unlisting to sub-areas — the N1 invariant was leaking.** N1's load-bearing
   rule is *unlisted means absent from the cell table*; that is what makes the listing filter free
   (`lib/cellIndex.ts`). This plan gave `waterBodySubAreas` its own `removedAt` and its own cell table
   keyed on that, and never connected the two. A landowner takedown on Lake Champlain drops the body's
   cell rows and would have left "Malletts Bay" outlined and labelled on a map where the lake no longer
   exists — the same for `reject`, and `merge` would have left the loser's bays pointing at a
   merged-away parent. Closed by **Decision 11**.

2. **The sub-area read budget was sized against a premise that isn't how the limit works.** Convex's
   4,096-read cap is **per function execution** — `lib/scan.ts` says so in its own opening paragraph —
   and `subAreas.listInViewport` is a separate query from `waterBodies.listInViewport`, so it gets its
   own full budget. *§What N1 changed* item 1's "a second bounded query on the same view has to be
   sized against the headroom that leaves, not against the cap" is false as stated. The instinct under
   it survives: two layers on one screen is real latency and real payload, and a bay layer drawing 250
   outlines is already generous. So the opening numbers stand — but as a **product** ceiling chosen on
   its own merits and then measured, not as crash-safety arithmetic inherited from N1's table.

3. **`formatPlaceLabel` is not the single composition site the plan named.** It returns only the
   `"Colchester, VT"` segment; `bodyName` is a *separate* `FeedCardView` field that the card components
   render separately (`packages/core/src/feed.ts`). "Malletts Bay · Lake Champlain · Colchester, VT"
   spans both, so the "one composition site, so the label can't disagree with itself" goal needs a
   **new** helper — `formatLocationLine` — with `FeedCard`, `ReportDetail`, `HazardDetail` and both
   mobile equivalents switched onto it. The goal was right; the site was wrong, and it is more UI
   surface than step 4 implied.

4. **`moderation.setPostingPermission` cannot carry `activeBountyPostLimit`.** Its args are
   `permission: 'reports' | 'hazards' | 'comments'` plus `allowed: v.boolean()`, patched through a
   `POSTING_PERMISSION_FIELD` map (`moderation.ts:521`). A nullable *int* does not fit that signature.
   It gets a sibling mutation reusing the same `loadModeratableUser` guard and the same
   `set_posting_permission` audit action — the audit vocabulary was the reusable part, not the mutation.

5. **The bounty index name was missing its moderation gate, and auto-attach is where fulfillment
   actually starts.** `recentReports` reads `by_water_body_moderation_and_skate_end_time` with
   `visible` *inside* the index on purpose, so hidden reports can't eat the scan cap; the sub-area
   index therefore has to be `['subAreaId', 'moderationStatus', 'skateEndTime']`, not the two-field
   name in step 8. Separately, `attachReportToOpenBounties` appends **every** new visible report on a
   body to **every** open bounty on that body — unnarrowed, a Burlington Bay report auto-attaches to a
   Malletts Bay bounty and the requester can thumb it fulfilled, making the whole of Decision 4's
   targeting cosmetic. The plan never named that function.

6. **The audit vocabulary for sub-areas didn't exist.** Decision 2 promises every write lands a
   `moderationActions` row, but `MODERATION_TARGET_TYPES` has no sub-area type and `MODERATION_ACTIONS`
   has no sub-area verbs (`lib/enums.ts:150`). Only `set_weather_sample_points` was named. Four action
   values and one target type are part of step 3, not an afterthought.

7. **Three precision fixes.** Hazards have no `by_water_body_skate_end_time` — that index is
   reports-only; the hazard half of the re-stamp pages `by_water_body`. **Soft-delisting** a sub-area
   has to schedule a re-stamp too (the plan named only redraw and rename), or reports keep rendering a
   delisted bay's name. And `reports.subArea` / `hazards.subArea` are stored as **flat**
   `subAreaId` / `subAreaName` fields rather than a `{ id, name }` object: Convex can index a dotted
   path, but flat sidesteps the optional-object edge case at the index site and reads better where it
   matters, which is the bounty gate's index (item 5).

---

## What N1 changed about this plan

N1 shipped between this plan's kickoff and its build, and its measured results overturned two calls
made here on instinct. Both were the same instinct: *sub-areas are few, so a loose bound is fine.*
That is the exact reasoning N1 exists to retire — `MAX_VIEWPORT_LIMIT = 256` was also fine, against a
corpus 11.6× smaller than the one it was still guarding.

**1. The map-render path gets its own cell table, not a per-parent fan-out.** This plan originally had
`subAreas.listForBodies(waterBodyIds[])` called with the body ids `listInViewport` returned — which is
a fan-out whose input is the render budget, now **1,000** bodies. "Sub-areas only exist on a handful of
giants" is a fact about today's data, not a bound. So:

- **`waterBodySubAreaCells`**, a third table on the *same* ladder-grid mechanism — `spatialCells.ts`
  is already generic over a `CellLadder`, and `lib/cellIndex.ts`'s `diffCells` is generic over
  `StoredCell`, so this is a `syncSubAreaCells` beside the two that exist, not a new mechanism. N1's
  Decision 1 asked for *one* spatial mechanism, and this stays inside it.
- The query reuses `bodiesCoveringBox`'s **two-pass shape** — collect rows across every rung, sort by
  prominence, *then* hydrate — because the round-3 correction proved that ranking a spatially-selected
  prefix silently blanks whole neighbourhoods. A sub-area layer that drew Champlain's bays and none of
  Lake George's, depending on cell arithmetic, is that bug wearing a smaller hat.
- Its budgets are its own and much smaller — though **not for the reason first written here**. The
  original text sized them against N1's leftover headroom (worst measured viewport 1,771 of 4,096,
  derived ceiling 3,512), which assumes the two queries share a read budget. They don't: Convex's cap
  is per *function execution*, so a second query starts at 4,096 of its own. What's actually true is
  the product argument — two layers on one screen is latency and payload, and a bay layer drawing 250
  outlines is already generous. Opening numbers therefore stand as a **chosen ceiling, measured
  afterwards**, not as inherited arithmetic: a 200-row scan budget and a 250 render budget, written
  next to N1's in `waterBodies.ts` and re-measured via a `subAreaReadStats` sibling to
  `viewportReadStats` (step 13). See *§What the build found* item 2.

**2. The re-stamp pages to completion; it is never a capped scan.** The original wording said
"paginated, logged," which N1's round-2 correction shows is not enough on its own: the hazard sweep
capped an index whose order never changes, so every tick re-read the same prefix and everything behind
it starved forever. A re-stamp capped at N over `by_water_body_skate_end_time` would permanently strand
the oldest reports on a busy body — and unlike a stale decay multiplier, a wrong label is *visible* on
the feed card. A cursor that self-reschedules until the body is exhausted has no such failure mode.
(The hazard half pages `by_water_body`; hazards have no skate-end index — *§What the build found*
item 7.)

**3. Two smaller inheritances.** Every cap N2 adds uses `lib/scan.ts`'s `takeCapped`, whose `cap + 1`
probe distinguishes "exactly this many" from "there are more" — the round-4 lesson, and it matters here
because the bundling cooldown lookup *decides* something rather than merely logging. And the bounty
gate's `saturated ⇒ block` rule (rounds 3 and 5) has to survive sub-area targeting: see below.

## The design — named sub-areas

**The table.** One row per named region, always inside a parent.

```
waterBodySubAreas: {
  waterBodyId,                    // parent — required, always an existing body
  name,                           // "Malletts Bay"
  aliases?: string[],             // S2: Malletts/Mallets/Mallett's × Inner/Outer, "Inland Sea"
  searchText,                     // denormalized [name, ...aliases].join(' ') — Convex searches one field
  polygon, bbox, centroid, surfaceAreaSqM?,   // polygon is the CLIPPED shape (Decision 10)
  curatedBoost?, displayScore?, minVisibleZoom?,   // same D49 curve as a body
  createdByUserId, createdAt,
  removedAt?, removedByUserId?,   // soft-delist, reversible — never a hard delete
}
  .index('by_parent', ['waterBodyId'])
  .searchIndex('search_subarea', { searchField: 'searchText' })
```

**Containment is enforced by clipping at the write boundary** (Decision 10), not by rejection: the
drawn polygon is intersected with the parent and the *clipped* result is what gets stored, so a stored
sub-area is inside its parent by construction rather than by assertion. The write refuses only when the
clip removes more than a threshold share of the drawn area — a misplaced draw, not a sloppy shoreline
edge — and says how much was outside. Same `@turf/intersect` path Phase 9.5 uses for `clippedFootprint`.

**And its visibility is derived from the parent's** (Decision 11): a sub-area is renderable only while
it is un-delisted **and** its parent `isListed`. That predicate is what `syncSubAreaCells` writes
against, so — exactly as with bodies under N1 — an unreachable sub-area has no cell rows at all rather
than a filter someone has to remember to apply.

**Prominence reuses D49.** A sub-area gets `displayScore` / `minVisibleZoom` from the same
`@skating/core` display curve, off its own area plus its own `curatedBoost` — so Malletts Bay can label
at a regional zoom while a small cove waits for z13. No second curve to tune.

**Two read paths, each bounded by the mechanism that fits it.** Most sub-area reads are resolved
*within a parent that is already loaded* — the report being created knows its `waterBodyId`, the
search hit carries its parent, the lake page is one body. Those cost a `by_parent` read on a body you
already have: bounded by the handful of sub-areas one lake has, not by the corpus.

The **map render** is the exception, because a viewport is not a parent — and it gets N1's ladder grid
rather than a fan-out. See *§What N1 changed about this plan*.

### The four capabilities

**Label.** `reports.subAreaId` / `subAreaName` and the same pair on `hazards`, stamped at create (flat,
not a nested object — *§What the build found* item 7). The whole location line composes through a
**new** `formatLocationLine` in `packages/core/src/feed.ts`, so the sub-area sits ahead of the body and
the town: **"Malletts Bay · Lake Champlain · Colchester, VT"**. The existing `formatPlaceLabel` only
ever built the `"Colchester, VT"` segment and the body name is a separate field the cards render
separately, so composing there would have left the two halves free to disagree — item 3. Feed card,
report detail and hazard reporter lines on **both** clients move onto the new helper: one composition
site, which is only true once they all use it.

**Search + aliases.** `waterBodies.searchByName` gains a sibling over `search_subarea`; results merge,
with a sub-area hit rendering as *"Malletts Bay — in Lake Champlain"* and flying to the **sub-area's**
bbox rather than the parent's (the whole point: searching a bay shouldn't frame you on 200 km of lake).
Aliases are what make this work at all — S2 found Malletts under ten spellings and the northeast arm
under a name that shares no token with anything ("Inland Sea"). The sibling refines on the *parent's*
listing as well as the sub-area's own (Decision 11) — `searchByName` already refines `isListed` in JS
because it's a derived predicate, and a bay whose lake was taken down must not survive that refine.

**Map render.** A second GeoJSON source draws sub-area outlines and labels inside the parent, fed by
`subAreas.listInViewport` off its **own ladder-grid cell table** (below), with its own render and row
budgets and the same two-pass prominence ordering. Called only at zoom ≥ a threshold, since a bay
label at z8 is noise. Web and **mobile both render** — rendering is not an operator affordance.

**Targeting — and where the line falls.** `bounties.create` takes an optional `subAreaId`, and
fulfillment then requires a report *in that sub-area*, not anywhere on the parent — "someone skate
Malletts Bay" is a materially different ask from "someone skate Champlain," and that difference is most
of why bounties on a giant are weak today. The water-body detail's report list gains a sub-area filter.

**Fulfillment starts at auto-attach, not at the gate.** `attachReportToOpenBounties` appends every new
visible report on a body to every open bounty on that body, and the requester's helpful thumb on an
attached report is what fulfills it. So the sub-area narrow has to happen *there* — a Burlington Bay
report must never attach to a Malletts Bay bounty — or the targeting is a label with no mechanism
behind it (*§What the build found* item 5). Notification fan-out (`fanOutEligibility`) deliberately
stays body-wide: a bay bounty wants more eyes offered, not fewer.

**The freshness gate has to be narrowed at the index, not after it.** N1 left `bounties.recentReports`
scanning `by_water_body_moderation_and_skate_end_time` newest-first under a cap, with a `saturated`
flag that **blocks** when the scan truncated — because a truncated scan cannot clear a body, however
the rows it did read resolve. Filtering that body-level result down to a sub-area afterwards would keep
the cap at body scale while shrinking the useful sample: on Champlain the gate could saturate on 200
reports from Burlington Bay and block a perfectly good Malletts Bay bounty every time. So a sub-area
bounty reads a **sub-area-scoped index** — `['subAreaId', 'moderationStatus', 'skateEndTime']`, with
the moderation gate *inside* the index exactly as the body-scoped one has it, because a post-read
`visible` filter lets hidden reports eat the cap (item 5 corrects the two-field name first written
here). The cap then applies to the set the gate actually judges. The saturation rule is inherited
verbatim, not softened.

**Deliberately not targeted in N2: favorites and drive-time.** Both are per-body and should stay there.
Drive-time in particular gains ~nothing — isochrone bands are cached per user against a body's centroid
(D18), and a sub-area centroid inside the parent sits minutes from it, so a sub-area band would cost a
multiplied cache for a difference below the model's own resolution. Logged as deferred with that
reason, so it isn't rediscovered as an oversight.

---

## The design — the lake editor

**Route.** `/admin/water/$id`, reached from a lake search on `/admin/water` (which keeps its two
existing queues) and from the curation list below. Moderator-gated like the rest of the tree; the
server hard-gates every underlying mutation regardless.

**The canvas is `MapView`, refactored into a shared shell** (Decision 12). `MapView.tsx` is today a
745-line imperative WebGL shell wired to `MapSelectionContext`, `useNavigate`, `NORTHEAST_MAX_BOUNDS`
and drawer-sibling state, deliberately kept mounted across the whole `_map` tree. The refactor lifts a
parameterized base — style, bounds, layer set, click handling — that the skater map and the editor both
configure, leaving the pure transforms where they already live in `lib/waterMap`. The build's own
recommendation was a second, leaner admin component; the founder's call is one shell, and the price is
that this refactor lands on the most load-bearing file in the web app. **The skater path must come out
behaviourally identical**, which is a testing obligation, not an aspiration: the existing map tests run
green unchanged before anything editor-shaped is added.

**The camera is locked to the body.** `maxBounds` = the body's bbox plus a small margin, `minZoom` =
the zoom that fits that bbox. You can zoom into a cove; you cannot wander to the next lake. The lock is
the feature — it makes "which lake am I editing" unambiguous for every tool on the canvas.

**The tools, one canvas, one session:**

| Tool | What it does | Backend |
|---|---|---|
| Prominence | `curatedBoost` with a live preview of the resulting `minVisibleZoom` | `setCuratedBoost` ✅ exists |
| Sub-areas | draw / redraw / rename / alias / soft-delist, clipped to the parent (D10) | **new** |
| Put-ins | drop, move, hide official access pins (S1's dominant concern) | `putIns.setOfficial` / `hide` ✅ |
| Weather sample points | place, plus **suggest a grid** clipped to the polygon | **new** |
| Hazards & crossings | list + hide/remove in place; promote recurring → `bodyFeature` | `moderation.*`, `bodyFeatures.promote` ✅ |
| Aggregate tracks | **view-only** overlay: author, linked report, link to that report's controls | `listTracksForBody` ✅ |
| Review / dedup | approve / reject / merge *this* body | ✅ exists |

So most of the editor is **wiring, not new backend** — three of seven tools need no new function. The
new backend is sub-area CRUD, `setWeatherSamplePoints`, and the curation list. That claim is about the
*backend* and should not be read as a claim about the work: the front end carries the `MapView` refactor
above plus seven tool panels, and it is the larger half of this step.

**Drawing.** MapLibre ships no draw control. Plan of record is **terra-draw** (MIT, first-class
MapLibre adapter) over `@mapbox/mapbox-gl-draw` (needs a compat shim and drags Mapbox styling
assumptions). Web-only, admin-only, and **lazy-loaded on the route** so it never reaches a skater's
bundle. Confirm the dependency at the first commit that needs it; if terra-draw disappoints, the
fallback is a paste-GeoJSON escape hatch, which is also the emergency path if the draw control breaks.

**Weather sample points get suggested, not clicked.** `@skating/core` gains
`suggestSamplePoints(polygon, spacingKm)` — a grid over the bbox, clipped to the polygon, at
Open-Meteo's high-res spacing (~11 km default, tunable and surfaced in the control room). The admin
previews the suggestion, nudges or deletes points, saves. Every saved point is validated to lie **on
water**; sampling land is the one way this feature can silently produce a wrong answer.

**`setWeatherSamplePoints`** is moderator-level and audited under a new
`set_weather_sample_points` value in `MODERATION_ACTIONS`.

---

## The curation pass (the data half)

The mechanism is worthless without the session that uses it. After the editor lands:

1. **`waterBodies.listCurated`** — a `by_curated_boost` index read (`> 0`, so it costs the boosted rows
   and nothing else) behind an `/admin/water` panel listing every body carrying a boost, with its
   states, area and resulting `minVisibleZoom`. This is the surface that makes a mis-match *visible*.
2. **Re-partition the seed.** `training_data/google_group/curated_boost_seed_vt.csv` (34 rows) splits
   into *bodies to boost* and *sub-areas to draw*. The five known mis-matches get their boost stripped
   from the namesake and their name redrawn as a sub-area on the right lake.
3. **Draw the Champlain and Lake George sub-areas** in one editing session — the thirteen above plus
   "Inland Sea," each with its alias set from the corpus spelling variants.
4. **Place sample points** on Champlain and Winnipesaukee while the canvas is already open. This is the
   roadmap's "one map, one session, two jobs," and it only works because of Decision 5.
5. **Chase the one genuine unknown:** "Saranac Lake" failed to match, and the likely cause is a naming
   mismatch (OSM carries *Lower* Saranac Lake), not missing geometry. Verify against the dev corpus
   before concluding anything — if it *is* missing, it's the one case that would need a real body, and
   that's a decision to bring back rather than improvise.

**The seed apply path stays**, since it's how prod gets the same curation later. Extend
`applyCuratedBoostSeed` with an explicit body-id column so a re-run can't repeat the name-collision
class that caused the mis-matches in the first place.

---

## The two smaller items

**Auto-flag bundling.** A shared `lib/autoFlag.ts` used by both `contradictions.flagContradictionPattern`
and `ratings.maybeAutoFlag`. `contentFlags` gains `occurrences?`, `lastOccurrenceAt?`,
`supersedesFlagId?` (all optional ⇒ migration-free):

- an **open** flag for this (target, reason) → bump `occurrences` + `lastOccurrenceAt`; no new row, and
  the D38 operator alert re-fires only on a threshold multiple, not every time;
- the only prior is **resolved** and within a cooldown → file a **new** row carrying the count forward
  with `supersedesFlagId` set. The resolved row is never touched, so `by_status_resolved_at` stays
  terminal and the 7b rollup stays correct;
- no prior within the cooldown → a fresh row at `occurrences: 1`.

The flag queue renders "4th occurrence · last dismissed 6d ago" with a link to prior dispositions —
which is the actual thing a moderator needs to decide the D57 lever, and what a stream of identical
rows was hiding.

**`activeBountyPostLimit`.** `profiles.activeBountyPostLimit?: number` (nullable int; `0` ⇒ can't post),
read by `bounties.createChecked` as `?? MAX_OPEN_BOUNTIES_PER_DAY`, shown and editable on
`/admin/users/$id`. It gets a **sibling mutation**, not a new argument on
`moderation.setPostingPermission`: that mutation's shape is `permission: 'reports' | 'hazards' |
'comments'` × `allowed: boolean`, patched through a field map, and a nullable int doesn't fit it
(*§What the build found* item 4). The reusable parts are what get reused — the same
`loadModeratableUser` guard and the same `set_posting_permission` audit action, so the moderation log
reads as one story. Two details the register didn't name: the `capped` **gate event records the applied
limit**, so 7b's cap-rate chart can't confuse a global cap with a per-user one; and **both**
`BountyForm.tsx` files read the effective limit rather than the constant, so the form doesn't promise a
limited user three bounties.

---

## Work breakdown

Committed in this order; one PR at the end (per the phase convention). Everything assumes N1 has
merged.

1. **This doc** — the design and the corrections, on record before the code.
2. **`@skating/core`** — sub-area geometry (clip-to-parent, area, centroid), `suggestSamplePoints`, and
   `formatLocationLine` in `feed.ts`. Property tests: a suggested point is always inside the polygon;
   spacing is never finer than requested; a clipped shape is always inside its parent, and a shape
   mostly outside is refused rather than saved as a sliver.
3. **`waterBodySubAreas` schema + CRUD** — create / redraw / rename / alias / soft-delist, moderator-
   gated, clip-validated, audited under new `MODERATION_ACTIONS` + target type; the cursor-driven
   re-stamp over the parent's reports (`by_water_body_skate_end_time`) and hazards (`by_water_body`),
   scheduled by redraw, rename **and** soft-delist.
4. **The parent-listing cascade** — `syncSubAreaCells` takes the parent's `listed`;
   `approve`/`remove`/`restore`/`reject`/`merge`/`importCanonical` cascade over `by_parent`; merge
   repoints the loser's sub-areas to the survivor, re-clipping and delisting what no longer fits
   (Decision 11).
5. **Stamping + labels** — `subAreaId` / `subAreaName` at create on reports and hazards; feed card,
   report detail, hazard lines through `formatLocationLine`; web + mobile.
6. **Search + aliases** — `search_subarea`, merged results refined on parent listing, fly-to-sub-area;
   web + mobile.
7. **`waterBodySubAreaCells` + `subAreas.listInViewport`** — the third `syncSubAreaCells` on the shared
   ladder grid, the two-pass prominence scan, its own budgets, and a `subAreaReadStats` sibling.
8. **Map render** — the sub-area source/layers on both clients, the zoom threshold.
9. **Targeting** — `bounties.subAreaId`, the narrowed `attachReportToOpenBounties`, the
   `['subAreaId','moderationStatus','skateEndTime']` gate scoping with the saturation rule intact; the
   lake-page report filter.
10. **`setWeatherSamplePoints`** + the `set_weather_sample_points` audit action + the suggest-grid flow.
11. **The lake editor** — the `MapView` shared-shell refactor (skater path green first), then
    `/admin/water/$id`, camera lock, the draw control (lazy), and the seven tools wired; `listCurated`
    + the curation panel on `/admin/water`.
12. **Auto-flag bundling** — `lib/autoFlag.ts`, the `contentFlags` fields, both callers, queue UI.
13. **`activeBountyPostLimit`** — field, gate, the sibling mutation, admin control, gate-event stamp,
    both clients' copy.
14. **The curation session + measurement** — the data pass above; what got drawn and boosted, plus the
    measured sub-area read counts *and the two per-screen query costs side by side*, recorded in this
    doc the way N1 recorded its table.
15. **Docs** — roadmap N2 struck with a pointer; D60/D61 written into `01-decisions.md`; `06-data-model.md`
    for the new table and fields; the Phase-2.5 mis-match note closed; `02-open-questions.md` S2 struck
    (it's answered by D60).

---

## The curation session — what it found (dev, 2026-07-26)

Run against the real 116,070-body dev corpus, per Decision 13: boundaries inferred from OSM geometry
plus the S2 mention data, recorded here so the founder can correct them in the editor. **Every
boundary below is inference and should be read as one.**

### Three of the plan's premises were wrong, and the corpus said so

1. **The five "known mis-matches" are not live, and have not been for a while.** `listCurated`
   returns **16** boosted bodies and none of them is South Bay, Button Bay, Half Moon Cove, Foster
   Pond or Mill Pond. Better than that: those five carry a stored `curatedBoost: 0` rather than an
   absent field — which is the fingerprint of `setCuratedBoost(0)`, i.e. someone found and stripped
   them. The Phase-2.5 note the plan inherited is a stale record of a problem already fixed. Step 2
   of the curation pass therefore had nothing to strip; what it *did* need was the list, which is why
   `listCurated` still earns its place.

2. **Two of those names are real bodies, not missing bays.** "South Bay" exists as a 5.3 km² NY/VT
   body at Champlain's southern tip, and "Half Moon Cove" as a 0.05 km² VT body near Burlington. The
   plan filed both as sub-areas OSM lacks; OSM has them.

3. **Saranac Lake is neither of the two things the plan expected.** It isn't missing geometry and it
   isn't a sub-area: OSM carries **Upper** (19.5 km²), **Lower** (8.5 km²) and **Middle** (5.7 km²)
   Saranac Lake as three separate bodies, and the corpus's bare "Saranac Lake" almost certainly means
   Lower, the one by the village. So it's an **alias problem on a body** — and bodies have no alias
   field. Only sub-areas do. That's a real gap in the model rather than a curation task, and it goes
   back to the founder rather than getting improvised (see *Open after this phase*).

### What got drawn — nine bays on Lake Champlain

Each row is a bounding box clipped to the lake's own polygon (see `subAreas.importSeed`), so the
*shoreline* is OSM's and only the *naming* is inference. `retained` is the fraction of the box that
was water — the calibration figure the plan asked this session to produce.

| Bay | Aliases seeded | Area (km²) | Draws from | retained |
|---|---|---|---|---|
| Broad Lake | The Broad Lake, Main Lake | 151.4 | z7 | 0.71 |
| Inland Sea | The Inland Sea, Northeast Arm | 30.8 | z8 | 0.42 |
| Outer Malletts Bay | Outer Bay, Outer Malletts | 27.7 | z8 | 0.82 |
| Burlington Bay | Burlington Harbor, Burlington Harbour | 12.0 | z8 | 0.75 |
| Arnold Bay | — | 11.4 | z8 | 0.92 |
| Shelburne Bay | Shelburne | 9.4 | z8 | 0.61 |
| Little Eagle Bay | — | 7.4 | z8 | 0.70 |
| Malletts Bay | Mallets Bay, Mallett's Bay, Malletts, Mallets, Inner Malletts | 6.4 | z9 | 0.69 |
| Appletree Bay | Apple Tree Bay | 5.1 | z9 | 0.66 |

**Not drawn, and why.** *Dillenbeck Bay* and *Carry Bay* both bottomed out near 0.16–0.17 retained
wherever I put a box, which means my coordinates are wrong rather than my rectangle being loose —
the threshold caught exactly what it exists to catch. *Northwest Bay* (Lake George) reached 0.55 on
the first guess and got worse when I moved it, so it's close but not confidently placed. All three
are left for someone who knows the water.

### The threshold: 0.6 is right for a trace and wrong for a box

The measured spread is the useful output. Boxes on the right water retained **0.92 / 0.82 / 0.75 /
0.71 / 0.70 / 0.69 / 0.66 / 0.61**; boxes in the wrong place retained **0.16–0.17**. Between them
sits the **Inland Sea at 0.42**, which is neither — it's a genuine archipelago arm where roughly half
of any rectangle is islands, and no box will ever do better.

So the bar the threshold has to clear is *"is this on the right water"*, not *"is this a good shape"*,
and the gap between 0.42 and 0.17 is where it belongs. The interactive draw path keeps
`SUB_AREA_MIN_RETAINED_FRACTION = 0.6` — a **traced** outline really should be mostly water — and
`importSeed` defaults to **0.35**, because a bounding box is coarse by construction and a bay is
enclosed by land. What gets stored is the clip either way, so the looser bar costs nothing in the
data.

### Measured reads — both layers, same viewport

`approxDocumentReads`, from `waterBodies:viewportReadStats` and `subAreas:subAreaReadStats`. Neither
query truncated at any of these.

| Viewport | zoom | bodies | body reads | bays | bay reads |
|---|---|---|---|---|---|
| Malletts Bay close-in | 13 | 4 | 157 | 1 | 24 |
| Burlington waterfront | 12 | 50 | 208 | 4 | 24 |
| Champlain basin | 10 | 57 | 261 | 8 | 36 |

The bay layer costs **24–36 reads** where the body layer costs 157–261, and the two are separate
function executions with a 4,096 cap each (*§What the build found* item 2). The 200/250 budgets are
therefore nowhere near binding, which is the intended outcome: they're a product ceiling on payload,
kept small deliberately, and now measured rather than asserted.

### Two bugs the live corpus found that no fixture had

Both in the merged search, both invisible to a two-row test:

1. **Bays were being sliced off the page entirely.** The merge took `max` bodies, appended bays, then
   `slice(0, max)` — so whenever the body index filled the page, every bay was dropped. Live,
   "Inland Sea" returned Dead Sea, Billington Sea and Seabreeze Lagoon, and not the arm of Lake
   Champlain that is actually called that. Bays now get reserved slots.
2. **Then they ranked eighth.** Convex scores each search index independently, so a merged list
   ordered by table puts every *fuzzy* body match ahead of an *exact* bay match. The merged set is
   now tiered by match quality first — exact name or alias, then substring, then fuzzy — with bodies
   still winning inside a tier, so "Champlain" lands on the lake and "Inland Sea" lands on the bay.

Both are pinned by regression tests that seed a full page of fuzzy bodies, since that's the condition
a small fixture can't reproduce.

### Left undone

- **Sample points are computed but not saved.** The grid for Lake Champlain proposes **9 points** at
  the default 11 km spacing; Lake Winnipesaukee proposes **1**, which is the correct answer — at
  180 km² it isn't actually a multi-cell body, so the plan's instinct to pair it with Champlain was
  wrong. Saving needs a moderator, and **dev has no moderator account** (both profiles are
  `member`), so this waits for the founder in the editor rather than being unblocked by promoting a
  user unasked.
- **Seeding is one bay per call.** Champlain's polygon carries 116 rings and 10,755 vertices, so a
  clip against it runs comfortably inside a mutation's 1s budget alone and blows it at a dozen. The
  interactive path clips once, so it's fine; the batch seeder needs small batches, which is now noted
  on the function.

---

## Testing (D40)

- **`@skating/core`** — property tests for clip-to-parent and sample-point suggestion (above); unit
  tests for `formatLocationLine` including the both-absent and sub-area-only cases.
- **`convex-test`** — role gates and an audit row per sub-area mutation; a polygon overhanging its
  parent is stored clipped and one mostly outside is refused; a redraw re-stamps affected reports and
  *only* affected reports; **delisting a parent hides its sub-areas, and a merge repoints them**; a
  report elsewhere on the parent neither attaches to nor fulfills a sub-area bounty; bundling bumps an
  open flag, supersedes a resolved one, and never patches a terminal row; `activeBountyPostLimit`
  overrides the global cap in both directions and `0` blocks. Explicit longer timeouts on the heavy
  suites (CI's 5s default flakes).
- **Web** — the existing map suite green *unchanged* across the `MapView` shell refactor (Decision 12's
  obligation), then the editor's camera lock (cannot pan past `maxBounds`), a draw→save→render round
  trip, the non-operator redirect, a11y + dark mode on the new canvas (D34).
- **Mobile** — sub-area render and label; no operator affordances (Phase 7 rule holds).
- **Live** — the curation session is itself the acceptance test, and step 14 records what it found.

---

## Open after this phase

- **Bodies have no aliases, and Saranac Lake needs one.** The corpus asks for "Saranac Lake"; OSM has
  Upper, Lower and Middle. That's not a missing body and not a sub-area — it's a name for an existing
  body that the model has nowhere to put. Sub-areas got `aliases` because the bays needed them; the
  same argument applies one level up, and the fix is probably `waterBodies.aliases` folded into
  `search_name`'s denormalized field the same way. **Founder call**, since it touches the body model.
- **Two bays and one Lake George bay are unplaced** (Dillenbeck, Carry, Northwest) — see the session
  notes. They need local knowledge, not another inference pass.
- **Weather sample points aren't saved on Champlain** — the grid is computed and recorded, but dev
  has no moderator account to save it with.

## To settle during the build

- **Nesting.** "Inland Sea" plausibly contains other named bays. One level or arbitrary depth? Lean:
  allow the geometry to nest, keep the *stamp* single-valued (Decision 9's smallest-containing rule
  already makes nesting well-defined), and defer any parent-of-sub-area pointer until something needs
  it.
- **Sub-area render threshold and budgets.** The zoom at which `subAreas.listInViewport` starts firing,
  and the 200/250 opening numbers. Both get picked against the real Champlain draw and *measured*, not
  guessed — that is the one process commitment N1 earned. Log them next to N1's constants in the
  control room.
- ~~**The clip-refusal threshold**~~ **settled by the curation session**: 0.6 for an interactive
  trace, 0.35 for a box-seeded row, on the measured spread recorded above (0.61–0.92 for boxes on the
  right water, 0.16–0.17 for misplaced ones, and the Inland Sea at 0.42 because it's an archipelago).
- **Does the sub-area report index earn its keep?** It exists to keep the bounty gate's cap meaningful
  at sub-area scale. If sub-area bounties turn out rare, a body-scoped scan plus the saturation block is
  a correct-but-conservative fallback that costs no index.
- **terra-draw** — confirm at first use; paste-GeoJSON is the fallback and the break-glass path.
- **How much of `MapView` the shared shell should own** (Decision 12). The line between "base map" and
  "the skater map's behaviour" isn't obvious from outside the file, and drawing it too high produces a
  shell with a dozen conditional props — which is two components wearing one name. Settle it against
  the diff, and keep the skater suite green as the arbiter.
- **Bundling cooldown** — 30d is the opening number, and it belongs in the control room with the chart
  that says whether it's right (repeat-flag interval distribution).
