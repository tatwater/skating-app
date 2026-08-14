# Phase N6d — Lake access points: parking, named put-ins, and access alerts

> **Status:** ✅ **COMPLETE on dev 2026-08-13** — all five workstreams, every UI surface, and the ETL
> run end to end (3,588 put-ins · 11,375 parking areas · 4,209 bodies with access; routing 99.4%).
> Unpushed; prod deferred as every phase since 2.5. **`backfillCells` ran 2026-08-14** — 24,961 bodies
> re-scored in 84 batches, closing the pass N6c had held since 2026-08-02. —
> scoped 2026-07-30, kickoff re-read against the post-N7 codebase 2026-08-10. Founder ask, same day as
> the scoping. **Pre-PR review 2026-08-14** — four defects fixed and a red build made green; suites now
> core 1,839 · convex 1,240 · web 301 · mobile 95 · etl 408, with `lint` and `check-types` clean.
> See *§What the build found*, *§What the first real run found*, *§The 250 m radius, eyeballed*,
> *§What the load found*, *§The run, completed* and *§What the pre-PR review found*.
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
>
> ### ⚠ This doc was written before N7, and three of its premises moved
>
> Scoped 2026-07-30; [N7](./phase-N7-unified-corpus.md) landed 2026-08-07 and rebuilt the corpus under
> it. See *§What the kickoff found in the plan*, which is the first section below — the corrections are
> **not** cosmetic: one of them changes where the join runs.
>
> ### Founder calls, 2026-08-10 — four, taken at kickoff
>
> 1. **All five workstreams ship in one phase.** The doc's own *"suggested split"* (1–3 without 4–5) was
>    offered and declined. So the access alert lifecycle and the photo carve-out are in scope here, not
>    deferred to an N6d-2.
> 2. **Directions re-target to parking; drive-time bands do not.** See correction 6.
> 3. **An `osm` put-in scores as `derived` (+0.06) in D2's richness ladder.** See correction 5.
> 4. **The approach thresholds:** `drive_up` ≤ 150 m · `short_walk` ≤ 800 m · `hike_in` > 800 m, and the
>    UI **demands** an explicit `hike_in` assertion above **1,600 m**. See correction 7.

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

## What the kickoff found in the plan — 2026-08-10

Same discipline N1/N2/N6a applied to their own entries: every load-bearing claim re-checked against a
file before a line was written. Seven corrections. The third is the one that changes the build.

**1. "116,070 bodies" is now ~25,197, and the correction is good news.** `regionStats` sums to
**25,011** across the five states (NY 9,420 · ME 5,507 · MA 5,681 · NH 3,069 · VT 1,334). This doc leans
on the old figure four times — *"what makes named access points a 116k feature rather than a 36-lake
one"*, *"nothing on most of the 116k"*. But N7 did not merely shrink the corpus, it **changed its
composition**: one admission floor now applies once to the merged body (≥ 5 acres, or ≥ 1 acre if named
— D91), so the ~90k sub-acre ponds B4's pessimism was calibrated against are no longer rows at all. The
surviving population is exactly the set OSM is most likely to have named a slipway or a lot for. B4's
*"expect solid results on well-known bodies and nothing on most"* should be re-read as a much narrower
gap than it was written to describe.

**2. The archive premise held, and got stronger.** *"No new source, no new download, no new account"* is
still true, and `scripts/etl/.raw/<state>/` now holds **pinned, md5-verified, dated** extracts
(`vermont-260731.osm.pbf` and its four siblings) with manifests that `scripts/run-log`'s
`provenance.ts` replays into an `/admin/imports` run row. So this pass's provenance is free and its
inputs are byte-identical to the ones behind the current corpus.

**3. ⚠ B2's association rule cannot be implemented as written — the join has to run server-side.**
*"Put-in candidates within ~30 m of a body's polygon boundary attach to that body"* reads as something
the transform does. It can't: the transform has no access to our polygons, and post-N7 the merge output
is **not** the loaded corpus (bodies are pruned, deduped, re-keyed and retired after it). This is
precisely what [N6a](./phase-N6a-lake-depth.md) discovered mid-build and it has the same fix —
`waterBodies.matchAndImportDepths` does the geometric join in Convex against the N1 cell index, and
`matchAndImportAccessPoints` will mirror it. The same free benefit comes with it: an access point and
the app's own *"you're at Lake X"* resolution agree by construction, because both go through
`listedBodiesNearCoord`. `distanceToPolygonMeters` and `pointNearPolygon` already exist in
`@skating/core`.

