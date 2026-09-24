# Late-season reveal — the second window, and whether the app can point at it

> **Backlog — 2026-09-21, from a group leader's seasonal journal (design input only, no post
> text beyond the two lines the founder quoted).** An idea to keep, not a phase. Touches the season
> docs, the weather panel on the body page, and the thickness signal — none of which changes yet.

---

## What the journal says

Two things about the shape of a season that nothing in the app currently models:

1. **The season has a pre-season.** It opened October 29 on Lakes of the Clouds and Eagle Lake —
   alpine tarns, two hours and a lot of elevation from a road — with Kinsman Pond in early
   November. For everyone else the opener was December 1 at Low Plains in Elkins: shallow, marshy,
   a mile around, two minutes from the lot. The imagery season already keys on the summit
   (`imageryIngest.ts`, D149); the *skating* season the journal describes has three rungs.
2. **The end of the season holds a flurry.** Snow buries the ice for most of the winter; then,
   before spring, rain or warmth strips the snow and reveals ice "more than a foot thick in many
   places." The writer calls a week or more of late-season skating "virtually guaranteed," with a
   personal record of April 24 and late March / early April a distinct possibility.

## The idea

When a body's thickness evidence says the ice was ≥ 1 ft (~30 cm) *before* a warm spell — and the
weather since (`docs/weather-since.md`: `thawDegreeHours`, `rainMm`, a snow-cover drop) says the
snow is coming off — the ice underneath is very likely still there, and the surface is about to be
the best of the year. The weather section of the body page could say so, and the discovery surfaces
could rank it.

**What it would need**, roughly, and why none of it is quick:

- A thickness observation with a date on it, from a report or a measurement (Phase 08's capture
  shapes, the A10 report form) — the ≥ 1 ft premise has to come from someone who drilled, not a
  freezing-degree-day model.
- A snow-cover signal. Open-Meteo's `snow_depth` is a model field, not an observation; the imagery
  path (`reading-ice-from-orbit.md`) sees bare ice vs snow directly but only when a frame lands.
- A phrasing that stays inside D3. *"Ice was reported at 14 in on Mar 3; 22 mm of rain since and no
  snow on the model"* is a fact list. *"Late-season ice is clearing"* is a prediction, and the app
  never predicts. The signal is worth surfacing as **"worth a look"**, never as "skateable."
- The close gate is not in the way: `thawClose` needs ten straight frost-free nights across every
  sampled site before it ends the imagery season, which a March thaw does not deliver. Worth
  re-checking with a real season's `imageryIngestSeasons` row before trusting it, since the
  late-season window is exactly when an early close would cost the most.

## Where the pre-season rung lands now

The alpine trio belong on the season watcher's roster (Eagle Lake and Kinsman Pond alongside the
Lakes of the Clouds sentinel — see `imageryIngest.ts`) and on the curated boost list
(`scripts/seed-destinations/destinations.nh-gaps.json`). Low Plains is the unnamed NHD row
`wb_f419b737-6a46-42ec-b51f-5d30cc9226b6` south of Elkins village — 8 ha, 1.7 km of shoreline,
which is the journal's "almost a mile in circumference" — and needs a name before anything can
find it.
