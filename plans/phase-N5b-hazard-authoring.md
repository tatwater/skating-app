# N5b — Hazard authoring UX

*Two affordances that make drawing a hazard match how skaters actually describe one. All client work;
no lifecycle, no schema, no decay.*

> **Status: ✅ COMPLETE 2026-07-29** — built, every suite green (core 978 · convex 787 · web 219 ·
> mobile 79). **Not deployed and not device-tested**; prod deferred, as every phase since 2.5.
> Decision **D67** is written into [`01-decisions.md`](./01-decisions.md). Split from the roadmap's
> old N5 when the seasonal work ([N5a](./phase-N5a-seasons.md)) took over that entry's lifecycle half.
>
> Four of this doc's premises were checked against code at kickoff and **two of them were false** —
> see *§What the build found in the plan*, the five founder calls in *§Decisions taken at kickoff*
> that replaced this doc's open questions, and *§What the build found in itself* for the one bug the
> build introduced and caught.

## Why this is its own pass

The old N5 bundled five things under "hazard authoring & confirmation polish". Two of them —
the "this never existed" verdict and naming confirmers — touch `deriveHazardLifecycle` and the
confirmation loop, which is the same code a seasonal reset touches, so they went with N5a.

What remains shares nothing with that: **geometry and input**, entirely on the client, with no server
behavior change at all. Keeping them separate isn't tidiness. N5a's risky half is a visibility change to
safety content, and the review attention that deserves shouldn't be split with a vertex-dragging editor.

They belong together because they're one pass over the same surface — the hazard draw flow on web and
mobile — and because each is small enough that visiting that surface twice would cost more than the work.

*A third item started here and left:* ridge-crossing hinting turned out to be a lifecycle change, not an
authoring one, and moved to N5a. See below — it's recorded rather than deleted because the reason it
moved is the same rule that keeps this pass small.

---

## What the build found in the plan

Checked against code at kickoff (2026-07-28), same discipline N1/N2/N3 applied to their roadmap
entries. Four corrections, each verified against a file.

1. **`thin_ice_shore` and `ice_edge` are not hazard types.** Item 2 opens by naming them.
   `HAZARD_TYPES` (`packages/core/src/types.ts:110`) has sixteen values and neither is among them —
   research §4 uses *"thin ice along the shore"* and *"ice edge"* as English descriptions of a
   **shape**, and this plan read prose as identifiers. It matters because this doc's own rule is *"No
   new hazard types. The vocabulary is settled (D51/D52)"*, so as written the snap affordance had
   nothing to attach to. Settled by **Decision 1**.

2. **terra-draw cannot run on mobile at all**, which makes the work breakdown's *"web + mobile,
   behind the same lazy chunk boundary"* unbuildable and the headline open question unanswerable as
   posed. Mobile's map is `@maplibre/maplibre-react-native` — a native module; every terra-draw
   adapter, including the `terra-draw-maplibre-gl-adapter` we already depend on, targets
   `maplibre-gl`, the DOM/WebGL library. There is no React Native adapter. *"Is a 270 kB draw chunk
   acceptable on a phone?"* has no answer because the chunk can never reach a phone. The real
   question was **web-vs-mobile mechanism**, and separately whether the skater path needs vertex
   dragging at all. Settled by **Decision 2**.

3. **The "lighter mobile-only path" this doc lists as a *fallback* already ships, on both clients.**
   *"Tap-to-place vertices without the full engine"* is a precise description of the polyline trace
   built in Phase 9: `hazardDropMode` + `applyDraftMapClick` + an Undo/Done bar
   (`MapView.tsx:503` web, `MapView.tsx:367` mobile). Polygon authoring on that path is the same
   flow plus a close-the-ring step. So the fallback was never a fallback — it's the mobile plan of
   record, and the only thing terra-draw adds over it is vertex *dragging*, which is the specific
   reason D51 deferred polygons in the first place.