**The half that *is* local, and this is what keeps the ETL's four-stage shape.** Pairing a parking lot
to a put-in candidate is **OSM-to-OSM** — both are features in the same extract — so B2's ~250 m
inference, and the ORS `foot-hiking` leg that rides on it, need no corpus and happen in the transform.
Only *which body this serves* needs the server. Without that split the pipeline would have to
load → query back the unrouted pairs → route → patch, which is a shape none of the other three ETLs
has.

**4. The second `osmium` pass needs geometry types the first one throws away.**
`scripts/etl/src/extract.ts` centralises the argv — deliberately, after five copies drifted — and its
`osmExportArgs` exports `--geometry-types=polygon`. N6d's features are **nodes** (toilets, many
slipways), **polygons** (parking) and **lines** (trails, slipway ways). That is a second export
configuration, and by that file's own docstring it belongs *in* it rather than beside it.

**5. `osm` as a `putIns` rung collides with D2's richness ladder, and the collision is load-bearing.**
`PUTIN_SOURCES` is `['derived', 'official']` and `staticRichness` has exactly two matching terms —
derived **+0.06**, official **+0.12**, official superseding rather than stacking. An OSM slipway is
stored like an `official` row and approximate like a `derived` one, so it needed a call rather than a
default. **Founder call: it scores as `derived`.** An OSM feature is *data*; `official` still means an
operator vouched for access, which is what makes it *"the strongest static signal we have"*.

This matters more than a constant usually would, because **`backfillCells` — the single full-corpus
re-score N6c has been holding since 2026-08-02 — is gated on this phase precisely for these two
terms.** They have never fired: dev carries **0 `putIns` rows**, 1 report and 2 hazards. So the OSM pass
is not merely the best put-in producer, it is in practice the *only* one, and this phase is that held
pass's actual finish line.

**6. Open question 4's first ramification is right and costlier than it reads.** *"Drive time must
target the parking, not the put-in"* is true — but `bandForCoord` classifies on **`body.centroid`**, at
two call sites: `notifications.ts:175` (the fan-out) and `reports.ts:795` (the feed filter). Re-targeting
means a per-body access-coord lookup inside both, one of which runs per report in a feed page. That is a
read-cost decision, not a call-site tweak.

> **Founder call, 2026-08-10: the directions link re-targets; the bands stay on `body.centroid`.**
> This fixes the bug the phase exists for — a maps app handed a destination it cannot route to — with
> no change to notification fan-out or feed filtering. The residue is stated rather than hidden: a
> mile-away trailhead still bands against the water rather than the car, so its 30/60/90 classification
> is slightly optimistic. Revisit with a denormalised access coord if that ever bites.

**7. Three constants this doc names had no numbers, and one of them is a product line.**
`HIKE_IN_THRESHOLD_M` is called *"a product line, not a geometry one"* and left blank; the
`drive_up`/`short_walk` boundary is never named at all; and the *"above some distance the UI **requires**
`approachKind = hike_in`"* rule has no distance.

> **Founder call, 2026-08-10:** `drive_up` ≤ **150 m** · `short_walk` ≤ **800 m** · `hike_in` >
> **800 m**, and the UI demands an explicit assertion above **1,600 m**. 800 m is roughly ten minutes in
> boots carrying gear — where it stops being *park and go*. 1,600 m is the founder's own example of the
> lakes this phase exists for, so an association at that range has to be asserted rather than derived.

**8. Two things the plan says ride existing machinery, and one of them doesn't.**

- **Photos:** ⚠ `lib/photoOrphans.referencedPhotoIds` decides "referenced" by scanning **only the
  uploader's own reports and hazards**, and states that as its soundness argument: *"the only rows that
  can ever reference a photo are its uploader's own reports and hazards."* Workstream D breaks that
  invariant, so an access-point photo becomes an orphan and is **deleted after the 30-day grace** —
  silently, by a cron, a month later. `photoReconcile` has the same shape. Extending both is
  unbudgeted work inside D, and it is the one finding here that would have shipped as data loss.
- **Flags:** `FLAG_TARGET_TYPES` is `['report','comment','photo','user','hazard']` and
  `MODERATION_TARGET_TYPES` likewise. Photos ride it as C2 claims; an access **alert** has no slot yet.

**9. Extracting trails may be redundant, and dropping them removes a geometry class.** B1 extracts
`highway=path|footway|track` + `route=hiking` for a `trail` amenity. But ORS `foot-hiking` (D87) routes
over *exactly those ways* — so **"a route was found" is the trail signal**, already paid for, with no
line geometry in the extract at all. The only residue is a trail beside a put-in that has no parking to
route from, which is a case with no consumer in this phase. Trails are therefore derived from the
routing result rather than extracted, and the line-geometry export goes away with them.

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

