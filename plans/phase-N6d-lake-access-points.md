# Phase N6d — Lake access points: parking, named put-ins, and access alerts

> **Status:** 📋 Scoped, not built (2026-07-30). Founder ask, same day.
> **Split from** [N6c](./phase-N6c-expanded-lake-profiles.md) at scoping — it was roughly the size of
> everything else in that phase combined, and it is the only part touching a new lifecycle.
> **Depends on:** nothing in N6c. These two can run in parallel or in either order.
> **Touches:** the existing `putIns` table, the Phase 1 OSM ETL, the Phase 9 confirm/deny machinery,
> the N2 lake editor, and N5a's season boundary.
> **Decisions:** D72, D73, and **D87/D88** added 2026-07-31 (see [`01-decisions.md`](./01-decisions.md)).
> **All four open questions were answered 2026-07-31.** Two changed the build: **approach distance is
> routed via OpenRouteService `foot-hiking`** (D87 — the account Phase 4 already uses, and it returns
> elevation gain), and **`parkingAreas` is many-to-many with bodies** because the association radius caps
> inference, not human assertion (D72 amendment).

---

## Why this phase exists

We know where every lake is. We know almost nothing about how you get onto one.

`putIns` today is a coordinate, a source and a status (`packages/convex/convex/schema.ts:1115`) — no
name, no notion of how you reach it. Our directions deep link (`directionsUrl`,
`packages/core/src/putIn.ts:144`, wired into `apps/web/src/components/DirectionsButton.tsx` and
`apps/mobile/src/components/FavoriteButton.tsx`) routes a car to that coordinate. For a body you drive
right up to, fine. For a hike-in pond, we are handing a maps app a destination it cannot route to, and
the skater finds out at the trailhead — in winter, in the dark, having driven an hour.

The founder's framing is exactly right: many put-ins are drive-up or close enough to guess, but
**tracking parking separately is what lets us handle hike-in spots properly** instead of pretending
every launch has a road to it.

This phase inherits N6c's governing rule, and it is the harder test of it:

> **P1 (D70) — Derived or third-party, never hand-maintained.**

Access information is exactly the content that rots. A gate that reopened in April still reads "closed"
in December, because the person who wrote it moved on. So everything here either comes from OSM, comes
from a skater, or expires on its own. **No free-text field in this phase is permanent.**

---

## Workstream A — The model: parking as a first-class thing

### A1 — Additive, not a rewrite (D72)

`putIns` is load-bearing across drive-time bands, the notification fan-out, N3 deletion and the Phase 5
feed. Renaming it to a general `accessPoints` table would put a metadata phase on the critical path of
five other systems for no user-visible gain. So:

**New table `parkingAreas`:**

| Field | Notes |
|---|---|
| `waterBodyIds` | **plural** — a trailhead lot can serve several ponds, and a mile-away lot often does (open question 4). Many-to-many from the start; retrofitting a single id is the annoying version of this. |
| `coord` | where the car goes |
| `name` | from OSM where available, else derived (A3) |
| `source` | same ladder discipline as `putIns` — `official` beats `osm` |
| `status` | `visible` / `hidden` (moderator-suppressed), mirroring `putIns` |
| `amenities` | `('toilets' \| 'trail' \| 'boat_ramp')[]` |
| `capacity?`, `fee?` | from OSM tags where present; both optional |
| `createdByUserId?`, `createdAt` | |

**`putIns` gains:** `name`, `parkingAreaId?`, `approachMeters?`, and
`approachKind: 'drive_up' | 'short_walk' | 'hike_in'` — derived from `approachMeters` with an operator
override.

**The actual fix is a routing rule:** directions target the **parking area** when one exists, else the
put-in. `directionsUrl` itself doesn't change; its call sites pick a better target, and the drawer shows
the remaining approach — *"park here, then about 400 m on foot."*

### A2 — Amenity scope (founder calls, recorded so they aren't relitigated)

- **Toilets ✅, trails ✅, parking ✅** — all three change whether a trip works.
- **Boat ramp ✅, kept** — the ice-fishing rationale holds, and it costs nothing: it is the *same OSM tag*
  we already read to find put-ins (`leisure=slipway`), so excluding it would be extra work.