4. **"All client work, no lifecycle or schema changes" is right about schema and wrong about
   scope.** No table or column changes — `HAZARD_GEOMETRY_KINDS` already carries `polygon`
   (`lib/enums.ts:121`) and the server already accepts it. But two non-client pieces are
   unavoidable:
   - `HazardDraft` is a **two-variant union** (`'point_radius' | 'line'`), and every transition —
     `switchDraftKind`, `retypeDraft`, `resizeDraft`, `undoDraftPlacement`, `draftVertices`,
     `draftToShape` — is written against exactly those two. A third kind is `@skating/core` work,
     and it is the larger half of item 1.
   - `isValidHazardShape`'s `polygon` branch (`hazardGeometry.ts:362`) validates **only the first
     ring** — and for a MultiPolygon, only the first polygon's first ring. `HAZARD_MAX_VERTICES` is
     applied per-ring rather than in total, and nothing checks self-intersection. That gate is dead
     code today because no client can author a polygon; this pass makes it the thing standing
     between a scripted client and a footprint the on-ice evaluator buffers on every GPS fix.
     Hardening it belongs in the same commit that makes polygons reachable.

*Two things this doc got right that are worth recording as confirmed rather than assumed:* snap
does **not** need the N1 cell index (`waterBodies.get` returns the full doc including `polygon`, and
both clients' viewport sources already ship polygons), and there is **no hazard edit mutation** —
`hazards.ts` exposes `create`, `listForBody`, `get`, `listPromotionCandidates`, `listBundleCandidates`
and nothing that mutates geometry. So *"how is a snapped shore band edited afterwards?"* was only ever
a question about editing the **draft**, before it is posted.

---

## Decisions taken at kickoff (2026-07-28)

**Decision 1 — Snap-to-shoreline is offered for `thin_ice` and `open_water`.**
The two existing types that are genuinely linear-along-shore: rotten shore ice, and a lead running
along the ice edge. This is the vocabulary research §4 was describing when it wrote "thin ice along
the shore" and "ice edge" — no new type is minted, per this doc's own rule. *Considered and
rejected:* offering it for every line-capable type (shore-snapping a mid-lake pressure ridge is
meaningless), and adding `wet_crack` / `overflow_slush` / `shell_area` (all *occur* near shore, but
none is shore-*shaped* the way these two are — the affordance would be offering the wrong geometry).

**Decision 2 — terra-draw on web, tap-to-place-a-ring on mobile.**
Web skaters get real vertex dragging and terra-draw's self-intersection handling, which is what D51
said polygon authoring needs; mobile gets close-the-ring on the trace flow that already ships. The
price is explicit and accepted: **two authoring UXs for one primitive**, and the ~270 kB draw chunk
now loads on a skater-facing web route rather than an admin one. It stays lazy — nothing is added to
the main bundle, and the chunk is fetched only when a skater actually arms polygon drawing, which is
the opt-in/advanced path D51 always described. *Considered and rejected:* tap-to-place on both (one
code path, but web then has no dragging either, which is most of what makes a freeform polygon worth
authoring); web-only (the skater standing on the ice is the person best placed to describe a zone).

**Decision 3 — A snapped shore band is stored as a `polygon`, with `bufferMeters` meaning exactly
what it means on any other polygon.**
The geometry is the shore arc buffered by the band half-width; `bufferMeters` is then the type-aware
uncertainty halo, applied by `hazardFootprint` the same way it is for a hand-drawn zone. One rule for
all polygons, no special case downstream — which is what *"snapping is an input convenience, not a
stored relationship"* has to mean if it means anything.

The obvious objection — a halo around a shore band spills onto land — **is already solved and needed
no new code.** Phase 9.5's `clipFootprintToBody` runs at insert (`hazards.ts:181`), intersects the
buffered footprint with the body polygon, and stores the clipped result; the map layer draws it and
`distanceToHazard` measures against it. A shore band is the exact case that clip was written for, so
the landward half of the band and the landward half of its halo are both confined to the ice
automatically. Buffering the arc symmetrically and letting the clip cut it is deliberately simpler
than a one-sided offset, and reuses proven code rather than inventing a second way to be near a
shoreline. *Considered and rejected:* storing it as a `line` with `bufferMeters` doing all the
widening (the plan's original wording — it reuses more machinery and ships independently of polygon
authoring, but leaves two geometry kinds downstream for one affordance).

**Only one size stepper is ever on screen.** While snapping it tunes the **band half-width** and
re-derives the ring live; on a hand-drawn polygon it tunes `bufferMeters`. Two widths exist in the
model, never in the UI at the same time.

**Decision 4 — The shorter arc is the default, with a "go the other way" control.**
Two taps on a ring define two arcs, and "shorter" is right almost always and silently wrong on a
small pond or a narrow bay where the band a skater means is most of the perimeter. One explicit
control beats inferring intent — and inferring it from the map centre, the tempting alternative, is
unpredictable in precisely the cases that need predicting. **Taps landing on different rings are
refused rather than guessed** (islands, MultiPolygon bodies), in the same spirit as N2's
clip-refusal threshold.

**Decision 5 — Polygon stays opt-in and no type defaults to it.**
`HAZARD_DEFAULT_GEOMETRY_KIND` gains no `polygon` entry. A polygon is reached only by switching an
existing draft to it, exactly as D51 specified ("opt-in, de-emphasized advanced affordance, not
offered by default"). On mobile this also preserves D51's governing on-ice rule — **the hazard is
committable after two taps** — since a polygon needs at least three taps plus a close, and every type
still starts as a circle at the skater's GPS.

---

## The items

### 1. Freeform polygon authoring (Phase 9, founder call 5)

**Schema and render already ship.** `hazards.geometryKind` includes `polygon`, `geometry` accepts one,
`hazardLayer` draws it, `bufferMeters` sizes its uncertainty band, and Phase 9.5's
`clipFootprintToBody` clips it. The only missing piece is the **vertex-dragging editor** — today a
polygon can exist but a skater can't draw one.

- **terra-draw is already in the tree** (N2/D61) — MIT, first-class MapLibre adapter, lazy-loaded in
  its own ~270 kB chunk, currently admin-only for sub-area drawing. This extends it to a skater-facing
  surface, which is the first time a non-admin loads that chunk. **Accepted at kickoff** (Decision 2),
  *web only* — the chunk cannot reach mobile at all, because terra-draw has no React Native adapter
  (*§What the build found* item 2). Mobile closes a ring on the tap-to-place flow that already ships.
- **Paste-GeoJSON is the admin break-glass** and stays admin-only; a skater never sees it.
- Type-aware `bufferMeters` defaults already exist (research §4) and shouldn't be re-derived here.
- No type *defaults* to polygon (Decision 5) — it is reached only by switching a draft to it.

### 2. Shore-band "snap to shoreline" (research §4, deferred twice)

`thin_ice` and `open_water` hazards along a shore are **linear along the shore** — rotten shore ice,
and a lead running along the ice edge. (This doc originally named `thin_ice_shore` and `ice_edge`,
which are not hazard types; see *§What the build found* item 1 and Decision 1.) Drawing one by hand
means tracing a shoreline that the app already knows exactly — `waterBodies.polygon` *is* that line.

- The affordance: pick two points near the shore, and the hazard's geometry becomes the **section of
  the body's boundary ring between them**, buffered by the band half-width, stored as a `polygon`
  whose `bufferMeters` is the ordinary type-aware halo (Decision 3).
- Geometrically this is a boundary-substring extraction — find the nearest vertex on the ring to each
  tap, take the shorter arc between them, with an explicit **"go the other way"** control for when
  shorter is the wrong answer (Decision 4). Turf has the pieces; the fiddly part is multi-ring
  polygons (islands) and MultiPolygon bodies, where "the boundary" is several rings and the two taps
  might land on different ones. **Refuse rather than guess** when they do, in the same spirit as N2's
  clip-refusal threshold.
- Deferred from Phase 9 (*"log, don't build in v1"*) and again from Phase 10 (*"it's a geometry/UX
  feature, not a weather one"*). This is the pass it was being deferred to.

### ~~3. Ridge-crossing "switch sides" hinting~~ → moved to N5a (2026-07-27)

This was the weakest item here, and the founder's answer dissolved it rather than sharpening it.

The research (§8) framed v2 as *hinting* — suggesting where along a drawn ridge a crossing might be,
from lakeice's "best prospects are where the overlap switches sides". The founder's version is
different and better: **let skaters mark several suggested crossings per ridge and downvote them when
they stop working**, with crossings decaying *faster* than hazards and needing *more* corroboration to
survive.

That's not an authoring affordance. It's a lifecycle inversion — a passage marker where absence of
evidence must **kill** the pin rather than keep it alive — and it lands in `deriveHazardLifecycle`,
`HAZARD_DECAY` and the confirm loop. This doc's own rule says anything touching those is in the wrong
phase, so it goes to [N5a](./phase-N5a-seasons.md) as **D64**.

What's left here is two items, which is a better-shaped pass: both are pure geometry, both are
finishable, and neither needs a research answer first.

## What this pass must not do

- **No lifecycle changes.** Decay, archival, confirmation verdicts and the `bodyFeatures` promotion
  path all belong to N5a. If something here wants to touch `deriveHazardLifecycle`, it's in the wrong
  phase.
- **No new hazard types.** The vocabulary is settled (D51/D52); this is about drawing the ones we have.
- **No safety copy changes.** D3's never-assert-safety framing is already written and tested, and the
  `ridge_crossing` verdict copy is being revised by N5a (D64) — touching it here would collide.

## Work breakdown

Committed in this order; one PR at the end (per the phase convention).

1. **Plans** — this doc: the four corrections and the five kickoff decisions, on record before the code.
2. **`@skating/core` — the polygon draft.** A third `HazardDraft` variant and every transition
   extended to it (`switchDraftKind`, `retypeDraft`, `resizeDraft`, `undoDraftPlacement`,
   `draftVertices`, `draftToShape`), plus the `isValidHazardShape` polygon hardening *§What the build
   found* item 4 names: every ring on every part, a total vertex cap, and a self-intersection check.
3. **`@skating/core` — the shore band.** `shoreBand.ts`: nearest-vertex-on-ring resolution, the
   boundary-substring extraction with both arcs, the multi-ring refusal, and the band derivation.
   Property-tested against real body polygons.
4. **Web — polygon authoring.** terra-draw on the skater hazard form, lazily, reusing the N2 control
   shape rather than a second wrapper.
5. **Web — snap-to-shoreline**, the two-tap affordance plus the "go the other way" control.
6. **Mobile — polygon authoring and snap**, both on the existing tap-to-place flow.
7. **Docs** — roadmap N5b struck with a pointer; the decision-log entry; `06-data-model.md` if
   anything about the stored shape needs saying.

## Open questions

- ~~**Is a 270 kB draw chunk acceptable on a phone?**~~ **Dissolved 2026-07-28.** The question had no
  answer: terra-draw has no React Native adapter, so the chunk cannot reach a phone at all
  (*§What the build found* item 2). What was really being asked — which mechanism on which client —
  is Decision 2: terra-draw on web (chunk accepted, still lazy), tap-to-place on mobile.
- ~~**Does snap-to-shoreline need the N1 cell index?**~~ **No, confirmed at kickoff.**
  `waterBodies.get` returns the full document including `polygon`, and both clients' viewport sources
  already carry polygons for rendering. The ring comes straight off the body the form already knows.
- ~~**How is a snapped shore band edited afterwards?**~~ **Answered by Decision 3, and the question
  was narrower than it looked**: there is no hazard edit mutation, so "afterwards" only ever meant
  *before posting*. A snapped band is an ordinary polygon draft from the moment it is derived — the
  vertex editor can push it around on web, and re-snapping replaces it on mobile.
- ~~**Whether ridge hinting is even the right v2.**~~ **Answered 2026-07-27** — it wasn't. The
  alternative reading (several markers along one ridge, rather than a hint about where to put one) is
  what the founder wanted, and it turned out to be a lifecycle change rather than an authoring one. The
  question was worth writing down: it moved an item to a different phase instead of being discovered
  mid-build.

---

## What the build found in itself (2026-07-29)

**"Adjust corners" on a snapped band was collecting a third shore tap.** Both clients route map
clicks through one handler, and snap-to-shoreline has to take them first — it's a two-tap affordance
and the form is hidden for both taps, so nothing else can count them. Which meant the button that says
*adjust the ring* was, on both platforms, quietly re-picking the shore instead.

The fix is different per client, and the difference is the honest one:

- **Web** hands the band to the vertex editor and **clears the snap**. That is Decision 3 taken
  seriously rather than only stated — snapping is an input convenience, not a stored relationship, so
  the moment a corner moves the shoreline is no longer what defines the shape. The copy says so, and
  the width control changes meaning with it (band half-width → margin around an ordinary area).
- **Mobile** offers **Re-pick** instead. Adjusting corners means vertex dragging, vertex dragging
  means terra-draw, and terra-draw cannot run on a native map — so "adjust" there would have meant
  re-tapping the entire ring. Two ends is the cheap version, and the label had to stop promising the
  other thing.

**Two smaller calls worth recording.** A snapped band's polygon comes from the **offline body cache**
on mobile, not `waterBodies.get` — the skater this is for is standing on the lake, and on the lake
there is frequently no signal; the cache already writes every viewed body's polygon, which on arrival
is the one under their feet. And the shore arc is **simplified** before buffering, with a tolerance
starting at half the band's own half-width: a real shoreline is arbitrarily detailed, and detail
finer than the uncertainty a hazard has already declared is precision it doesn't have, paid for out of
`HAZARD_MAX_VERTICES`.

## Testing (D40)

- **`@skating/core`** — property tests for the shore band (any two taps on a real ring either refuse
  or produce a shape `isValidHazardShape` accepts; the two arcs partition the ring; a dense shoreline
  simplifies until the band fits the vertex cap) and for `ringSelfIntersects` (a convex ring of any
  size is never self-intersecting) and `simplifyPath` (endpoints always kept, never grows). Unit tests
  for every refusal, for the polygon draft's transitions, and — the one that would have caught this
  plan's opening mistake — that `SHORE_BAND_TYPES` names only values that exist in `HAZARD_TYPES`.
- **Web** — the three-way primitive picker, an area's postability at three corners, the snapped band's
  shoreline length and "other way round" control, that the stepper reads as *distance out from shore*
  while snapped, and that a refusal renders where the affordance is with the other two primitives
  still offered beside it.
- **Mobile** — no component tests, per the existing suite's lib-only pattern; the shared authoring
  rules are covered once in `@skating/core`, which is why they live there.
- **Not covered, deliberately:** terra-draw itself. The wrapper pins how this app drives the engine;
  that MapLibre renders a draggable vertex is the library's own test suite's job.

## Left undone

- **Neither client has been run.** Built and green, not deployed to dev and not device-tested — the
  mobile half in particular has an on-ice flow that only a device can judge.
- **The chunk cost is asserted, not measured in situ.** 218 kB is the built asset on disk; what a
  phone on lake ice actually pays for it over a marginal connection is the thing the founder call
  accepted on reasoning, and it is worth measuring once there's a real session to measure.