This is what makes the phase work at corpus scale rather than for the 36 lakes someone would hand-type.
*(Written as "116k scale"; the corpus is ~25.2k post-N7 — see correction 1, which makes the argument
stronger rather than weaker.)*

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
| ~~`highway=path\|footway\|track`, `route=hiking`~~ | ~~`trail` amenity + approach path~~ — **dropped, correction 9**: ORS routes over these ways already, so a successful `foot-hiking` leg *is* the trail signal. Removes the line-geometry export entirely. |
| `natural=beach`, `leisure=fishing`, `man_made=pier` | put-in candidate |

### B2 — Association rules

- Put-in candidates within **~30 m** of a body's polygon boundary attach to that body. **This test runs
  server-side** (correction 3), in `matchAndImportAccessPoints`, against the N1 cell index — the
  transform has no polygons to measure against.
- Parking within **~250 m** (`PARKING_INFER_RADIUS_M`) of a put-in candidate attaches to it. **This one
  runs in the transform**, because it is an OSM-to-OSM question that needs no corpus — which is what
  lets the ORS leg be computed locally in the same stage. **It bounds the ETL's guessing only** — a
  human can associate parking at any distance (D72 amendment, open question 4).
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
well-known bodies and nothing on most of the corpus.

> **Re-read against N7 (correction 1).** This was written against 116,070 bodies, ~90k of which were
> under an acre and had no chance of a mapped lot. The post-N7 corpus is ~25.2k at a ≥ 5 acre floor
> (≥ 1 acre if named), so the denominator this pessimism divides by is four times smaller and made of
> exactly the bodies OSM bothers to map access for. **The rate will be better than this paragraph
> expects — and it is still a rate to measure rather than assume.** Report `matched / inScope` and name
> what the pass walked past (the N7-3 *"denominators lie by default"* rule, D137).

That is fine. It is strictly more than the zero we have now — dev carries **0 put-in rows today** — it
costs one ETL pass over a file we already download, and the gaps are exactly where Workstream C's
community layer and operator edits fill in.
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
- ⚠ **Flagging an alert needs a new target type** (correction 8). `FLAG_TARGET_TYPES` and
  `MODERATION_TARGET_TYPES` cover `report · comment · photo · user · hazard`. Access **photos** ride
  `photo` as this section assumes; an access **alert** has no slot, so *"reuses machinery we already
  built"* is true of the confirm/deny half and one enum short of true for the moderation half.

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
`contentFlags`; the Phase 2 photo-upload pipeline applies unchanged.

> ⚠ **"N3's orphan-GC cron applies unchanged" is false, and it is this phase's one data-loss finding**
> (correction 8). `lib/photoOrphans.referencedPhotoIds` derives "referenced" by scanning **only the
> uploader's own reports and hazards** — and that is not an implementation detail, it is the function's
> stated soundness argument for being allowed to *delete*. An access-point photo satisfies none of it,
> so the sweep would classify it as abandoned and destroy it once past `PHOTO_ORPHAN_GRACE_MS` (30
> days). Silently, by a cron, a month after upload. `photoReconcile` — the escalation path for prolific
> uploaders — has the same shape and needs the same extension. Both are in scope here.

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

> **Offered and declined at kickoff (founder call, 2026-08-10): all five ship together.** Recorded
> because the split remains the correct fallback if the phase stalls — the finish line that matters to
> everything downstream is step 2, since that is what puts `putIns` rows in the corpus and releases
> N6c's held `backfillCells` re-score (correction 5).

---

## What the build found — 2026-08-11

*Five things the plan did not anticipate. Two are corrections to the plan, two are decisions it left
implicit, and one is the shape of an unfinished edge.*

**1. `parkingAreas.waterBodyIds` could not be an array, and the reason is the read.** A1's field
sketch stores the association on the parking row. That records the fact and cannot answer what every
read actually asks — *"what parking serves this lake?"* — because Convex has no array-contains index,
so a body-side lookup is a full table scan on a table that grows with the corpus. It is the
`listInViewport` failure in a new coat. So the association is a **`parkingAreaBodies` join table**
indexed both directions, and the array is deliberately not kept beside it: two copies of one fact is
what N7 spent a phase undoing. Its `inferred` column is the D72 amendment written into the data.

