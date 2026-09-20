# Sub-areas by chord — two shoreline points, a side, and an arc

> **Feature — scoped 2026-09-20, scheduled ahead of A10-3.** Founder call, out of the A10 corpus
> seed: 39 community-named bays exist only as a point, and an attempt to draw them from that point
> automatically found a genuine mouth on 1 of 39 (the record is in
> [`backlog/corpus-catalog-gaps.md`](../backlog/corpus-catalog-gaps.md) § 1). The construction was
> right — the coastline exact, a straight chord across the mouth — but the mouth is a human
> judgment, and it is a ten-second one. *"This should be how all sub-areas are defined: a line
> between two shoreline points, pick a side, turn the line into an arc if need be — and bring it to
> the admin water body page so any moderator can chop a body into sub-areas."* Delete this doc when
> it ships; its record is the roadmap register row and the decision below.

## What exists

- **A02's editor** (web, admin-only, terra-draw): a moderator draws a free polygon; the write
  clips it to the parent (A02 Decision 10, `clipSubAreaToParent`) and refuses only a draw that is
  mostly off the water. Every bay on dev was either an OSM `natural=bay` polygon (A07a) or drawn
  this way. Redrawing re-stamps everything inside (`restampParent`, A09).
- **A09's mouth line** as a *concept*: the admin card counts this season's skates that ran past the
  bay's seaward edge (`leftSubArea`), against an edge that is whatever the polygon happens to have
  there. Nothing stores a mouth line.
- **The construction, tested** in `training_data/google_group/seed/bays/candidates.py` (stdlib
  Python, 21 tests on a synthetic notched lake): given two points A and B on the parent's outer
  ring, walk the ring from A to B on the side containing a chosen interior point, close with the
  chord B→A, clip to the parent so islands fall out.

## The feature

**One drawing tool, three gestures, for every sub-area.**

1. **Two clicks on the shoreline.** The cursor snaps to the parent's outline (the outer ring, or an
   island's ring — an island bay's "shore" is the island, which is what defeated the automation on
   Keeler, Carry, City and Holcomb). Snap distance is generous; the click never lands in water.
2. **Pick the side.** The tool shades both candidate regions faintly; the moderator clicks the one
   that is the bay. Default: the smaller side, which is right for every bay and wrong only for
   "everything but this bay," which nobody draws.
3. **Bow the chord** (optional). Drag the chord's midpoint to turn it into a circular arc of that
   sagitta — outward to take in the open water skaters treat as the bay's, inward to exclude it. A
   later drag adjusts; the arc is what A09's "skated past the mouth" evidence is about.

Storage: the sub-area row gains `mouth: { a: latLng, b: latLng, sagittaM: number }` next to the
polygon it produced; the polygon stays the stored geometry every reader uses (nothing downstream
changes), and the mouth is what the editor re-opens with and what A09's admin card reasons from.
A polygon drawn the old free way has no `mouth` and edits as before — the two tools coexist; the
chord tool is the default for a new sub-area.

**Where it lives:** the admin water body page's map (A06c's `/admin` body view already carries
drawing, pin-dropping, hazard moderation and track review together — A02 § *one map, one shell*).
A **queue** beside the map lists the corpus bays not yet drawn, each centered on its GNIS/OSM
point with the community's message and skated counts, so the moderator works down the list:
click, click, side, done. Sixteen destination bays are the first queue (below).

**Mobile:** none. Sub-areas are moderator work on a wide screen (A02 Decision 2).

## Geometry, in core

`packages/core/src/subAreaChord.ts` — a port of the tested construction:

- `chordSubArea(parent, a, b, side, sagittaM)` → the polygon: ring walk on whichever ring `a` and
  `b` snap to (both must be on the same ring — a chord between the mainland and an island is
  refused with a message, since the region it encloses is not a bay), closed by the chord or the
  arc, clipped to the parent through the existing `clipSubAreaToParent`.
- `snapToOutline(parent, p)` → the nearest point on any ring plus which ring, reusing
  `lakeGeometry`'s nearest-vertex helpers.
- `fast-check` properties: the result lies inside the parent; the two sides partition the ring's
  enclosed area; swapping `a` and `b` gives the same polygon; a zero sagitta is the straight chord
  and the area is monotone in sagitta.

The write is `subAreas.createFromChord` / `updateChord` — thin over `insertSubArea` /
`rederiveSubArea`, which already mint the key, derive the fetch profile, invalidate depth on an
outline change and restamp cells. The mouth is stored beside the polygon; no reader changes.

## The first queue — sixteen destination bays

From the corpus (skated in ≥ 2 messages): Northwest Bay, Button Bay, Dog Cove (Squam), Wolfeboro
Bay, Keeler Bay, Maquam Bay, Dillenbeck Bay, Carry Bay, Stevenson Bay, St. Albans Bay, Holcomb
Bay, City Bay, Silver Bay (George), Fishers Bay (Sunapee), Huddle Bay (George), Herrick Cove
(Sunapee). The other 23 point-only bays are **reference points, not destinations** (Missisquoi Bay
is named in 7 messages and skated in 1) — they become map labels through
[`named-landmarks.md`](./named-landmarks.md), not sub-areas. The founder's rule: *a bay is a
sub-area only when skaters go to the bay and mostly skate the bay; otherwise it is a reference
point, like an island.*

## Not in this feature

- Automatic mouth finding — tried, 1 of 39, retired.
- Non-shoreline sub-areas (a reach of open water bounded by two chords, "the Broads") — the same
  tool run twice, one region minus another; a follow-on if the Broads on Sunapee and Winnipesaukee
  earn it.
- Anything on mobile.

## Decision to mint at build

**D201 — A sub-area is two shoreline points, a side, and a sagitta; the polygon is derived.** The
free-draw tool stays for the shapes a chord cannot say, but the chord is the default and the stored
`mouth` is the fact the editor and the A09 evidence share.