- **Food ❌** — everyone has a maps app for restaurants, and it is the amenity most likely to be wrong.

### A3 — Names come from OSM, and fall back to a derived label

This is what makes the phase work at 116k scale rather than 36.

**OSM already names these features.** "Lake Fairlee Boat Ramp" *is* an OSM `leisure=slipway` with a
`name` tag. So does a state fishing access area, a town beach, a trailhead lot. The founder's "derive
put-in names wherever possible" isn't a compromise here — OSM is the better source, because it is
maintained by people who are already maintaining it.

**Fallback when OSM has no name:** a deterministic **compass-side label** from the point's bearing off
the centroid — "North launch", "East launch". Deterministic matters: it is re-derivable on every
re-import and never drifts, and it happens to match how skaters already talk about a lake's ends.

---

## Workstream B — Derive it all from OSM

### B1 — A second `osmium tags-filter` pass

Over the *same* Geofabrik state extract the water pass already downloads
(`scripts/etl/README.md`, step 2). No new source, no new download, no new account.

| OSM tag | Becomes |
|---|---|
| `leisure=slipway` / `waterway=slipway` | put-in candidate + `boat_ramp` amenity |
| `amenity=parking` (+ `parking=*`, `access=*`, `fee=*`, `capacity=*`) | parking area |
| `amenity=toilets` | `toilets` amenity |
| `highway=path\|footway\|track`, `route=hiking` | `trail` amenity + approach path |
| `natural=beach`, `leisure=fishing`, `man_made=pier` | put-in candidate |

### B2 — Association rules

- Put-in candidates within **~30 m** of a body's polygon boundary attach to that body.
- Parking within **~250 m** (`PARKING_INFER_RADIUS_M`) of a put-in candidate or the shoreline attaches to
  it. **This bounds the ETL's guessing only** — a human can associate parking at any distance (D72
  amendment, open question 4).
- `approachMeters` + `approachAscentM` = a routed **ORS `foot-hiking`** leg from parking to put-in
  (D87), falling back to straight-line **flagged as such**, since straight-line under-reports. Computed
  once at ETL and cached on the row; **never from a request path**.