**2. `photoIds` on the access point could not work either, and that one would have shipped as data
loss.** Covered in the kickoff as a `photoOrphans` gap; the build found it was a *schema* problem
rather than a scan problem. `referencedPhotoIds` derives "may this be deleted" by scanning **the
uploader's own reports and hazards**, and that is sound because `assertOwnedPhotos` makes "scan by
author" and "find every referrer" the same query. An access point breaks the identity — the put-in is
created by the ETL, the photo by a passing skater — so a `photoIds` array would have left every access
photo an orphan by construction, swept thirty days later by a cron. `accessPhotos` carries its own
`uploaderId`, which restores the property instead of adding an exception to it. **Both** destructive
paths needed it: `photoReconcile` gained an `access` phase, and it is the only clearing phase besides
`hazards` that runs in *both* modes — which is the D66 carve-out expressed as a list entry.

**3. `approachKind` is not stored, and `official` had to become a status.** Two schema calls the plan
left implicit and the build had to make. The kind is a pure function of the distance, so persisting it
would be a cached derivation that goes stale on the next re-route — only the *override* is stored,
because a human disagreeing with a measurement is the part no function can recompute. And the founder's
"a pin never expires" exemption forced `official` to be a status rather than a flag: Convex indexes on
optional fields are not sparse, so an absent `expiresAt` sorts **first** and a bare `lte(now)` sweep
would have expired exactly the rows that are exempt from expiry. A distinct status puts them in a
different equality prefix, so the sweep cannot reach them at all.

**4. The `trail` amenity comes from the router, not the extract** — the kickoff's correction 9, and it
held up in the build. Dropping `highway=path` / `route=hiking` removed the only line geometry this
pipeline would have had to handle, and a routed `foot-hiking` leg longer than 150 m stamps the amenity.
A drive-up ramp routes over the car park's own service road, which is why the length test is there.

**5. What is built and what is not.** The data path is complete end to end — the second osmium pass,
the OSM-to-OSM pairing, the ORS leg, the server-side join, both loaders, the alert lifecycle with its
cron, the photo model, the operator write path, and the D2 richness rung that finally releases
`backfillCells`. **The ETL has not been run**, so no access data is loaded and none of it has been seen
against real output — including the `PARKING_INFER_RADIUS_M` eyeballing pass the plan asks for.

**All four remaining UI surfaces landed the same day** (founder ask): the Hike-In chip on the map
summary card and the feed card, access photos on both clients, parking + approach editing in the N2
lake editor, and alert posting on mobile.

The chip's two card surfaces read a new **`accessKind` column on `waterBodies`**, denormalized by the
join — `listInViewport` already returns whole body docs and the feed already caches the body per
query, so neither costs a read. It is deliberately *not* inside `summary`: that object is
activity-scoped and absent on a body with no recent reports, so a hike-in pond nobody has skated would
carry no chip — exactly the lake the warning is for. `bodyAccessKind` takes the **easiest** launch,
not the hardest, or a lake with one drive-up ramp and one remote launch would wear a chip it doesn't
deserve.

---

## What the first real run found — 2026-08-11

*Three corrections, all from running the thing rather than reading it. The first is the eyeballing
pass B2 asked for, and it earned its keep on the first state.*

**1. `amenity=parking` is one of OSM's most common tags, and the plan had no gate for it.** Vermont
alone yields **4,656 parking areas, 202 of which pair with a launch**; across five states it is
**95,294 lots, 92,384 unpaired**. The rest are supermarkets, schools and — literally, from the
artifact — *"East Montpelier Fire Department, Incorporated"* and *"Camels Hump Skiers' Association"*.
Loading them would put a directions target on every downtown lot in every lakeside town.

The gate: a lot is stored when a put-in claimed it **or** a corpus body is within
`PARKING_INFER_RADIUS_M`; neither ⇒ `notNearWater`. Worth recording *why the original rule was wrong*
rather than only that it was — it stored every lot, justified by the mile-away trailhead, but that
case is **paired**, so the justification never covered the lots it was letting through. Pairing is a
human-mapped relationship between a lot and a launch and outranks any proximity guess, which is what
lets the gate be strict without losing the case the phase exists for.

**2. The ORS rate limit was wrong by 2×, and the run measured it exactly.** The free tier caps
directions at **40 per minute**; a 700 ms gap is ~85/minute. Exactly **40 legs succeeded and the next
1,963 came back `429`**. Now 1,600 ms with a 20 s backoff and three retries — 127 consecutive legs
routed with zero rejections after the change.

**3. ⚠ The worse half: a rate limit was being cached as an answer.** The response cache exists so a
crash 3,000 requests in doesn't re-spend the first 2,999 — but it stored the *fallback* too. A
straight-line result caused by a `429` is a fact about our request rate, not about the lake, and
storing it made the damage permanent: the next run reads `routed: false`, skips the request, and that
leg is never routed again however patient anyone is. **2,173 legs were poisoned** before this was
caught, and the cache had to be purged of them.

