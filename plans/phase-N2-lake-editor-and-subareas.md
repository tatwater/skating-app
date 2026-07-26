# N2 — The lake editor + named sub-areas

> **Status: planned (kickoff 2026-07-26).** The second item in the roadmap's *Next-phase candidates*
> register ([`07-roadmap.md`](./07-roadmap.md) → *Later / deferred* → N2), picked second because the
> founder **is** the operator, and because the corpus models its most-skated destinations worst.
>
> **Sequenced after [N1](./phase-N1-read-path-durability.md)**, which is ✅ complete on dev (PR #27).
> They share `waterBodies.ts` and `schema.ts`, and N2 adds a body-annotating write path that has to be
> consistent with what N1 left behind. Everything below is written against the **landed** post-N1 code,
> and *§What N1 changed about this plan* records the two design calls its evidence overturned.

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

**These add two entries to the decision log** — **D60** (named sub-areas; the lake instantiation of D4)
and **D61** (the per-lake operator canvas). Written when the code lands, not before.

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
- Its budgets are its own and much smaller, because **it shares a screen with the body layer**. N1's
  worst *measured* viewport reads 1,771 of 4,096 and its worst *bounded* one 2,531; the derived
  ceiling is 3,512. A second bounded query on the same view has to be sized against the headroom that
  leaves, not against the cap. Opening numbers: a 200-row scan budget and a 250 render budget, with
  the combined arithmetic written next to N1's in `waterBodies.ts` and re-measured via a
  `subAreaReadStats` sibling to `viewportReadStats` (step 12).

**2. The re-stamp pages to completion; it is never a capped scan.** The original wording said
"paginated, logged," which N1's round-2 correction shows is not enough on its own: the hazard sweep
capped an index whose order never changes, so every tick re-read the same prefix and everything behind
it starved forever. A re-stamp capped at N over `by_water_body_skate_end_time` would permanently strand
the oldest reports on a busy body — and unlike a stale decay multiplier, a wrong label is *visible* on
the feed card. A cursor that self-reschedules until the body is exhausted has no such failure mode.

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
  polygon, bbox, centroid, surfaceAreaSqM?,
  curatedBoost?, displayScore?, minVisibleZoom?,   // same D49 curve as a body
  createdByUserId, createdAt,
  removedAt?, removedByUserId?,   // soft-delist, reversible — never a hard delete
}
  .index('by_parent', ['waterBodyId'])
  .searchIndex('search_subarea', { searchField: 'searchText' })