Both thresholds are tunable constants with tests, not magic numbers. They will need one round of
eyeballing against real output — the 250 m figure in particular is a guess that a dense state will
falsify quickly. *(They stay code constants, per [N6c's tuning-constants note](./phase-N6c-expanded-lake-profiles.md#where-the-tuning-constants-live); if the ETL tuning loop gets tedious, the fix is a script flag, not a database row.)*

### B3 — Provenance and re-import safety

Add an **`osm` rung to the existing `PUTIN_SOURCES`**, below `official`. Same rule as the N6a depth
ladder and the N2 editor: **a derived access point never overwrites an operator-set one.** Derived rows
are keyed on OSM id, so a re-run updates in place rather than duplicating — the same discipline that lets
`importCanonical` re-run without destroying curation.

### B4 — Coverage expectation, stated honestly

OSM's coverage of parking and slipways in the rural Northeast is real but patchy. Expect solid results on
well-known bodies and nothing on most of the 116k.

That is fine. It is strictly more than the zero we have now, it costs one ETL pass over a file we already
download, and the gaps are exactly where Workstream C's community layer and operator edits fill in.
**Do not** let the patchiness argue for hand-entering the rest — that is the trap P1 exists to prevent.

---

## Workstream C — "Temporarily inaccessible": a community alert, not a text field (D73)

### C1 — Why not a note

The founder's instinct here is the same as P1, and it is worth spelling out because the alternative is so
tempting: a free-text seasonal note — *"road closed south of the gate until repairs are done"* — is a
promise to maintain something nobody will maintain. It is correct the day it's written and wrong by
spring, and nothing in the system knows the difference.

### C2 — So model it like a hazard

Reusing machinery we already built, which is most of the argument for this shape:

- A user drops an **`accessAlerts`** row on a put-in or parking area with a reason
  (`road_closed`, `gate_locked`, `not_plowed`, `lot_full`, `private_no_access`, `other`) plus free text.
- **Confirm/deny reuses Phase 9's pattern**: "Still blocked" / "It's open" writes to `pointEvents` (the
  `by_ref` index already exists from the Phase 6 corroboration work). N5b's *"never existed"* verdict
  (D65) applies here too — a mistaken alert should be retractable, not just decayable.
- **Decay is weather-insensitive.** Unlike ice hazards, **a locked gate does not thaw.** So: a plain TTL
  (~30 days) extended by confirmation, **not** the D56 weather multiplier. Worth calling out loudly,
  because the temptation to reuse `HAZARD_DECAY` wholesale will be strong and it would be wrong in a way
  that's hard to notice — a warm week would silently expire a road closure.
- **Season boundary (N5a):** hard-expire at season end. Road closures often span seasons, but an alert
  must never outlive the evidence for it. The map starts each winter clean and the community
  re-establishes what's actually true — which is also the cheapest possible re-survey.
- **Never hides the put-in** — same never-hide invariant as hazards. It annotates and de-prioritizes for
  directions; it does not make an access point disappear.
- **Moderators can pin an `official` alert** that doesn't decay — the analogue of an official put-in.

This gets the *value* of a seasonal access note with none of its rot, because freshness is enforced by
the people who benefit from it.

### C3 — What it does not do

**An active alert annotates; it does not suppress.** A blocked launch on a lake with three others must
not silence the lake in drive-time notifications. *(Open question 3 — recommend annotate-only,
consistent with the never-hide invariant.)*

---

## Workstream D — Photos on access points

Founder ✅ — a picture of the pull-off answers *"is this the right dirt road"* better than any prose.

**Attach to the access point, not to a report.** Which raises a lifecycle tension worth naming, because
it cuts against an N5a decision:

- Report and hazard photos **purge at season end** (D66) because they document **conditions**, which
  expire.
- An access-point photo documents **infrastructure**, which doesn't. A parking lot looks the same next
  November.

**So: a carve-out.** Access-point photos are excluded from the seasonal purge. They stay inside N3
deletion under the **D62 second amendment's redact-don't-erase** rule — a departing user's photo of a
parking lot is reassigned to anonymous, not destroyed. Erasing it would degrade the map for everyone else
to no privacy benefit; there is no personal information in a photograph of a gravel pull-off.

**Constraints:** cap per access point (~3) so it doesn't become a gallery; moderation rides the existing
`contentFlags`; the Phase 2 photo-upload pipeline and N3's orphan-GC cron apply unchanged.

---

## Out of scope

- **Hand-written access descriptions** of any kind (D70/P1) — Workstream C replaces the one case that
  mattered.
- **Food amenities** (founder call).
- **Renaming `putIns` to `accessPoints`** — additive only (A1), for blast-radius reasons.
- **Routing *along* the approach path** — we report `approachMeters` and a kind; we don't navigate the
  walk. That's a maps-app job.
- **Rivers** — still deferred (D4); shoreline-proximity association assumes a still-water polygon.

---

## Sequencing

1. **A1** — schema: `parkingAreas` + the `putIns` additions. Additive and migration-free.
2. **B1–B3** — the OSM pass. The bulk of the work, and independently testable against a single state's
   extract before it touches the corpus.
3. **A3 + the routing rule** — names and directions-target-parking. This is the first user-visible win
   and it is small once the data exists.
4. **C** — the alert lifecycle. New table, new decay, reuses Phase 9's confirm/deny UI.
5. **D** — photos, and the purge carve-out.

**Suggested split if this grows:** steps 1–3 (derived access data) are shippable without 4–5 (the
community layer), and the first three are where most of the value is.

---

## Open questions — all answered 2026-07-31

### 1 — Anyone who can post a report can post an access photo (D88)

> *"Anyone who can post reports or hazards can upload access point photos (unless we want to add another
> permissions toggle for this; I'm not convinced) and should be moderated after the fact."*

**No new toggle**, and the founder's lack of conviction is the right read. **D57** already built granular
posting permissions, and access photos sit *below* reports and hazards in risk, not beside them:

- **A bad ice report is a safety problem.** A bad photo of a parking lot is wrong, not dangerous.
- **The content is inherently low-stakes** — there is no personal information in a picture of a gravel
  pull-off, which is the same reasoning that put access photos under the D62 *redact-don't-erase* rule in
  Workstream D rather than under deletion.
- **A separate toggle would be a permission nobody ever sets differently**, and a permission that is
  always equal to another permission is a permission that will drift out of sync and confuse someone in a
  year.

> **D88 — Access-point photos ride D57's existing report/hazard posting permission. Post-hoc moderation
> via `contentFlags`, same as every other user-supplied photo.**

**Two inherited constraints do the actual protective work:** the ~3-per-access-point cap (Workstream D)
bounds any single point's abuse surface, and minors are read-only (Phase 3), so the population that can
upload is already the population we trust with reports.

### 2 — Trail routing: **OpenRouteService `foot-hiking`**, an account we already have (D87)

> *"Do you know of a service with an API we can call to get hiking trail info from point-to-point? … It
> could be 800m as the crow flies but a full kilometer of weaving trail … And elevation gain on the trail
> is going to affect people just as much as distance. We should definitely show a 'Hike-In' chip/badge."*

**Yes, and it's the API we're already paying no money for.** Phase 4's drive-time isochrones run on
[**OpenRouteService**](https://openrouteservice.org/). ORS exposes a **`foot-hiking`** routing profile
alongside the `driving-car` one we use, on the **same key, same account, same client code**. With
`elevation: true` the Directions response carries **`ascent` and `descent` in metres** for the route —
which is the second half of the founder's question, and it's a request parameter rather than a second
integration.

> **D87 — Approach distance is walked, not flown.**
> `approachMeters` is a routed `foot-hiking` distance where ORS can find a path, with straight-line as an
> explicitly-flagged fallback. `approachAscentM` rides along, because a kilometre with 120 m of climb in
> ski boots and a bag of gear is a different trip from a flat kilometre.

**Why ORS and not the alternatives**, briefly, so this isn't re-litigated:

| Option | Verdict |
|---|---|
| **ORS `foot-hiking`** | **Chosen.** Existing account/key/client; OSM-based, so it routes the same `highway=path`/`route=hiking` ways Workstream B is already extracting; returns ascent/descent. |
| GraphHopper | Comparable hiking profile and quality, but a second vendor, second key, second free-tier limit, for no capability we lack. |
| Valhalla (self-hosted) | Most control, and a server to run. Not for a field computed a few thousand times, once. |
| Mapbox Directions | `walking` profile only — tuned for sidewalks, not trails, and no hiking-specific weighting. |
| AllTrails / Gaia / Strava | Trail *content* products. No general point-to-point routing API on terms we could build on, and their trail geometry is licensed, not open. |

**The quota is a non-issue because of *when* we call it.** ORS's free tier is on the order of a couple of
thousand directions requests per day. `approachMeters` is computed **at ETL time, once per put-in**, and
cached on the row — not per view, not per user, not per notification. Even a full corpus pass is a
batched background job that can be rate-limited to ORS's per-minute ceiling and left to run. **Never call
this from a request path**, which is the one rule worth writing at the call site.

**Where it fails, and the fallback ladder:**

1. **Routed `foot-hiking` distance + ascent** — when ORS finds a path between parking and put-in.
2. **Straight-line, flagged** — when it can't. OSM's rural trail coverage is real but patchy (the same
   B4 caveat), and an unmapped herd path routes to nothing. Straight-line **under-reports**, so the
   flag matters: it is the difference between *"about 900 m on foot"* and *"at least 900 m on foot."*
3. **Nothing** — when there's no parking area to route from, which is most of the 116k.

**Confirm at build:** ORS returns ascent/descent only with `elevation: true`, and there are known
oddities in how ascent/descent resolve on out-and-back routes. We want the **one-way** figure from
parking → put-in, and the return trip's climb is the skater's problem to infer (it's the descent). Worth
one test asserting we don't accidentally report the round trip.

**The Hike-In chip ✅.** Founder ask, and it belongs on **all three surfaces**, because the whole point is
that nobody should discover this at the trailhead:

- **The map summary card** ([N6c Workstream E](./phase-N6c-expanded-lake-profiles.md#workstream-e--per-body-summary-cards-on-the-map)) — so it's visible while browsing, before anyone commits.
- **The lake drawer/detail** — with the number: *"park here, then about 1.1 km on foot, 90 m of climb."*
- **The feed card** — the Phase 4 drive-time filter row's neighbour. A skater filtering to "within 60
  minutes" is filtering on *drive* time, and a hike-in lake inside that band is not the trip they think
  they're being offered.

**The chip is derived, not entered** — `approachKind === 'hike_in'`, which A1 already derives from
`approachMeters` with an operator override. So it costs a component and a threshold, and it inherits the
override for the cases where a number lies.

*(Deliberately still out of scope: **routing the walk** — we report distance, climb and a kind; we don't
navigate it. That's a maps app's job, and a trail nav feature on an ice-conditions product would be a
different product.)*

### 3 — Annotate only ✅

> *"Annotate only."*

Confirmed as recommended in C3. An active access alert de-prioritizes a put-in for directions and shows
on it; it never suppresses the put-in, and it never suppresses the **body** from drive-time
notifications. Consistent with the never-hide invariant that hazards already hold, and for the same
reason: a lake with three launches and one blocked gate is still a lake worth telling someone about.

### 4 — The radius caps **inference**, not **association** (D72 amendment)

> *"There are a couple lakes that are hike-in only where you park at least a mile from the ice. So
> posters/authors should be able to associate parking with a lake at quite a distance… What are the
> ramifications here? Or are you thinking about putting a distance limit for parking when it's not a
> hike-in?"*

**The second guess is right, and the doc was ambiguous about it.** The ~250 m figure is a threshold for
the **automatic OSM pass** — how far the ETL will reach to guess that a lot serves a put-in with no human
saying so. It was never meant to constrain what a person can assert, and B2 didn't say so.

> **D72 amendment — the association radius governs inference only. An operator- or author-set parking
> association has no distance limit.**
> A mile-away trailhead lot is not an edge case to tolerate; it is the case this whole phase exists for.

**The ramifications, since that's what was actually asked** — there are four, and three are already
handled:

1. **Drive time must target the parking, not the put-in.** ✅ Already the design (A1's routing rule), and
   at a mile it stops being cosmetic: the Phase 4 isochrone bands are computed to a coordinate, and
   computing them to a shoreline point a car cannot reach makes the band **wrong**, not just imprecise.
   The routing rule fixes drive time and directions together.
2. **The drive-time band and the hike are different quantities and must not be summed.** A 55-minute
   drive plus a 25-minute walk is not an 80-minute drive, and quietly folding one into the other would
   corrupt the filter a skater is actually using. Show them separately; that's what the chip and the
   approach line are for.
3. **A distant lot may be nearer another lake — so the relationship is many-to-many.** ✅ Worth building
   for from the start rather than retrofitting: a trailhead serving three ponds is normal in the
   Northeast, and `parkingAreas` should not carry a single `waterBodyId` it will later have to grow out
   of. **This is a real change to A1's table sketch**, and it is cheap now and annoying later.
4. **A far-flung association is the one thing here a human can get wrong at no cost to themselves.**
   Mistyping a lot ten miles away sends someone to the wrong trailhead in the dark. Two mitigations, both
   already in the phase's vocabulary: **(a)** the `source` ladder means an operator value outranks OSM
   and is attributable; **(b)** above some distance the UI **requires** `approachKind = hike_in` rather
   than deriving it, so a long approach can't be entered silently — the author has to assert the thing
   the chip will tell everyone.

**So the constants become two, and only one of them is a cap:**

| Constant | Governs | Nature |
|---|---|---|
| `PARKING_INFER_RADIUS_M` (~250) | the **OSM pass's** willingness to guess | a tuning value — check against one state's output first |
| `HIKE_IN_THRESHOLD_M` | where `approachKind` derives to `hike_in`, and where the UI starts demanding it | a product line, not a geometry one |

**And the original question stands, unanswered by any of this:** whether ~250 m is right for the rural
Northeast. It is a guess, it will be falsified quickly by a dense state, and it should be eyeballed
against one state's real output before the full run. Now it's a guess with a bounded blast radius —
getting it wrong costs some missed or spurious *inferences*, never a rejected human assertion.