A `404` is genuinely different — ORS has no path between those two points, and that answer is stable —
so it still caches. `cacheable` is now an explicit part of the routing result rather than an
inference, and `retryableFallbacks` is counted apart from `fellBackToStraightLine` so the summary says
whether re-running tomorrow buys anything.

**On the daily cap.** ORS allows ~2,000 directions/day and the corpus has **4,980 paired put-ins**, so
a full routing pass spans two to three days. That needs no decision: the cache resumes, and every
unrouted leg is stored straight-line *flagged*, so the drawer says *"at least 900 m on foot"* until
the number improves.

## The 250 m radius, eyeballed — 2026-08-12

*B2 asks for this explicitly and it had only been checked in aggregate. Two measurements, and the
second dissolves a worry rather than answering it.*

### Pairing rate by state, at 250 m

| | launches | paired with a lot | pair rate | lots | unpaired |
|---|---:|---:|---:|---:|---:|
| VT | 423 | 238 | **56%** | 4,692 | 95% |
| NH | 1,256 | 354 | **28%** | 7,824 | 95% |
| ME | 2,587 | 924 | 36% | 9,950 | 91% |
| MA | 4,772 | 1,731 | 36% | 28,174 | 94% |
| NY | 4,470 | 1,754 | 39% | 46,879 | 96% |

**The radius is not obviously wrong in either direction**, which is the finding. A dense state was
supposed to falsify it by over-pairing; MA and NY sit at 36–39%, mid-pack, and the outlier is NH at
28% — an *under*-pairing state, which is what you would expect where launches are mapped and their
lots are not. **VT's 56% is the ceiling of what OSM supports**, not evidence the radius is generous.

So the number stays at 250 m. It was a guess, it remains a guess, and it is now a guess with five
states of evidence that it is not badly placed.

### The mile-in trailhead: geometry cannot find it, and that is D72's answer

The founder's question, asked of the water-relevance gate: *"how can we be sure we capture parking at
the end of a hiking trail?"*

Measured, over 3,000 sampled unpaired lots, as distance to the nearest **mapped launch** (a launch is
on water by definition, so this is a direct proxy for "is this lot about a lake"):

| distance to nearest launch | share | ≈ corpus-wide |
|---|---:|---:|
| 0–250 m | 2.7% | 2,525 |
| 250–500 m | 6.5% | 6,035 |
| 500 m–1 km | 12.9% | 11,886 |
| 1–1.6 km | 14.8% | 13,672 |
| 1.6–3 km | 25.7% | 23,711 |
| 3–8 km | 29.7% | 27,438 |

**There is no gap.** The curve rises monotonically to 3–8 km, which is the signature of parking spread
over a landscape where lakes are everywhere — not of a distinct trailhead population sitting at a
characteristic distance. Widening the radius to a mile would admit ~34,000 lots, overwhelmingly in
dense MA and NY, to catch a handful of genuine trailheads.

**And the hole is upstream of the gate.** `pairAccessFeatures` caps at the same 250 m, so a mile-in
trailhead never pairs in the first place — the water-relevance gate never gets a say. The ETL cannot
discover that case *at all*, by any radius.

Which is exactly what **D72's amendment already decided**: *"the association radius governs inference
only. An operator- or author-set parking association has no distance limit."* The mile-in trailhead is
the **human** path — `setOfficialParking`, which performs no distance check — and this measurement is
the evidence that it has to be, rather than a limitation we settled for.

> **The one principled way to widen it is the data correction 9 dropped.** A lot at the end of a
> `highway=path` that leads to a lake *is* a trailhead, and that is a **signal** rather than a radius.
> Re-extracting trails and pairing through path connectivity would find the case geometry can't. It
> wants line geometry and a connectivity walk, so it is a fast-follow rather than this phase — but it
> is the right shape, and it should not be confused with "turn the radius up".

### ⚖ Sized 2026-08-14, and the yield is smaller than that paragraph implies

Measured rather than estimated, because the paragraph above reads like an unlock and the data says
otherwise.

**The blocker is de-risked.** OSM way connectivity **survives the GeoJSON export**: in Vermont's 40,840
trail ways, **29% of endpoints are shared by two or more ways as byte-identical coordinates**. So the
graph can be built by hashing endpoint coordinates — no node-ref extraction, no pyosmium, no custom
libosmium binding. That was the piece that could have made this a week.

**But the yield is capped by OSM's own trail coverage, and it is low:**

