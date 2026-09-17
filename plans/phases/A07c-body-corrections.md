# A07c — Water body corrections: the skater says "this is wrong", and a moderator fixes it

> **Status:** ⚪ **Scoped 2026-09-16.** Not built. First phase named under the new scheme
> ([`README.md`](../README.md#phase-names)); the era stays `A` because this is the last of the
> corpus-knowing work, not the first of launch readiness. Branch `phase-a07c-body-corrections`,
> commit scope `feat(a07c):`.
> **Depends on:** A07b's standing and request path (merged 2026-09-16, PRs #61 #63) — three of the
> categories first scoped here are *requests*, not corrections, and are already built there.
> A09's put-in suppression (`lib/putInSuppression`, PR #58) — a hide is a coordinate row that outlives
> re-derivation, which is the durable-override shape every put-in correction needs.
> **Reuses:** `contentFlags` and everything A06f hung on it — the per-(flagger, target) dedup that
> *is* the corroboration count, the `/admin/flags` lanes, `closeFlag` and the A08
> `content_flag_resolved` notification, `lib/contentPurge` note redaction, the 07-2 disposition
> rollups. `nameFields` (A07a) as the precedent for an operator override that survives a campaign.
> `mergeBodyInto` and `repointSubAreasOnMerge` (D36, A02) for everything a union has to carry.
> **Decisions:** D180–D183, proposed here; they move to
> [`01-decisions.md`](../01-decisions.md) when the founder rules.
> **Not this phase:** anything the request path already answers (*admit · activate · restore ·
> contest access · takedown*), transient access problems (`accessAlerts`, D73), permanent physical
> features (`bodyFeatures`, D53). §2 is the door that sends each of those where it belongs.

---

## Why this exists

The corpus is 25,197 bodies derived from OSM, NHD and 3DHP by a pipeline nobody has walked. Every
row is a claim — this outline, this name, this launch, this lot with toilets — and on a corpus that
size some thousands of those claims are wrong. Today a skater who knows one is wrong can do exactly
one thing about it: report that there is no public access (A06f). Everything else they know — the
water body is two polygons, the boat ramp is a private driveway, the aerial is 40 m off, the lot has no
toilets, it is called Lake Auburn and not The Basin — has nowhere to go.

The founder's framing, 2026-09-10: *"a way for users to report/flag bodies with different issues.
These would become alerts in the admin dashboard for a moderator to address."*

**The reporting half is small; the moderator half is the phase.** Filing a report is a sheet and a
vocabulary. Acting on one needs a lever that fixes the underlying row and *stays fixed* — and for the
polygon, the one category the founder asked about first, that lever does not exist: nothing edits a
body's outline, and if something did, `importCanonical` would overwrite it next campaign.

### What A07b already took off this list

The 2026-09-10 scoping pass listed eighteen categories. Three of them were lifecycle questions in
disguise, and building them as flags would have been a second, weaker mechanism for the same asks.
A07b built them as requests, with their own dedup, per-person cap, drawer buttons and queue:

| Category as first scoped | What it is now |
| --- | --- |
| "This shouldn't be on the map at all" | `takedown` → `standing: removed` (D179) |
| "There's a water body here you don't have" | `admit` → the 3DHP resolver attaches the polygon (D106/D179) |
| "No public access" re-disputed after a ruling | `contest_access` under a `dormant · no_public_access` standing |

And one was already solved before it was scoped: "the name is wrong" has `setWaterBodyName`, which
records the pick as a `nameClaims` entry with `source: 'user'` that `nameFields` merges ahead of every
campaign. That category needs a queue row pointing at `/admin/water/$id`, nothing more.

---

## The audit — every category, and what a moderator can do about it today

Ranked by expected volume × value on this corpus. The right-hand column is the honest scope signal.

| # | Report | Target | Lever today |
| --- | --- | --- | --- |
| 1 | Polygon: these N bodies are one water body | body + body | ⚠️ `merge` exists but **keeps one outline and tombstones the other** — a causeway-split water body loses half of itself |
| 2 | Polygon: wrong shape — includes land, offset, missing a bay | body | ❌ nothing edits a body's outline; A02's water body editor draws *bays* on a locked canvas |
| 3 | Polygon: this should be split | body | ❌ new — and usually the honest answer is *name the bay* (A09), not split |
| 4 | Name is wrong / locally called something else | body | ✅ `setWaterBodyName` (A07a) — survives re-import |
| 5 | Duplicate of another water body on the map | body + body | ✅ the dedup queue (`listDedupCandidates`, `merge`) — a report is a hand-flagged pair |
| 6 | Pin sits on the shoreline or off the water body | body | ⚠️ known — `centroid` is Turf `pointOnFeature`; `interiorPoint` is the fix, and [`features/representative-point-rename.md`](../features/representative-point-rename.md) is the plan |
| 7 | Imagery broken — misaligned, cropped, wrong season | body (+ viewport) | ❌ no per-body suppression; no way to say *which* layer, *at what zoom* |
| 8 | Put-in wrong — bad coordinates, doesn't exist, private | put-in | ⚠️ `putIns.hide` (A09 coordinate row) and `setOfficial`; no move |
| 9 | Put-in missing — there's a launch here you don't have | body + coordinate | ⚠️ `setOfficial` places one; no skater path to propose it |
| 10 | Lot wrong — amenities, capacity, fee, serves the wrong water body | lot | ⚠️ `setOfficialParking` takes all of it; wired only on `/admin/water/$id` |
| 11 | Posted hours wrong (A06e) | body / put-in / lot | ✅ `PostedAccessEditor` |
| 12 | Depth / contours wrong — belongs to a different water body | body | ❌ A06b matched by containment; a mismatch has no lever beyond the depth override |
| 13 | Sub-area wrong — bay misnamed, misplaced, shouldn't exist | sub-area | ✅ `subAreas.rename` / `redraw` / `remove` |
| 14 | Reference link dead or wrong (A06c) | body | ✅ `set_reference_links` |
| 15 | Never safely skateable — bubbler, year-round current, drawdown | body | → a `bodyFeature` (D53); today only a moderator promoting a recurring hazard can create one |
| 16 | `other` — free text | anything | the way category 17 gets found |

**What this table says:** rows 4, 5, 11, 13, 14 are a queue row deep-linking to a lever that exists.
Rows 8, 9, 10 are a lever that exists on the backend and needs a surface. Rows 1, 2, 3, 7, 12 have no
lever, and 1–3 share one missing primitive. Row 15 is a door to a different table. That is the
workstream order below.

---

## The four doors (§2's routing rule)

A skater with something to say about a water body has, after this phase, four places to say it, and the
sheet's first job is to open the right one. Getting this wrong is worse than not building the sheet:
a correction filed as an access alert **expires in 30 days and comes back next winter**, and a
permanent hazard filed as a correction is a queue row that a moderator dismisses because nothing about
the row is wrong.

| The skater is saying | Door | Table | Lifetime |
| --- | --- | --- | --- |
| *"Our data about this water body is wrong"* | **correction** — this phase | `contentFlags` | until a moderator acts |
| *"This water body should / shouldn't be in the corpus"* | **request** — A07b | `waterBodyRequests` | until a moderator answers |
| *"The gate is locked today"* | **access alert** — A06d | `accessAlerts` | 30 days, seasonal reset |
| *"This water body has a bubbler every winter"* | **body feature** — A05c | `bodyFeatures` | until demoted |

The sheet lists the correction categories and, at the bottom, three links worded as the skater would
think them — *Is the gate locked or the road closed? · Should this water body be on the map at all? ·
Is there a permanent hazard here?* — each opening the existing control. It never files into another
table itself.

---

## D180 — A correction dedups per reason; a flag on content still dedups per target

**Proposed.** `contentFlags.flag` dedups one open row per (flagger, target) — `contentFlags.ts:71` —
with no `reason` in the key. That was right for every target it was written for and wrong for the
target A06f added. A flag on *content* is one claim: *this should come down*. The reason is the
argument for it, and one person gets one argument per comment. A report on a *place* is a claim about
one **property** of it — the outline, a launch, the aerial — and one person can rightly hold several
at once. Under the current key, the second one is silently swallowed: the mutation returns the first
row's id, the client reads success, and the report never existed.

**The rule:** the dedup key is (flagger, target) when the target is content and (flagger, target,
reason) when it is a place. "Place" is `waterbody`, `putIn`, `parkingArea`, `subArea` — the target
types this phase adds plus the one A06f did. The split is by target kind and not by reason, so a new
place reason inherits the right key with no edit.

**Why not per-reason everywhere:** it would let one person file five rows on one comment. That is
noise, not harm, but it changes a queue the moderators have already learned, for no case that needs
it. The branch is one predicate (`isPlaceTarget`) and it names the distinction rather than hiding it.

**Corroboration survives.** Within one reason the rows are still the people, so "4 people say this
launch is private" is still `count(open rows)`, and the A06f access lane is unchanged.

---

## D181 — A correction carries a subject and its evidence, typed per reason

**Proposed.** A `note: string` is enough to say *that* the aerial is wrong and not enough to
reproduce it — which layer, at what zoom, over which viewport, drawn from which season. A moderator
who cannot see what the reporter saw can only dismiss. The same holds for a put-in with bad
coordinates (which put-in? where should it be?) and for a lot with the wrong amenities (add
`toilets`, or remove `boat_ramp`?).

**The shape:** an optional `context` on the flag row, a discriminated union keyed by reason, each
arm holding only what the client had in hand when the sheet opened:

- `imagery_broken` — the layer id (aerial / winter frame), the season or capture label, the
  viewport's center and zoom, and the tile URL that was drawn. Captured, never typed.
- `geometry_wrong` — `kind: 'union' | 'split' | 'shape'`, and for `union` the other body's id, which
  the sheet lets the reporter pick from the bodies in the viewport.
- `access_point_wrong` — the put-in or lot id, `kind: 'coords' | 'missing' | 'private' | 'gone'`,
  and for `coords` and `missing` the coordinate the reporter tapped.
- `amenity_wrong` — the lot id and `{ add: Amenity[], remove: Amenity[] }`, so approving it is a
  patch and not a reading.
- Every other reason: no context; the note is the whole report.

**All optional ⇒ migration-free**, the `occurrences` discipline. The validator is the union, so a
client cannot file `imagery_broken` with a lot id. The queue renders each arm as the thing it names —
a map at that viewport, a pin at that coordinate, an amenity diff — and the moderator's approve button
on a structured arm performs the patch through the lever that exists (`setOfficialParking`,
`setOfficial`, `hide`).

**Redaction:** `lib/contentPurge` clears `note` on departure. `context` holds ids, coordinates and
URLs the app already stores against the reporter nowhere else, and nothing a person wrote — it stays.
Recorded here so the next reader of `contentPurge` does not have to work out whether it should.

---

## D182 — An operator's outline is the evidence that the outline is theirs; the import respects it

**Proposed.** `importCanonical` patches `polygon`, `bbox`, `centroid`, `representativePoint` and
`surfaceAreaSqM` on every touch (`waterBodies.ts:693`). Right for a value the catalogs own; wrong
the moment a person has corrected it, for exactly the reason `nameFields` gives: *a rule that
re-imposed the catalog next campaign would undo that choice silently, every campaign, for ever.*

**The rule, following the name precedent:** a corrected outline sets `geometrySource: 'user'`. The
value already exists in `GEOMETRY_SOURCES` — a body drawn from a track carries it — and the enum's own
comment names the asymmetry as the design: *a 3DHP-drawn body still has an OSM or NHD identity*, so an
operator-drawn one keeps its `source: 'osm'` identity, its `externalId`, its MIDAS linkage and its
dedup collapse, and only its *outline* is ours. `importCanonical` then skips the geometry fields when
`existing.geometrySource === 'user'`, the way it already skips `curatedBoost`, `publicAccess`,
`nameClaims` with `source: 'user'`, and the depth override. **The override is the evidence** — no
second column, no flag to keep in step.

**What the import still patches on such a body:** everything that is not geometry — name claims,
states, campaign stamp, `dropped` — and it *does* re-score, because richness and the boost are not
geometry. It does not re-derive `hasContours`; that reads the tile catalog by `externalId`, which
the override does not touch (verify at build — the second-audit note at `waterBodies.ts:715`
records that this exact field has been silently dropped before).

**Releasing it:** a moderator clearing the override sets `geometrySource` back to the catalog's
value and the next campaign refills the outline — the depth override's `Released the operator
override … the import may refill it` shape, audited the same way.

**The interim before an editor exists (§4.1):** the only outline writer this phase ships is the union
(§4.2). A hand-drawn outline correction is §4.3 and is the phase's biggest unknown; D182 is written so
that both writers set one field and the import honors one predicate.

---

## D183 — A union keeps the survivor's identity, draws both outlines, and offers each original as a bay

**Proposed.** The founder's ask: *"consolidate two bodies into one, and denote the original two as
sub-areas (or not)."* `merge` (D36) is the wrong primitive: it was built for *duplicates* — two rows,
one water body, near-identical outlines — and it keeps one outline because for a duplicate the other one is
the same shape. For a water body OSM split at a causeway, the loser's outline is the *other half of the
water body*, and tombstoning it deletes that half from the map.

**Union is merge plus geometry.** It takes a survivor and a loser like `merge` does, and calls
`mergeBodyInto` for everything that already works — reports, hazards, bounties, features, put-ins,
favorites, sub-areas re-clipped, the loser tombstoned with `mergedIntoId`, the audit row. Then:

1. **The outline** becomes `turf.union(survivor, loser)`, with `bbox`, `interiorPoint` (never
   `centroid` — it is `pointOnFeature`, on the shoreline) and `surfaceAreaSqM` re-derived, and
   `geometrySource: 'user'` (D182) so the next campaign does not put the seam back.
2. **The survivor** is whichever the moderator picks; the default is the larger, because its
   `externalId` is the one the bathymetry linkage and the weather registry most likely carry.
   Refuse if either is a tombstone, if the outlines do not touch or overlap within a margin (a union
   of two disjoint ponds is a `split` request in reverse and a moderator should have to say so), or
   if either is a sub-area's parent in a way `repointSubAreasOnMerge` cannot re-clip.
3. **The originals as bays — optional, per side.** The moderator ticks *keep as a bay* on either
   original, names it (defaulting to the loser's name, which is often exactly the bay's name — *Malletts
   Bay* was a separate OSM way once), and the union writes a `waterBodySubAreas` row from that outline
   through the same clip-to-parent rule `subAreas.create` applies. Not ticked ⇒ the outline is gone
   and the union is the only shape. A09 made a bay a place with its own drawer, reports, depth and
   weather, so keeping one costs nothing a skater will not use.
4. **The re-score** runs with richness (`transitionStanding`'s path, not the import's), because a
   union changes the area and the area is the score's first term.

**Split is deferred to §4.4 and probably to a feat.** A true split — one row that is really two
unconnected ponds — needs a cut line, a new body with no catalog identity, and a reassignment of
every report by point-in-polygon with a rule for the ones that have no point. Most "this should be
split" reports are a bay that wants a name, and the sheet says so before the category is chosen.

---

## Workstreams

### §1 — The prerequisites (one commit each, first)

- **§1.1 D180 in `contentFlags.flag`.** `isPlaceTarget(targetType)` in `lib/enums` beside
  `FLAG_TARGET_TYPES`; the dedup query takes the `by_target_status_reason` index for a place and the
  existing `by_target` filter for content. A regression test that files two reasons on one water body from
  one person and expects two rows — the test that would have caught this the day A06f shipped.
- **§1.2 D182 in `importCanonical`.** The predicate and the skipped field list, with the campaign-walk
  test `standing.test.ts` already runs extended by one body: a `geometrySource: 'user'` row through a
  re-affirming campaign keeps its outline and its area and takes its new name claims.
- **§1.3 The three-edit rule becomes a test.** `FLAG_TARGET_TYPES`'s comment warns that adding a
  target type takes three edits and skipping the third renders every such flag as *(deleted)*. Pin
  it: a test that files one flag per target type against a fixture row and asserts none resolves to
  `notFound`. This phase adds three target types and would otherwise be three chances to forget.

### §2 — The vocabulary and the sheet

- **§2.1 Enums.** `FLAG_TARGET_TYPES` += `putIn`, `parkingArea`, `subArea` (with `TARGET_TABLE` and
  `resolveFlagTarget` cases — §1.3 catches the miss). `FLAG_REASONS` += `geometry_wrong`,
  `name_wrong`, `duplicate_body`, `point_wrong`, `imagery_broken`, `access_point_wrong`,
  `amenity_wrong`, `posted_access_wrong`, `depth_wrong`, `sub_area_wrong`, `link_wrong`. `other` is
  already there. `isCorrectionReason` beside `isPlaceTarget` — the queue and the rollup both need it.
- **§2.2 `context` (D181)** on the schema, the validator union in `lib/validators`, and `flag`
  refusing a context whose arm does not match the reason.
- **§2.3 `ReportProblem` sheet (web).** One control under the drawer's action row — *Report a
  problem* — opening a sheet: the category list grouped as *the water body · getting there · the map*, a
  note, and the four-doors footer. **Launched with context** from wherever it was opened: the
  `AccessSection` put-in row pre-selects `access_point_wrong` with that put-in; the amenity line
  pre-selects `amenity_wrong` with that lot and a checkbox diff; `ImageryControl` pre-selects
  `imagery_broken` and fills the viewport arm from `MapSelectionContext` without asking anything.
  The `geometry_wrong · union` arm offers the listed bodies in the current viewport as the other
  half. Signed out ⇒ the control reads *Sign in to report a problem*, matching `PublicAccessSection`.
- **§2.4 The A06f control folds in.** `PublicAccessSection`'s *Report no public access* becomes the
  `no_public_access` row of the same sheet, keeping its gate message and its *you reported this*
  read-back. One place to report, not two side by side.
- **§2.5 "You reported this."** `myAccessFlags` generalizes to `myOpenFlagsFor(waterBodyId)` so the
  sheet marks the categories already filed and the drawer can say *2 things reported — with the
  moderators*. The A08 `content_flag_resolved` notification already tells them the outcome.

### §3 — The queue lane and the dashboard tile

- **§3.1 `listFlags` grows a `corrections` lane**, grouped by (target, reason) like the access lane
  and ranked by distinct reporters, because every reason here is one many people can independently
  hold about the same target. Content flags stay where they are; `isCorrectionReason` is the split.
- **§3.2 `CorrectionRow`** on `/admin/flags`: the target resolved to a name and a deep link, the
  context arm rendered as the thing it is (D181), the notes, and the actions — **a lever button
  when one exists** (*Open in editor* for name/link/posted-access/sub-area; *Hide launch*, *Move
  launch*, *Apply amenity change*, *Union with …* performing the mutation in place with a
  `ReasonDialog`) and always *Actioned* / *Dismiss* through `resolveFlag`. A lever's success closes
  every open row in the group through `closeFlag`, the way `setPublicAccess` does — each reporter
  hears back once.
- **§3.3 The dashboard tile** — *Corrections* beside *Other flags*, counting groups not rows.
  **No founder email**: `unsafe_false_report`'s priority alert stays the only one; corrections are
  volume, not incidents.
- **§3.4 The 07-2 rollups split by lane.** `flag_queue_depth`, `flag_oldest_open_age_h` and
  `flag_time_to_resolution_h` each gain a `corrections` series so the moderation-load chart keeps
  meaning moderation load. Additive; the existing series are unchanged.

### §4 — The outline

- **§4.1 `geometrySource: 'user'` semantics** are §1.2; this workstream is the writers.
- **§4.2 `waterBodies.union` (D183)** — the mutation, its refusals, the bay minting, the re-score,
  the `union_waterbody` audit action with both original outlines in the reason payload so it can be
  read back. A *Union with …* button on `/admin/water/$id` beside *Merge*, with the same dedup-card
  affordance and the other body picked from the map.
- **§4.3 Outline editing — the unknown.** A02's canvas draws bays with terra-draw on a camera-locked
  map, so most of an outline editor exists; what does not is a *body* geometry writer, the reversal
  of the clip direction (bays must stay inside the new outline, so an edit that orphans one must
  re-clip or refuse), and the cell-index resync a changed outline needs (`syncWaterBodyCells`, which
  `transitionStanding` already calls). Scope at build; if it exceeds a PR it becomes a feat and
  `geometry_wrong · shape` reports queue against it.
- **§4.4 Split** — deferred; see D183.

### §5 — The levers that exist and need a surface

- **§5.1 Put-ins:** *Move* — `setOfficial` at the reporter's coordinate plus `hide` on the original,
  as one action with one audit row. *Gone* and *private* — `hide`. *Missing* — `setOfficial` at the
  coordinate. All from the `CorrectionRow`, none new on the backend.
- **§5.2 Lots:** `setOfficialParking` applied with the amenity diff from D181; the reason carries the
  reporter count.
- **§5.3 Imagery:** a per-body `imagerySuppressed: { layer, reason, by, at }` that the reveal reads
  and skips — the only new field in §5 — because a broken frame over one water body is fixed by not
  showing it, not by a moderator re-rendering NAIP. The row on the queue shows the viewport from the
  context arm so the moderator sees what the reporter saw before deciding.
- **§5.4 Depth:** the existing depth override released or set from the row; a contour mismatch
  (wrong water body's survey) has no lever and is recorded as such — the fix is in the A06b matcher, and the
  report is its input.

### §6 — Mobile parity

`apps/mobile` has `WaterBodyDetail`, `PublicAccessSection`, `AccessSection` and `RequestLake`
already; the sheet is a bottom sheet with the same category list and the same doors, the context
arms captured from the native map's viewport and the tapped marker. No moderator surface on mobile,
as ever.

### §7 — The record

`docs/moderation.md` (or the section of `docs/user-reputation.md` that covers flags) gains the four
doors and the lifecycle of a correction; `06-data-model.md` the `context` union; `01-decisions.md`
D180–D183 once ruled; the roadmap entry flipped at each gate.

---

## PR breakdown

Two PRs, stacked, under the "one PR per phase unless a review boundary wants its own" rule — and
this one does, because PR 1 changes a mutation moderators already depend on and PR 2 is the first
outline writer in the app.

- **PR 1 — `phase-a07c-body-corrections`:** §1, §2, §3, §5.1–§5.2, §6. Every report can be filed
  and every one with a lever can be acted on. Ends with a dev deploy and one of each category filed
  from the web and the phone against dev.
- **PR 2 — `phase-a07c-body-corrections-2`:** §4.2 union, §5.3 imagery suppression, §5.4, §7.
  §4.3 if it fits; a feat doc in `features/` if it does not.

---

## Tests (D40)

- **`contentFlags.test.ts`:** two reasons, one water body, one person ⇒ two rows (§1.1); two reasons, one
  comment, one person ⇒ one row; context arm mismatch refused; every arm accepted with its reason.
- **`moderation.test.ts`:** every target type resolves (§1.3); the corrections lane groups and ranks
  by distinct reporters; a lever closes the whole group and each reporter is notified once.
- **`waterBodies.test.ts`:** the campaign walk with a `geometrySource: 'user'` body (§1.2); `union`
  — outline is the union, area re-derived, loser tombstoned, children re-pointed, bays minted when
  ticked and not when not, refusals for tombstones and disjoint outlines, audit row carries both
  originals; a union survives a re-affirming campaign.
- **`core`:** `isPlaceTarget` / `isCorrectionReason` are exhaustive over their enums (a new value
  without a classification fails to compile, or fails a test — the `requestKindsFor` pattern);
  `fast-check` over the union: for random overlapping polygons the result contains both inputs and
  the area is at least the larger and at most the sum.
- **Web:** `ReportProblem` renders the doors, pre-selects from each launch point, and shows *you
  reported this* on filed categories; `CorrectionRow` renders each context arm.

---

## Open questions — founder calls before build

1. **D180's split — by target kind, as proposed, or per reason everywhere?** The proposal keeps the
   content queue exactly as moderators know it. Per-reason everywhere is one line simpler and admits
   five rows on one comment from one person.
2. **The union's survivor default — larger, or the one with bathymetry?** Larger is proposed; a
   contour-linked smaller half is the case where it is wrong. Both are visible on the card either way.
3. **Bays from a union — default ticked or unticked?** Ticked keeps the loser's name findable, which
   is the A07a argument for keeping the losing name. Unticked keeps the sub-area table free of bays
   nobody asked for. Proposal: ticked when the loser has a name, unticked when it does not.
4. **Does a correction need a contributor, or a profile?** `flag` takes `requireProfile` — a minor
   or a read-only account can report. Proposal: keep it; a correction is not a contribution, and the
   person turned away at a private driveway is worth hearing from regardless.
5. **Should `imagery_broken` reports show on the reporter's map** the way an access report fades
   their water body? Proposal: no — the aerial is viewport-wide and one report should not suppress it for
   one person; the notification is the read-back.

---

## Related

- [`phases/A06f-no-public-access.md`](./A06f-no-public-access.md) — the first place in
  `contentFlags`, and the dedup-as-corroboration argument this phase generalizes.
- [`phases/A07b-corpus-by-request.md`](./A07b-corpus-by-request.md) — the request door.
- [`phases/A09-subareas-as-places.md`](./A09-subareas-as-places.md) — why a bay is the answer to
  most "split" reports, and the put-in suppression row.
- [`phases/A02-body-editor-and-subareas.md`](./A02-body-editor-and-subareas.md) — the canvas
  §4.3 would extend.
- [`features/representative-point-rename.md`](../features/representative-point-rename.md) — row 6.
- D3 (never authoritative — nothing in a correction says the ice is anything), D32/D37 (flags and
  the queue), D36 (merge), D53 (body features), D73 (access alerts), D92 (`geometrySource`), D176–D179.
