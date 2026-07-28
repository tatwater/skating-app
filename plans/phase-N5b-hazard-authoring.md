# N5b — Hazard authoring UX

*Two affordances that make drawing a hazard match how skaters actually describe one. All client work;
no lifecycle, no schema, no decay.*

> **Status:** scoped 2026-07-27, not yet built. Split from the roadmap's old N5 when the seasonal work
> ([N5a](./phase-N5a-seasons.md)) took over that entry's lifecycle half.

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

## The items

### 1. Freeform polygon authoring (Phase 9, founder call 5)

**Schema and render already ship.** `hazards.geometryKind` includes `polygon`, `geometry` accepts one,
`hazardLayer` draws it, `bufferMeters` sizes its uncertainty band, and Phase 9.5's
`clipFootprintToBody` clips it. The only missing piece is the **vertex-dragging editor** — today a
polygon can exist but a skater can't draw one.

- **terra-draw is already in the tree** (N2/D61) — MIT, first-class MapLibre adapter, lazy-loaded in
  its own ~270 kB chunk, currently admin-only for sub-area drawing. This extends it to a skater-facing
  surface, which is the first time a non-admin loads that chunk. **That's the main open question**: the
  chunk is justified for an operator on a laptop and is a real cost on a phone on lake ice.
- **Paste-GeoJSON is the admin break-glass** and stays admin-only; a skater never sees it.
- Type-aware `bufferMeters` defaults already exist (research §4) and shouldn't be re-derived here.

### 2. Shore-band "snap to shoreline" (research §4, deferred twice)

`thin_ice_shore` and `ice_edge` hazards are **linear along the shore**. Drawing one by hand means
tracing a shoreline that the app already knows exactly — `waterBodies.polygon` *is* that line.

- The affordance: pick two points near the shore, and the hazard's geometry becomes the **section of
  the body's boundary ring between them**, buffered by the type-aware `bufferMeters`.
- Geometrically this is a boundary-substring extraction — find the nearest vertex on the ring to each
  tap, take the shorter arc between them. Turf has the pieces; the fiddly part is multi-ring polygons
  (islands) and MultiPolygon bodies, where "the boundary" is several rings and the two taps might land
  on different ones. **Refuse rather than guess** when they do, in the same spirit as N2's clip-refusal
  threshold.
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

1. Plans — this doc.
2. Polygon vertex editor: extend the terra-draw wrapper to the skater hazard form, web + mobile, behind
   the same lazy chunk boundary.
3. Snap-to-shoreline: the boundary-substring helper in `@skating/core` (pure, property-testable against
   real body polygons), then the two-tap affordance in both clients.

## Open questions

- **Is a 270 kB draw chunk acceptable on a phone?** It's the one real cost here. Options if not:
  a lighter mobile-only path (tap-to-place vertices without the full engine), or polygon authoring
  staying web-only at first. Worth deciding before building rather than after measuring.
- **Does snap-to-shoreline need the N1 cell index?** The two taps are already inside a known body — the
  hazard form knows its `waterBodyId` — so probably not; the ring comes straight off that body's
  polygon. Confirm at first use.
- **How is a snapped shore band edited afterwards?** If it's a derived geometry, is it re-derived on
  edit or does it become an ordinary polygon the vertex editor can push around? Leaning the latter —
  one geometry type downstream, snapping is an input convenience, not a stored relationship.
- ~~**Whether ridge hinting is even the right v2.**~~ **Answered 2026-07-27** — it wasn't. The
  alternative reading (several markers along one ridge, rather than a hint about where to put one) is
  what the founder wanted, and it turned out to be a lifecycle change rather than an authoring one. The
  question was worth writing down: it moved an item to a different phase instead of being discovered
  mid-build.