| | VT |
|---|---:|
| unpaired put-ins | 416 |
| …with a trail within 50 m | **27 (6%)** |
| unpaired lots | 8,724 |
| …with a trail within 50 m | 2,731 (31%) |

A connection needs **both** ends on a trail, so **the launch side is the ceiling and it is 6%**.
Extrapolated, that is on the order of **150–300 new pairings across five states** — against 1,351
already found, so perhaps +11–22%, and only for lots that a walk actually connects.

**Cost:** ~600–900k line geometries across five states (VT alone is 40,840 ways / 642k vertices, so
memory wants streaming rather than a naïve load), a coordinate-hashed connectivity graph, a
budget-bounded BFS with property tests for cycles and disconnection, plus a handful of extra ORS legs.
Comparable in size to Workstream B1/B2 — call it a small phase, not an afternoon.

**Recommendation: don't, yet.** The case it targets is already served twice over — `setOfficialParking`
takes a human's association at any distance (D72 amendment), and 840 lots already survived the gate on
the pairing bypass. If the goal is more access coverage, the **9,737 put-in candidates with no corpus
body** are a far larger population to understand first.

## What the load found — 2026-08-13

**The gate rejects 83%, and the `paired` bypass rescues the case the founder asked about.** Over the
first 38,256 lots loaded:

| outcome | count | share |
|---|---:|---:|
| landed (created or updated) | 6,351 | 16% |
| `notNearWater` — refused by the gate | 31,905 | **83%** |
| **paired, but no body within 250 m** | **840** | — |

That last row is the answer to *"how can we be sure we capture parking at the end of a hiking trail?"*
in data rather than argument: **840 lots paired with a launch while sitting beyond every body's
inference radius.** A pure proximity gate would have dropped every one of them. They survive because
pairing bypasses the distance test entirely — which is the D72 amendment working exactly as written.

The 83% also corrects my own sample: an early 200-lot slice suggested 57%, but that slice was the head
of the file and therefore Vermont, which is lake-dense and unrepresentative. **The real rejection rate
is higher, which means the gate is doing more work than it looked like it was** — and that the corpus
would have been four-fifths noise without it.

### ORS: the routing pass stalled at 79%, and the quota is not on the schedule we assumed

3,974 of 4,980 paired legs carry a routed approach. The remaining **980 are stored straight-line and
flagged**, so they render *"at least 900 m on foot"* rather than *"about"* — the D87 fallback doing its
job rather than a gap.

Retried across three days and two times of day; `{"error": "Quota exceeded"}` on the **first** request
each time after the first two days' 2,000 each. The 403 carries no rate-limit headers, so the reset
window is not discoverable from the API — it needs the ORS dashboard. Two things make this cost
nothing to leave open:

- the route cache is permanent, and the 980 fallbacks were deliberately left **uncached**, so a
  re-run picks up exactly there;
- the loader upserts on OSM id, so re-running the transform and the put-ins lane later fills the
  approaches in place with no other consequence.

**⚠ Phase 4 is unaffected, and it was worth checking**: D87 shares the key, but ORS quotas are
**per-service** — `isochrones/driving-car` returned HTTP 200 with a real polygon while directions was
refusing. The ETL cannot starve the app's drive-time bands.

## The run, completed — 2026-08-13

**The corpus went from zero access data to knowing how you get onto 4,209 lakes** (16.7% of ~25,197).

| | |
|---|---:|
| put-ins loaded | **3,588** (all `osm`; 783 carry an OSM name) |
| …with a parking area | 1,351 |
| …with a **routed** approach + ascent | **1,347** |
| …straight-line, flagged | 7 |
| parking areas | **11,375** |
| lot↔body associations | 11,325 |
| bodies with a put-in | 1,415 |
| bodies with parking | 3,655 |
| **bodies with any access** | **4,209** |

**Routing finished at 99.4%** — 4,949 of 4,980 paired legs, with `retryableFallbacks: 0`. The 31
remaining fallbacks are genuine ORS "no path" answers, not quota casualties, so they are the permanent
honest result rather than something to re-run.

**What the pass walked past, named rather than buried in a ratio** (D137): **9,737 put-in candidates
had no corpus body within 30 m.** That is a scope boundary, not a fault — coastal slipways, river
landings, and ponds below the N7 admission floor. And **92,384 lots were refused by the
water-relevance gate**, which is the finding that gate exists for.

### The two things the load itself taught us

