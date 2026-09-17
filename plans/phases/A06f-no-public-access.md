# Phase A06f — No public access: a corroborated claim that dims a body

*Some water is reachable only across private land. The map had two ways to say it — an alert that
expires, or a body that vanishes — and needed a third: **on the map, and marked.***

> **Status:** ✅ **COMPLETE — built 2026-08-16, review fixes 2026-08-17, merged as PR #44
> (`phase-n6e-n6f-access-and-qol`) 2026-08-17; the follow-up that closed the phase's one gap merged
> as PR #56 on 2026-09-16.** On dev since #44; #56's client changes ride the next deploy. Prod
> deferred, as every phase since 2.5. Suites at #44: core 1,945 · convex 1,303 · web 352 · mobile 97;
> at #56: web 539 · mobile 111, `lint` and `check-types` clean on both.
> **This document was written after the fact (2026-09-14, PR #56).** The phase shipped without a
> plan doc — it was a founder ask taken directly into the A06e branch, and the design lives in commit
> messages, module docstrings and the PR body. This is those sources reconciled against the code as
> it stands, in the shape of the other N-series docs, so the next person can find it. See *§The
> follow-up* for what writing it turned up.
> **No D-number was assigned.** The founder calls are recorded in *§Founder calls* below rather than
> in [`01-decisions.md`](../01-decisions.md); the only entry there that touches this phase is **D166**
> (A06h), which re-uses the map dim this phase built.
> **Rode with:** [A06e](./A06e-satellite-imagery.md)'s posted-access rules and four stranded
> A07a-3 wind-rose commits — three lanes on one branch, separated by commit prefix. The PR body is the
> summary of all three; this doc is the `n6f` prefix only.
> **Touches:** `waterBodies` (a new field and six scoring sites), `contentFlags` (a new target type
> and reason), `moderation` (a grouped queue lane), the A06c §4.2 zoom ladder in `core/display.ts`, both
> clients' map layers, the web drawer, the web list, and — under the same prefix — the water body editor's
> placement tools, `reports.update`'s first UI, and the recorder's unreported-skates list.
> **Not built at #44:** a mobile report control (mobile had the map dim and nothing to press) —
> **closed by PR #56**, along with the web surface's missing test and a form-state bug on both
> clients that the test's review found. A live moderator render has still not been verified. See
> *§What is not built* and *§The follow-up*.

---

## Why this phase exists

A public pond ringed by private parcels is the ordinary Northeast case. The water may legally be
yours to skate and you still cannot get to it, and the map had no way to say so. The two mechanisms
that looked adjacent were both wrong for it:

- **`accessAlerts` (A06d, D73) expires by design.** A 30-day TTL, hard-expired at the season
  boundary, and hung off a *launch or lot* rather than the water body. That lifecycle is right for a locked
  gate and wrong for a deed — private land does not thaw, and the fact would be deleted every July.
- **`waterBodies.remove` (D48) is total.** It drops the body's cell rows and the water body vanishes. But
  someone may hold a key or an invitation, and taking a real water body off the map is a claim we have no
  business making from a parcel map.

`isListed` was binary — fully on the map or not there — so the state this phase needed did not
exist. `waterBodies.publicAccess` is the **third state**: the body stays, draws dimmed, and sinks
two zoom levels.

The claim is stated precisely in `packages/core/src/publicAccess.ts`, because the precision is what
makes it checkable: **no public access means every approach crosses private land — there is no
lawful way in.** It says nothing about who owns the water. That restraint is the point: the second
fact is the one a skater needs, and the only one a moderator can verify against a parcel map.

### Why this one may suppress, when `postedAccess` may not

A06e's `postedAccess` promises to *annotate and never suppress* — a skater out at dusk is exactly who
most needs to file, so posted hours never hide a form. This field dims and demotes, which *is*
suppression. So it is a separate field with its own justification rather than a flag smuggled in
beside a posted sign: posted hours are a fact about *when*, and being wrong costs a reader nothing;
this is a fact about *whether you may be there at all*, and a body nobody can lawfully reach should
not compete for attention with one they can.

---

## Founder calls — 2026-08-16

The proposal offered was simpler than what shipped, and the founder's amendments are what give the
phase its shape. Recorded here because there is no D-number to point at.

1. **A pending report shows a drawer note only — no map change for anyone else.** One account must
   not be able to dim any water body in the corpus until a human gets to it. But three amendments make the
   report *do* something:
   - **(a) Others corroborate rather than re-report.** The count is public in the drawer — *"3 people
     have reported no public access here — under review."*
   - **(b) The reporter sees their own water body faded.** Their claim, reflected back to nobody else. It
     is the only feedback that a report went anywhere.
   - **(c) More reporters ⇒ higher in the queue.** The moderator lane groups by water body and ranks by how
     many people agree, not by age.
2. **"Reviewed, and it IS public" is a stored verdict**, not a dismissed flag. Dismissal is a fact
   about one report; this has to be a fact about the water body, because its job is to stop the same body
   being reported over and over.
3. **The first penalty in the zoom ladder is allowed, scoped to this one attribute.** See
   *Workstream 2*.
4. **Under the same prefix, later the same evening:** *you save your changes or you don't* — the
   report edit form has no draft lane (the draft flush only ever calls `reports.create`, so a
   mis-tap would have posted a duplicate).

---

## §1 — The model: three states, and absence is one of them

**`waterBodies.publicAccess`** (`packages/convex/convex/schema.ts:982`) is one optional object:

| Field | Notes |
|---|---|
| `verdict` | `'none'` \| `'open'` — `PUBLIC_ACCESS_VERDICTS` in core |
| `decidedAt` | **load-bearing, not decoration** — see the gate in Workstream 3 |
| `decidedByUserId` | the moderator, for the audit row |
| `note?` | shown publicly, ≤ 160 chars (the depth-note ceiling) — *"Ringed by posted parcels; no legal approach."* |

- **absent** — nobody has ruled. The default for ~25k bodies.
- **`none`** — no lawful way in. Dims to half opacity and drops ~2 zoom levels. Stays on the map.
- **`open`** — reviewed, there *is* public access. **Renders nothing.** Its entire job is the
  re-report gate.

One field rather than two booleans, because both verdicts are the same moderator answering the same
question, and a pair would make "both set" representable.

**`setPublicAccess`** (`waterBodies.ts:2796`) is the only writer. Moderator-gated, takes `verdict |
null` (null clears back to unruled), re-scores the body, re-syncs its cell rows, resolves every open
report on it in the same transaction — `actioned` when the reporters were right, `dismissed` when
they weren't, left open on a clear — and writes a `set_public_access` audit row whose metadata
carries both the new ruling and the previous one.

**Two enum additions, three edits each.** `'waterbody'` joined `FLAG_TARGET_TYPES` and
`'no_public_access'` joined `FLAG_REASONS`. The comment in `lib/enums.ts:222` now says out loud what
A06d's pre-PR review learned the hard way: a target type takes **three** edits — the enum,
`TARGET_TABLE` in `contentFlags.ts`, and a `case` in `resolveFlagTarget` in `moderation.ts` — and
skipping the third renders every such flag as "(deleted)" in the queue. The A06f test *"the queue
names the water body rather than rendering it as '(deleted)'"* pins the third edit.

---

## §2 — The demotion: the ladder's first penalty

`packages/core/src/display.ts:56` states the A06c §4.2 rule with a founder note attached: **every term is a
boost, never a penalty.** A body with no profile data keeps the zoom it has; richer bodies rise past
it. Subtracting for missing data would push obscure ponds below the discoverability floor, which is
exactly the founder's stated worry.

`NO_PUBLIC_ACCESS_DEMOTION` (`display.ts:219`) is the first subtraction, and the docstring argues
the rule is *scoped* rather than softened. Two things make this the exception rather than the first
of many:

1. **It is the only attribute that *should* discourage someone from trying.** Every other term
   rewards what we know about a water body, and the absence of that knowledge is *our* gap, not the water body's
   fault. "There is no lawful way in" is a fact about the place, and a map that led someone there
   anyway would be doing harm rather than merely failing to help.
2. **It is entirely contingent on a human decision.** The rest of the ladder moves on aggregates —
   time, report density, profile completeness — side effects of activity a water body neither controls
   nor deserves. This one is a moderator's ruling with a name and an audit row.

**The clamp is what makes it safe rather than what makes it right.** `minVisibleZoom` clamps its
input to `[0, 1]`, so the z14 floor (D49) holds however negative the total goes. A demoted body
draws *later*; it can never stop drawing. The magnitude is `2 × SCORE_PER_ZOOM_LEVEL` = 0.25 — two
zoom levels on the `[0,1] → z14..z6` span: enough that a private water body stops crowding a regional
view, small enough that a large one is still findable when you zoom to where you know it is.

### ⚠ The trap: the demotion is derived, and `importCanonical` would have silently undone it

This is the finding most worth keeping from the phase. `displayScore` and `minVisibleZoom` are
stored on the row *and* denormalized onto cell rows as the trailing field of `by_cell`. Every site
that re-scores an existing body therefore has to pass `noPublicAccess` — and it is the only
`scoreFields` input that is **not derivable from the incoming record**, so an omission does not
fail. It silently restores the body's undemoted zoom, and nothing says so.

`importCanonical` is the dangerous one: it patches a *named field list*, so a corpus campaign would
**preserve the verdict** while re-scoring from area + curatedBoost only — keeping the ruling and
quietly restoring the original zoom. A test that checked "does `publicAccess` survive a re-import?"
would pass either way. **The assertion that matters is `minVisibleZoom`**, and
`publicAccess.test.ts`'s *"a re-import preserves the ruling AND the demotion"* block asserts exactly
that.

**Six sites read the field**, through one helper so they cannot spell it differently
(`noPublicAccessOf`, `waterBodies.ts:431`): `scoreFields` itself, `zoomSortKey`, `importCanonical`'s
update path, `backfillCells`, `setCuratedBoost`, and `applyCuratedBoostSeed`. Each omission fails
silently and permissively — the direction a review will not catch by looking at output.

---

## §3 — Corroboration on `contentFlags`, with nothing new

**The count needed no votes table.** `contentFlags.flag` already dedups to one *open* flag per
(flagger, target) — a repeat is a no-op returning the existing row — so **N open rows *is* N
distinct people**. A votes table would only have re-implemented that dedup. Corroboration is
therefore: file a `no_public_access` flag against the `waterbody`, and the count is an equality read
off `by_target_status_reason` (`pendingAccessReportCount`, `waterBodies.ts:2917`).

**The reporter sees their own claim** via `contentFlags.myAccessFlags` (`contentFlags.ts:~123`) —
the caller's open access reports, bounded by how many water bodies one person has been turned away from,
`[]` when signed out because the map renders for anonymous visitors.

### The re-report gate under an `open` verdict — a note requirement, not a block

While an `open` verdict stands, filing `no_public_access` on that body **requires a note saying what
changed** (`contentFlags.ts:64`, refusing with `accessReportGateMessage`, which names the review
date). Not a block: land is sold and gates go up, so a body public in 2026 may not be in 2029, and a
permanent refusal would eventually be wrong and leave the person who was just turned away with
nowhere to go. But a settled question that can be re-asked with one tap never stays settled. One
sentence is the whole cost, and it is only charged to the *second* reporter.

The gate is scoped to this reason — other flags on the body are untouched — and a `none` verdict
gates nothing, because the body already says so.

**"Disputes a prior review" is derived, not stored.** `disputesReview` (core) compares
`flag.createdAt >= publicAccess.decidedAt`. A stored label could disagree with the verdict it
describes once a moderator re-rules. **`>=`, not `>`:** a report filed in the same millisecond as the
ruling was still checked against a verdict that already existed, so it cannot be anything but a
dispute — and any report genuinely older than the ruling was resolved by it and is no longer open,
so the boundary is only reachable from the disputing side.

### The queue lane

`moderation.listFlags` now returns a third lane, `accessReports`. The access rows **leave the flat
lanes entirely** — a water body in both places would put one job in front of a moderator twice, once
collapsed and once not. `groupAccessReports` collapses per-reporter rows into one job per water body,
carries the reporters' notes newest-first, marks `disputesReviewFrom` when the newest report
post-dates an `open` ruling, and sorts **most-corroborated first, age breaking ties** — the
founder's *"the more users, the higher it rises"*, with two one-report water bodies still draining
front-to-back. A body deleted out from under its reports has no job left; the rows stay for the
record.

---

## §4 — The surfaces

**Both map signals ride GeoJSON `properties`, not feature-state.** Favourites use feature-state on
web; copying that here would have forced mobile into a parallel filtered layer, because the React
Native binding has no ergonomic `setFeatureState`, and two mechanisms for one visual effect is how
the platforms drift. So `noPublicAccess` and `selfFlagged` are properties on the feature, and one
`withAccessDim()` expression in core wraps each water layer's existing opacity on **both** clients.
It is a **multiplier** (`NO_PUBLIC_ACCESS_OPACITY_SCALE = 0.5`), not a fixed opacity, so web's
selected/unselected fill distinction survives on a dimmed water body and mobile's flat fill is not fought.
`['==', ['get', …], true]` rather than a bare `get`: a missing property reads as `null`, and `any`
over a null *throws* in MapLibre's evaluator instead of reading as false. Mobile needs `as never` on
the paint props (the `hazardFillOpacityExpression` idiom).

> Since **D166** (A06h, 2026-09-12) the same expression also carries the weather-discovery dim
> (`weatherDimmed`), so the function is named for what it was built for and does more than its name
> says. That is documented on `withAccessDim` itself.

**The web drawer** — `PublicAccessSection.tsx`: one control, role-dependent effect. A member's tap
files a report; a moderator's rules directly. All three states render: the amber `none` line, the
quiet `open` line with its date, and the pending count. The note field is required client-side only
when `open` stands — the courtesy that keeps a member from discovering the gate via a round trip.
The section renders nothing at all when there is nothing ruled, nobody reported, and no way to report.
**It never blocks anything** — a ruling dims and demotes; it does not hide the report form, the
hazard form, or the directions. Somebody with a key or a landowner's word is exactly the person whose
report is worth most, and a ruling we got wrong is only ever corrected by someone who went anyway.

**The web list** (`viewportLakes.ts`): `none` bodies sort **last** — below favorites on purpose, since
*if you favorited it, you know something we don't* — and the subtitle *leads* with "No public
access ·" because it is the one fact that decides whether the rest matters. The body still has a row:
harder to find, never hidden, the same restraint the zoom demotion keeps.

**Cards:** `BodyResultCard` (both clients) prints a "No public access" badge, and A06h's
`weatherDiscovery` cards carry `noPublicAccess` and *mark it, never hide it*.

**The moderator's tools:** `/admin/flags` gained the *"Access · most corroborated first"* lane, with
the count as the rank and a *"You ruled this open N days ago. These reports came after"* callout on
disputes. The drawer's moderator card lost its bare curated-boost number and links to
`/admin/water/$id` instead, where the editor's Prominence tool shows the resulting
`displayScore`/`minVisibleZoom` — approve/reject stayed on the drawer because they are decided in
passing on a pending user-drawn body, while prominence is curation you sit down to do.

---

## §5 — The wiring nothing could reach

Same prefix, same evening, different problem. An audit of **all 164 public Convex functions** turned
up **11 with no caller in either app**. The pattern repeated: a fully implemented, authz'd, audited
mutation with nothing to press.

| Function | State before | What shipped |
|---|---|---|
| `putIns.setOfficial` / `hide` | Zero callers since Phase 04, behind a comment deferring the operator UI to "Phase 07". The admin Put-ins card linked to the public map to *"place and hide pins"* — no such control existed there, and the destination linked back to admin. | Armed on the body-editor canvas. `setOfficial` gained an optional `name` (60 chars) — `osm` has OSM's, `derived` gets a compass label, so `official` was the one rung that could never be named despite being the rung where somebody *knows*. |
| parking creation | Two decimal lat/lng text boxes beside a locked canvas. Every plausible typo is a valid coordinate somewhere. | A click on the canvas, which cannot be in the wrong hemisphere. |
| `waterBodies.remove` / `restore` | A landowner takedown — the case D48 was built *for* — only from the Convex dashboard; a delisted body rendered *"Restore it before editing"* with no way to restore. | Both ends wired. |
| `accessAlerts.setOfficial` | `retract` was wired, this wasn't — a moderator reaching a flagged alert could only conclude "this is false". But a flag is also how a *true* alert reaches a moderator, and pinning it is the founder's 2026-08-10 TTL exemption. | Wired. |
| `reports.update` | Existed since D25; no edit UI, so posting was a one-way door. | Both apps open the same form seeded from the stored report (Workstream 6). |
| `gpsActivities.listMine` / `setPromptState` | The recorder's prompt was component state on a map control — `promptState` never left `pending` for any activity ever recorded. Background the app mid-skate and the recording was unreachable. | The You tab lists skates with no linked report, server-backed, above the device-local `TrackHistory`. |
| `bounties.get` | Zero callers including tests; superseded by `getDetail`. | Deleted — a public query returning an unenriched row is worse than none. |

**Three tools now share one `placing: 'feature' | 'put_in' | 'parking' | null` discriminator** in
`LakeEditorMap`, because it has a single unconditional click handler and a boolean-per-tool let two be
armed at once — the click went to whichever branch was written first, a lot saved as a put-in, with
no error. Hiding a put-in is a list row rather than a click on the pin: a pin is 6 px, OSM contributes
clusters, and hiding takes a mandatory reason.

**Operator put-ins snap to the shoreline** (`OPERATOR_PUT_IN_SNAP_MAX_M = 500`,
`core/access.ts:130`). `official` was the only rung stored raw — `derived` clusters are snapped in
`listForBody`, `osm` launches arrive on the shore — and a put-in coord is the directions destination,
so a hand-placed floating pin reintroduced the exact bug put-ins exist to fix, one water body at a time.
Snapped on write and previewed snapped. The bound is only reachable from *outside* the polygon
(`distanceToPolygonMeters` reads 0 on the water, so a mid-Champlain click snaps five kilometres,
which is right); a click well inland is somebody marking a trailhead, and is **refused** rather than
dragged onto the water — there is no "move this put-in", so a wrong one means hiding it and leaving
a suppression row. Its own constant, not `PUTIN_SHORE_RADIUS_M`: that 30 m is the ETL's *identity*
tolerance and would reject an ordinary click at a wide zoom.

Four stale comments were corrected on the way: `putIns.ts` and `schema.ts` still promised the
operator UI "in Phase 07", `bodyFeatures.ts` said the same of a tool that had shipped, and
`contentFlags.ts` said the flag queue didn't exist yet.

---

## §6 — Editing a report, without losing what you didn't touch

`reports.update` is last-write-wins over the **whole content block**, so the form is seeded from the
whole report — a form that started empty would silently delete every field the author didn't
retype. `reportFormFromReport` (`core/reportForm.ts:271`) is the inverse of `buildReportInput`, and
its round trip is pinned in core: metric to imperial and back, each thickness reading kept in the
mode it was measured in, so a half-filled range cannot collapse into a precise claim.

Two things the edit path needed that did not exist:

- **`editedAt`, distinct from `updatedAt`** (`schema.ts:1923`, the `comments.editedAt` precedent).
  The conditions autofill moves `updatedAt` on nearly every report hours after posting, so an
  "· edited" byline off it would have accused the whole corpus of edits nobody made.
- **Conditions provenance survives an unrelated edit.** The form has no slot for `source` and stamps
  everything `user`, so fixing a typo in your notes would have re-marked Open-Meteo's weather as
  personally observed. The server compares values: unchanged weather keeps its stored source. It
  only ever downgrades, so it cannot launder a user's number into an observation. *How* it compares
  is the story of the review round below.

**No draft lane for a published report** (founder call). The button is hidden while editing *and*
`handleSaveDraft` returns early on the same condition, so putting the button back cannot quietly
reintroduce the duplicate.

The You tab's unreported list needed a **server `activityId`** path through the report form — the
recorder hands over a local draft id because the track may not have flushed, but a row from the
server may have no local draft at all. That path is what un-blocked A07b's `NewWaterPrompt`, which
was written, complete and unmounted for lack of exactly this id (see
[A07b](./A07b-corpus-by-request.md#-the-client-half-is-already-written-and-unmounted--wire-it-dont-write-it-noted-2026-08-16)).

---

## What Greptile found — 2026-08-17, PR #44

*Three P1s on this prefix, plus one follow-up on the fix. All real. Two are the same shape as the
phase's own headline trap — a derived value re-computed from fewer inputs than it was built from.*

**1. A ruling dropped the richness the body had earned** (`waterBodies.ts`, `setPublicAccess`).
`scoreFields` takes richness too, and the ruling wasn't passing it — so ruling on a water body re-scored it
from area + boost alone and dropped every A06c §4.2 term: its put-ins, its depth, its contours, the fact
that anyone had ever reported on it. The trap the module already warned about for `noPublicAccess`,
one argument over, and it lands hardest here because this is the ladder's only penalty: a demotion
on a stripped score puts the body *lower than the ruling asks*, and clearing the verdict restores it
to the wrong zoom rather than the one it had — drawing later than it should until the next
`backfillCells`. The bulk paths omit richness for a cost reason (two extra index reads across the
corpus inside the heaviest mutation in the app); that argument does not reach one body under a
moderator's hand, so **both moderator mutations now read it** — `setCuratedBoost` too, because
otherwise a boost applied right after a ruling would strip the richness the ruling had just scored
in, and the zoom would swing on whichever control was touched last. The regression seeds an official
put-in, scores it the way the corpus sweep would, rules and un-rules, and asserts `displayScore`
came back to where it started.

**2. Editing a report detached its photos.** `photoIds` is part of the last-write-wins block, and the
form only knew about *this session's* uploads — so fixing a typo submitted `[]` and every image came
off. The server was already careful (`args.photoIds ?? existing.photoIds`), but an explicit empty
array is a legitimate instruction to remove them all. The form now shows what is attached with a
remove control each, and submits kept ids ahead of new ones — from the caller rather than a query,
because a submit that beat an async fetch would post the same empty list. Kept photos are
deliberately **not** run through `usePhotoDrafts`: its reclaim-on-abandon sweep would delete a
published report's images the moment someone opened the edit form and backed out.

**3. Weather provenance was decided by an exact float comparison.** The conditions fields are whole
°F and mph; the stored numbers are precise metric from Open-Meteo. −3.4 °C renders as `26` and comes
back as −3.33, so `stored === next` was false for weather nobody touched, and the block was
relabelled `user` — a model's figure restamped as a personal observation, with the number nudged on
the way through. The existing tests had used −8 °C and 12 kph, which happen to be whole imperial
units, which is why they passed.

**4. The first fix opened a false negative, and Greptile caught it.** Comparing "did these round to
the same whole unit?" fixed the false positive — and both inputs accept decimals, so 26.4 °F typed
over a modelled 26 °F read as unchanged and the server restored the model's number. *Discarding an
author's edit to protect provenance is a worse failure than the one the check was added to prevent.*
The tolerance was the wrong instrument. **`isFormRoundTripOf`** (`core/reportForm.ts:241`)
reconstructs `toMetric(display(stored))` — the exact arithmetic `reportFormFromReport` →
`buildReportInput` performs, same ops in the same order — and compares exactly. No window: an
untouched field matches bit for bit, anything typed over it doesn't. The one case it still absorbs
is an author retyping the number already on screen, which is right anyway. The sharper check found
that one of the hand-written "round-tripped" literals in the older tests was simply wrong.

**One flake fixed on the way.** `weatherAlerts.test.ts`'s two-state dedupe raced the wall clock for
distinguishable `fetchedAt` stamps — same-millisecond polls left the dedupe nothing to order by but
insertion order, so it picked the stale copy and reported a regression that wasn't there. It failed
twice in one evening; the describe block below it already faked the clock for exactly this reason.
Worth fixing before review rather than after, because it guards a Greptile P1 and the first thing a
red run teaches anyone is to re-run it.

---

## What is not built

- ~~**A mobile report control.**~~ **Closed by PR #56 (merged 2026-09-16)** — see *§The
  follow-up*. At #44, mobile carried the map dim — `noPublicAccess` and the viewer's own
  `selfFlagged` via `myAccessFlags` — and the `BodyResultCard` badge, but no drawer section: a
  member on the phone could not file, see the pending count, or read a ruling's note, and the phone
  is where a skater is standing when they get turned away.
- **A live moderator render has not been verified.** MCP cannot authenticate as a moderator, so
  ruling on Tomhannock (`m9761xrcwchdgky9g8gxvyz8hx8ajcz3`, seeded on dev) via `/admin/flags` and
  the drawer's three states were reasoned about rather than seen — and #56's mobile section has not
  been on a device. Put-in placement *was* click-tested by hand. Both want a look on the next
  preview build; neither is code.
- **No corpus-lifecycle consequence of a `none` verdict.** Recorded in
  [A06h](./A06h-weather-detail.md) rather than here: weather discovery deliberately does *not*
  filter `none` bodies, because the founder's read is that a confirmed ruling should eventually
  **remove a body from the corpus** rather than have every query learn to skip it — *"the ideal
  situation eventually (way down the line) would be managing 5,000 water bodies that actually get skated
  on, not 20,000 nobody ever touches."* **Scoped 2026-09-16 as [A07b Workstream L1](./A07b-corpus-by-request.md#workstream-l1--what-a-none-verdict-does-next-on-the-map-and-marked-never-recommended)
  and proposed as D175:** a `none` verdict removes a body from every *discovery* surface and no
  *reference* surface (one `isDiscoverable` predicate; purge stays a human act via D48 plus a
  purge-candidate list). Its own PR, because it touches the Phase 04 fan-out.
- **No D-number.** This doc is the record; the roadmap and README entries (added with it) point
  here rather than at `01-decisions.md`.

---

## The follow-up — PR #56, 2026-09-14 → 2026-09-16

*Writing this doc a month after the fact meant reading every A06f reference in the tree, and the
reading found three things. The PR that added the doc closed all three, its review found a fourth
that had been on both clients since #44, and closing the phase out found a fifth.*

**1. The mobile drawer had the dim and nothing to press.** `apps/mobile/src/components/
PublicAccessSection.tsx` is now the member's half of web's component — report, corroborate
(*"Confirm — I've been turned away"* once someone else has), the note gate under an `open` verdict
with the server's refusal surfaced verbatim, and all three verdict lines — mounted on the Overview
tab beside `PostedAccess`, since both are facts about permission rather than about the trip.
**Deliberately no rule buttons:** moderation stays on `/admin/flags`, where the corroboration count
is the rank. `setPublicAccess` still has zero mobile callers, and that is by design.

**2. The web surface was the one A06f component with no test.** `AccessSection.test.tsx` and
`PostedAccess.test.tsx` sit either side of it — the exact finding A06d's pre-PR review made about
its own surfaces, repeated. The component had its three Convex hooks and the role hook inline, so
nothing could render it without mocking four boundaries. Split into the `AccessSectionView` pattern
(data half / view half, no visible change) and 14 tests pin the rules: silent on the unruled
majority, count-is-history once ruled, the viewer's own claim acknowledged rather than offered a
no-op button, the note compulsory under `open` with whitespace refused client-side, the gate
message surfaced with the form left open, Clear only when there is something to clear.

The split exposed a real bug: **a failed moderator ruling was silent.** `ruleAs` set an error that
only rendered inside the report form — which a moderator never has open. It now renders beside the
rule buttons, and is pinned.

**3. `cut-granule.sh` said the SCL/NDSI bands are "the bands A06f is built on."** They are A06g's.
One letter.

**4. ⚠ Greptile's P1: a half-written note could be filed against the wrong water body — on both clients.**
Flagged on the new mobile section; the web drawer had the identical shape. Neither client keys its
detail view by body: the `/water/[id]` route re-renders in place when its param changes, and the web
drawer swaps `body` when the map selection moves. The form's note and error lived in component
state, so an explanation started for water body A could be the one submitted against water body B — B's id,
A's sentence, and nothing would look wrong. Both sections now key their stateful half by `body._id`
**themselves** — a wrapper on mobile, `key` on the View in web's data half — so no mount site has
to remember, which is precisely the failure the finding described. The web test renders the real
data half across a rerender from one body to another and asserts the textbox and its sentence are
gone; it was verified to fail without the key.

Greptile's other P2 — *"anonymous reporting dead end"* — was not reachable: both apps are sign-in
gated at the root (`AuthGate` in `__root.tsx`; mobile's `Stack.Protected`), so the drawer never
renders for a signed-out visitor and `myAccessFlags`' `[]`-when-anonymous branch is server-side
courtesy for the map. But the comments said *"no way to report (signed out)"*, which invited exactly
that reading; they now say what `undefined` actually is there — loading. **A comment that describes
an unreachable state is a bug report waiting to be filed.**

**5. A ruling never told the reporters, and never counted — found closing the phase out
(2026-09-16, committed on the A09 branch).** `setPublicAccess` closes a water body's open reports by
patching the rows, and two systems built *after* A06f hang off `moderation.resolveFlag` instead: the
A08 `content_flag_resolved` notification (PR #55) and the Phase 07-2 `flag_dispositions` counter. So a
reporter the drawer had told *"it's with the moderators"* never heard the verdict — their fade
flipped silently, and for an `open` ruling that is their claim dismissed without a word — and the
control-room chart read zero upheld / zero dismissed for `no_public_access` forever. Now one
`lib/flagResolution.closeFlag` (status + metric + notification) that both paths call; the audit row
stays with each caller, because the queue's per-flag row and the ruling's one-per-body row are both
right. Three tests, verified to fail first.

*Left as a founder call:* the A08 copy is verdict-only and target-less — *"A moderator reviewed
something you flagged and left it up"* — because the flagged party is usually a person. Here it is a
water body, so a reason-aware line (*"…your access report on Tomhannock — public access confirmed"*) would
extend A08 §2.3 rather than break it. Not done.

**6. The ordinary verdict reads as a plain fact (founder call, 2026-09-16, from the first live look
at the drawer).** *"A moderator reviewed this on August 25, 2026 and found public access"* dressed
the normal state of a water body in the language of a dispute. `open` now renders **"Accessible to the
public."** — no date, no moderator — and the review register moves to `none`, the only verdict that
costs a reader something: *"A moderator reviewed this on … and found no public access — every
approach crosses private land."* The `open` date is not lost; it lives in the re-report gate, where
"since when" is the question being asked. One core function, both clients. Committed on the A09
branch with finding 5 and deployed to dev the same day.

---

## Test coverage

`packages/core/src/publicAccess.test.ts` (19 tests) pins the pure half: the dim expression's
null-safety, the multiplier, the drawer strings, the `>=` boundary of `disputesReview`.

`packages/convex/convex/publicAccess.test.ts` (24 tests) is organised by the argument above:
*reporting — an unconfirmed claim touches nothing* · *the moderator verdict* · *the re-report gate
under an "open" verdict* · *the queue lane* · *a re-import preserves the ruling AND the demotion*.
The last block is the one that earns its keep — `importCanonical`, `setCuratedBoost` and
`backfillCells` each asserted on `minVisibleZoom`, not on the field's survival — plus the
richness round-trip from Greptile finding 1.

The edit path's photo behaviours (kept ids, explicit empty, omitted) and the weather round trip are
pinned in `reports.test.ts` and `core/reportForm.test.ts`; every review fix was verified to fail
against the pre-fix code first.

`apps/web/src/components/PublicAccessSection.test.tsx` (14 tests, PR #56) covers the web surface —
the three states, reporting, the moderator, and the body key. Mobile has no component-test
convention (its suite is `lib/`-level), so the mobile section is covered by the shared strings in
core and by the same server tests, not by a render.

---

## Where this phase is referenced from

- **D166** ([`01-decisions.md`](../01-decisions.md)) — A06h's discovery dim rides `withAccessDim`.
- [**A06h**](./A06h-weather-detail.md) — the map-dim reuse, and the deferred corpus-lifecycle
  question above.
- [**A07b**](./A07b-corpus-by-request.md) — `NewWaterPrompt` is un-blocked by the server
  `activityId` path this phase built; that phase wires it rather than writing a second one.
- [**A06d**](./A06d-body-access-points.md) — the `accessAlerts` lifecycle this phase is
  deliberately *not*, and the three-edit target-type rule it inherited.
- [**A06e**](./A06e-satellite-imagery.md) — `postedAccess`, the annotate-never-suppress contract
  that made this a separate field.
- **PR #44** — the merged branch, with the A07a-3 wind rose and A06e's posted rules in the same history.
- **PR #56** — this doc, the mobile section, the web test, and the body-key fix (*§The follow-up*).

> One stray reference *was* a mislabel, not a link: `scripts/imagery/cut-granule.sh` said the SCL /
> NDSI bands are *"the bands A06f is built on."* They are the ice-classification bands the roadmap
> defers to **A06g** ([`phases/A06g-imagery-research.md`](../phases/A06g-imagery-research.md)); nothing in
> this phase reads a granule. Corrected in #56 — noted so a future grep for `A06f` that comes up one
> short knows why.


---

## Relocated from the roadmap (2026-09-16)

*The roadmap entry for A06f as it stood before the 2026-09-16 rewrite, kept verbatim so nothing it said is lost. The roadmap now carries a one-paragraph summary; this is the long form.*

**A06f — No public access: a corroborated claim that dims a body.** ✅ **COMPLETE on dev 2026-08-16**
(merged as **#44** with A06e's posted rules; prod deferred) — see
[`phases/A06f-no-public-access.md`](./A06f-no-public-access.md), **written after the fact on
2026-09-14**: the phase was a founder ask taken straight into the A06e branch and shipped with no plan
doc and no D-number. The state that did not exist: `isListed` was binary, so a body was either fully on
the map or gone, and `waterBodies.publicAccess` is the **third state — on the map, and marked**. Three
verdicts with absence as one (`none` dims 50% and demotes ~2 zoom levels; `open` renders nothing and
exists only to gate re-reports). A member's report changes nothing on anyone else's map; others
**corroborate** rather than re-report, the reporter sees their own water body faded, and the queue lane
ranks by how many agree. Corroboration needed no votes table — `contentFlags` already dedups to one
open flag per (flagger, target), so N open rows *is* N people. **This is the A06c §4.2 ladder's first
penalty**, scoped by two arguments (the only attribute that *should* discourage a trip; the only one
contingent on a human ruling) and safe only because `minVisibleZoom` clamps — a demoted body draws
later, never not at all. ⚠ The demotion is *derived*, so six scoring sites must read the verdict or
`importCanonical` silently restores the undemoted zoom while preserving the ruling. Under the same
prefix: the 164-function audit that armed eleven unreachable mutations (put-in placement on the
editor canvas, `remove`/`restore`, shoreline snap), `reports.update`'s first UI with `editedAt` and
provenance-preserving edits, and the You tab's unreported-skates list. **Not built:** a mobile report
control (map dim only) — closed 2026-09-14 alongside this entry.