```

**Containment is validated at the write boundary**, not assumed: a sub-area polygon must lie within its
parent (Turf, with a small tolerance for the shoreline vertices a hand-drawn bay will cut). A shape
that escapes the parent is rejected with a message that says which edge left.

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

**Label.** `reports.subArea` and `hazards.subArea` carry `{ id, name }`, stamped at create. The feed
card composes through `formatPlaceLabel` (`packages/core/src/feed.ts`) so the sub-area sits ahead of
the town: **"Malletts Bay · Lake Champlain · Colchester, VT"**. Report detail and hazard reporter lines
follow the same helper — one composition site, so the label can't disagree with itself across surfaces.

**Search + aliases.** `waterBodies.searchByName` gains a sibling over `search_subarea`; results merge,
with a sub-area hit rendering as *"Malletts Bay — in Lake Champlain"* and flying to the **sub-area's**
bbox rather than the parent's (the whole point: searching a bay shouldn't frame you on 200 km of lake).
Aliases are what make this work at all — S2 found Malletts under ten spellings and the northeast arm
under a name that shares no token with anything ("Inland Sea").

**Map render.** A second GeoJSON source draws sub-area outlines and labels inside the parent, fed by
`subAreas.listInViewport` off its **own ladder-grid cell table** (below), with its own render and row
budgets and the same two-pass prominence ordering. Called only at zoom ≥ a threshold, since a bay
label at z8 is noise. Web and **mobile both render** — rendering is not an operator affordance.

**Targeting — and where the line falls.** `bounties.create` takes an optional `subAreaId`, and
fulfillment then requires a report *in that sub-area*, not anywhere on the parent — "someone skate
Malletts Bay" is a materially different ask from "someone skate Champlain," and that difference is most
of why bounties on a giant are weak today. The water-body detail's report list gains a sub-area filter.

**The freshness gate has to be narrowed at the index, not after it.** N1 left `bounties.recentReports`
scanning `by_water_body_moderation_and_skate_end_time` newest-first under a cap, with a `saturated`
flag that **blocks** when the scan truncated — because a truncated scan cannot clear a body, however
the rows it did read resolve. Filtering that body-level result down to a sub-area afterwards would keep
the cap at body scale while shrinking the useful sample: on Champlain the gate could saturate on 200
reports from Burlington Bay and block a perfectly good Malletts Bay bounty every time. So a sub-area
bounty reads a **sub-area-scoped index** (`reports.by_sub_area_skate_end_time`), where the cap applies
to the set the gate actually judges. The saturation rule is inherited verbatim, not softened.

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

**The camera is locked to the body.** `maxBounds` = the body's bbox plus a small margin, `minZoom` =
the zoom that fits that bbox. You can zoom into a cove; you cannot wander to the next lake. The lock is
the feature — it makes "which lake am I editing" unambiguous for every tool on the canvas.

**The tools, one canvas, one session:**

| Tool | What it does | Backend |
|---|---|---|
| Prominence | `curatedBoost` with a live preview of the resulting `minVisibleZoom` | `setCuratedBoost` ✅ exists |
| Sub-areas | draw / redraw / rename / alias / soft-delist, containment-validated | **new** |
| Put-ins | drop, move, hide official access pins (S1's dominant concern) | `putIns.setOfficial` / `hide` ✅ |
| Weather sample points | place, plus **suggest a grid** clipped to the polygon | **new** |
| Hazards & crossings | list + hide/remove in place; promote recurring → `bodyFeature` | `moderation.*`, `bodyFeatures.promote` ✅ |
| Aggregate tracks | **view-only** overlay: author, linked report, link to that report's controls | `listTracksForBody` ✅ |
| Review / dedup | approve / reject / merge *this* body | ✅ exists |

So most of the editor is **wiring, not new backend** — three of seven tools need no new function. The
new backend is sub-area CRUD, `setWeatherSamplePoints`, and the curation list.

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
read by `bounties.createChecked` as `?? MAX_OPEN_BOUNTIES_PER_DAY`, set through the existing
`moderation.setPostingPermission` and its `set_posting_permission` audit action, shown and editable on
`/admin/users/$id`. Two details the register didn't name: the `capped` **gate event records the applied
limit**, so 7b's cap-rate chart can't confuse a global cap with a per-user one; and **both**
`BountyForm.tsx` files read the effective limit rather than the constant, so the form doesn't promise a
limited user three bounties.

---

## Work breakdown

Committed in this order; one PR at the end (per the phase convention). Everything assumes N1 has
merged.

1. **This doc** — the design and the corrections, on record before the code.
2. **`@skating/core`** — sub-area geometry (containment, area, centroid), `suggestSamplePoints`, and the
   label composition in `feed.ts`. Property tests: a suggested point is always inside the polygon;
   spacing is never finer than requested; containment accepts a shape inside and rejects one that
   escapes.
3. **`waterBodySubAreas` schema + CRUD** — create / redraw / rename / alias / soft-delist, moderator-
   gated, containment-validated, audited; the cursor-driven re-stamp over the parent's reports and
   hazards.
4. **Stamping + labels** — `reports.subArea` / `hazards.subArea` at create; feed card, report detail,
   hazard lines through the one composition helper; web + mobile.
5. **Search + aliases** — `search_subarea`, merged results, fly-to-sub-area; web + mobile.
6. **`waterBodySubAreaCells` + `subAreas.listInViewport`** — the third `syncSubAreaCells` on the shared
   ladder grid, the two-pass prominence scan, its own budgets, and a `subAreaReadStats` sibling.
7. **Map render** — the sub-area source/layers on both clients, the zoom threshold.
8. **Targeting** — `bounties.create` sub-area option, the `by_sub_area_skate_end_time` gate scoping
   with the saturation rule intact; the lake-page report filter.
9. **`setWeatherSamplePoints`** + the `set_weather_sample_points` audit action + the suggest-grid flow.
10. **The lake editor** — `/admin/water/$id`, camera lock, the draw control (lazy), and the seven tools
   wired; `listCurated` + the curation panel on `/admin/water`.
11. **Auto-flag bundling** — `lib/autoFlag.ts`, the `contentFlags` fields, both callers, queue UI.
12. **`activeBountyPostLimit`** — field, gate, audit, admin control, gate-event stamp, both clients' copy.
13. **The curation session + measurement** — the data pass above; what got drawn and boosted, plus the
    measured sub-area read counts *and the combined body-plus-sub-area figure for one screen*, recorded
    in this doc the way N1 recorded its table.
14. **Docs** — roadmap N2 struck with a pointer; D60/D61 written into `01-decisions.md`; `06-data-model.md`
    for the new table and fields; the Phase-2.5 mis-match note closed; `02-open-questions.md` S2 struck
    (it's answered by D60).

---

## Testing (D40)

- **`@skating/core`** — property tests for containment and sample-point suggestion (above); unit tests
  for label composition including the both-absent and sub-area-only cases.
- **`convex-test`** — role gates and an audit row per sub-area mutation; a polygon escaping its parent
  is rejected; a redraw re-stamps affected reports and *only* affected reports; a bounty on a sub-area
  is not fulfilled by a report elsewhere on the parent; bundling bumps an open flag, supersedes a
  resolved one, and never patches a terminal row; `activeBountyPostLimit` overrides the global cap in
  both directions and `0` blocks. Explicit longer timeouts on the heavy suites (CI's 5s default flakes).
- **Web** — the editor's camera lock (cannot pan past `maxBounds`), a draw→save→render round trip, the
  non-operator redirect, a11y + dark mode on the new canvas (D34).
- **Mobile** — sub-area render and label; no operator affordances (Phase 7 rule holds).
- **Live** — the curation session is itself the acceptance test, and step 12 records what it found.

---

## To settle during the build

- **Nesting.** "Inland Sea" plausibly contains other named bays. One level or arbitrary depth? Lean:
  allow the geometry to nest, keep the *stamp* single-valued (Decision 9's smallest-containing rule
  already makes nesting well-defined), and defer any parent-of-sub-area pointer until something needs
  it.
- **Sub-area render threshold and budgets.** The zoom at which `subAreas.listInViewport` starts firing,
  and the 200/250 opening numbers. Both get picked against the real Champlain draw and *measured*, not
  guessed — that is the one process commitment N1 earned. Log them next to N1's constants in the
  control room.
- **Does `reports.by_sub_area_skate_end_time` earn its index?** It exists to keep the bounty gate's cap
  meaningful at sub-area scale. If sub-area bounties turn out rare, a body-scoped scan plus the
  saturation block is a correct-but-conservative fallback that costs no index.
- **terra-draw** — confirm at first use; paste-GeoJSON is the fallback and the break-glass path.
- **Bundling cooldown** — 30d is the opening number, and it belongs in the control room with the chart
  that says whether it's right (repeat-flag interval distribution).