**1. Legitimate lakes exceed the read cap.** 160 lots on Lake Champlain, 97 on Winnipesaukee, 64 on
Seneca — all real for lakes that size. The cap docstring had claimed no real body would reach 64; it
was wrong within two hours. The cap stays (it is a read bound), but `accessForBody` now resolves the
lots its put-ins *reference* by id before filling the rest from the index — otherwise the directions
target on our four biggest lakes depended on index order, silently reinstating the pre-N6d bug on the
lakes that matter most.

**2. The 250 m radius over-includes in towns, and the shape of it is now visible.** An 11-acre urban
pond collected 56 lots; Lake Quinsigamond (603 acres, in Worcester) collected 97. Only **4 bodies
exceed 64 lots and 33 exceed 30**, so this is a narrow tail rather than a systemic problem — but it is
the direction to look if the radius is ever revisited, and it is *not* the same population as
Champlain's legitimate 160.

## ⚠ The load disabled the deployment, and the cause is one parameter — 2026-08-14

**`accessPoints.matchAndImportParking` spent 104.95 GB of database I/O** — twice the next-largest
consumer in the project's history (`matchBathymetryLakes`, 51 GB) and 4.5× the depth join. It exhausted
the Convex free plan and **disabled the dev deployment**. Restored by raising the spending cap.

**It is 1.1 MB of document reads per lot**, and the reason is a single default:

`listedBodiesNearCoord` built its candidate box from a fixed `NEAR_COORD_MARGIN_DEG = 0.01` — about
**1,113 m** — because that is what coord→lake resolution needs. Every caller inherited it:

| gate | radius it tests | box it read | wasted area |
|---|---:|---:|---:|
| parking | 250 m | 1,113 m | **20×** |
| put-in | 30 m | 1,113 m | **1,377×** |

**Convex has no projection**, so a candidate read is a *whole document* — `polygon` included. Lake
Champlain's ~300 KB outline was therefore re-read for every one of the lots within a kilometre of it,
95,294 times over. And **83% of that work was discarded** by the water-relevance gate, which runs
*after* the lookup.

**The fix:** `listedBodiesNearCoord` takes an optional `marginMeters`, converted per-axis (longitude
degrees shrink with latitude — a symmetric degree margin is ~40% wider in latitude than longitude at
44°N). Tightening is provably safe: `bodiesCoveringBox` matches on **bbox**, and a polygon within *r*
of a point always has a bbox within *r* of it. The default is unchanged, so resolution-grade callers
keep their net; only callers that know their radius opt in.

### What I should have seen, and the honest reason I didn't

Two days earlier I noticed the gate rejects most lots *after* paying for the lookup, said out loud that
*"the gate saves storage, not time"*, and filed it as a wall-clock nuisance. It was a **quota**
problem. I evaluated a bbox pre-filter purely on wall-clock — the axis it loses on — and talked us out
of the thing that would have avoided this, because a local pre-filter never touches Convex at all.

The founder's instinct to *"just get everything and then make decisions"* was also the more expensive
half of this, and the measurement that answered it (no gap between trailhead and supermarket) is what
justified the gate. Both halves were right; the cost model was the part nobody priced.

### The same shape elsewhere, worth checking before the next campaign

`matchBathymetryLakes` (51 GB) and `coveringBodyForPoints` (21 GB) are the same pattern — a per-record
spatial lookup on the wide default net. Neither is fixed here, and neither is urgent, but they are the
next two candidates if I/O ever binds again.

## What the pre-PR review found — 2026-08-14

*Four defects and a red build, found by reading the branch end to end before pushing it. The pattern
in all four is the same and worth naming: **N6d added new surfaces to systems that enumerate their
inputs**, and an enumeration nobody updated fails silently rather than loudly.*

**0. CI was red, and the type error was inside a test.** `pnpm check-types` failed on
`feed.test.ts`'s Hike-In fixture — a `FeedAuthor` built from the wrong fields — and `pnpm lint`
failed with 15 diagnostics, eleven of them unformatted N6d files. Worth recording because vitest does
not typecheck: **every one of the 1,837 tests passed against a build that could not compile**, so
"suites green" was true and meaningless. Run `lint` and `check-types` before believing a phase is
done.

**1. A flagged access alert was a hole in the moderator queue.** The kickoff's correction 8 was
implemented exactly as far as it was written — `FLAG_TARGET_TYPES` gained `accessAlert` and
`contentFlags` learned its table — so *filing* worked. But `moderation.resolveFlagTarget` is a switch
with a `default: notFound`, and nothing added the case, so every access-alert flag rendered as
**"(deleted)"** with no author, no note and `exists: false`. A flag a moderator cannot read is a flag
nobody can action.

Fixing the read half exposed the write half: an alert carries no `moderationStatus`, so
`setModerationStatus` cannot touch it and the queue's takedown buttons are gated on target type. The
verb it actually wants is **retraction** — a bogus "gate locked" was never true, which is D65's
verdict — so the queue now offers that instead of a hide it cannot perform.

**2. `waterBodies.accessKind` had two writers and only one of them wrote.** `recomputeAccessKind` ran
in `matchAndImportPutIns` and nowhere else, so `setPutInAccess` — every operator edit — left the
denormalized chip describing the previous state. The direction of the failure is the bad one: a
moderator asserting `hike_in` on a mile-away trailhead left the lake wearing **no warning at all**,
which is the exact trip this phase exists to prevent somebody making. Nothing would have looked
wrong; the `putIns` row was correct and only the two browse surfaces lied. `clearParking` was the
mirror, leaving a `drive_up` chip outliving the measurement it came from.

**3. Three user-authored tables were invisible to the N3 account lifecycle.** `accessAlerts`,
`accessAlertVotes` and `accessPhotos` appeared in no deletion or export path. Two consequences:

- `lib/contentPurge`'s `CATEGORIES` did not include alerts, so a departed skater's `note` — free text
  *they typed*, on the same side of the D62 seam as `reports.notes` and `contentFlags.note` — was
  never redacted. Now a category of its own: the row survives (somebody did find that gate locked)
  and the sentence comes off.
- `dataExport.collect` enumerates eleven tables and named none of them, so a user's own access
  contributions were missing from their export. **An export is only ever wrong by omission, and an
  omission is indistinguishable from a person who never used the feature** — nothing errors, nothing
  looks empty, and "everything about you" quietly stops being true one phase at a time.

**4. `ACCESS_ALERT_STATUSES` carried a `hidden` nothing writes.** Removed. The takedown a moderator
performs is retraction (finding 1), so a status with no writer was an invitation to build against a
hide path that does not exist. Safe to narrow: no row has ever held it.

### The test-coverage shape, and what the second pass closed

The backend was thoroughly covered from the start — ~2,800 lines across `accessPoints`,
`accessAlerts`, `access`, `accessAlert` and `accessTransform`. **Every client surface the phase added
had nothing**, which breaks this repo's own convention: each Phase 9 hazard component carries a
`.test.tsx`. And two of the gaps were in files that already existed and already tested the exact
function — `waterMap.test.ts` had fourteen `summaryCardText` cases and no Hike-in one.

Closed in the follow-up commit:

- **The Hike-In chip on all three surfaces it was promised on** — `summaryCardText` (map card),
  `FeedCard` (feed), `AccessSectionView` (drawer). The rule pinned is *only `hike_in` prints*: a chip
  that appears on every lake stops being a warning.
- **The `osm` rung reaching the map layer**, both clients. This is the one that had already failed
  once — an OSM launch is neither `official` nor `derived`, so a layer styling those two drew nothing
  for 3,588 imported launches.
- **The D66 carve-out, in both destructive paths.** `expireDepartedPhotos` and `photoReconcile`'s
  `access` phase — the fix this doc calls the phase's one data-loss finding — were asserted only by
  the code implementing them. The `access` phase matters more than it looks: it is the *escalation*
  path, so a prolific contributor's access photos take it rather than the one-shot scan.
- **The never-hide invariant, as a render test.** `AccessSection` got the repo's view/data split
  (the `HazardListView` pattern) so a blocked launch staying on screen, named and routable, is now
  something a refactor cannot quietly break.

**Still uncovered, named rather than implied:** the three remaining components — `AccessPhotos` (both
clients) and mobile's `AccessSection` — plus the lake editor's `AccessTool` and the alert-posting
form's submit path. All would want the same view/data split first.

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

> **They became four, and only one is still a cap (founder call, 2026-08-10 — correction 7).**
> `DRIVE_UP_MAX_M` = **150**, `SHORT_WALK_MAX_M` = **800** (so `hike_in` is anything beyond),
> `HIKE_IN_ASSERT_M` = **1,600** — above which the UI demands the assertion rather than deriving it —
> and `PARKING_INFER_RADIUS_M` = **250**, the only one of the four that caps anything. The first three
> are product lines and move by founder call; the fourth is a guess and moves by eyeballing a state.

**And the original question stands, unanswered by any of this:** whether ~250 m is right for the rural
Northeast. It is a guess, it will be falsified quickly by a dense state, and it should be eyeballed
against one state's real output before the full run. Now it's a guess with a bounded blast radius —
getting it wrong costs some missed or spurious *inferences*, never a rejected human assertion.
