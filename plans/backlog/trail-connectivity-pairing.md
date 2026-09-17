# Trail-connectivity pairing — the principled way to widen the parking radius

> **Backlog — moved out of `07-roadmap.md` in the 2026-09-16 rewrite, verbatim.** Sized 2026-08-14 as an A06d follow-up (~6% yield); the trail pass itself later shipped inside A06e Workstream 0 with 69 pairings, which confirmed the yield estimate. Kept because the sizing argument still governs whether to widen it.

**1. Trail-connectivity pairing — the principled way to widen the parking radius. ⚖ Small phase,
~6% yield.** A lot at the end of a `highway=path` that leads to a water body *is* a trailhead; that is a
signal rather than a radius, and it would find the mile-in case the 250 m inference cap cannot.

- **De-risked:** OSM way connectivity **survives the GeoJSON export** — 29% of endpoints in Vermont's
  40,840 trail ways are shared by 2+ ways as byte-identical coordinates, so the graph builds from a
  coordinate hash. No node-ref extraction, no pyosmium.
- **Capped:** a connection needs *both* ends on a trail, and only **6% of unpaired put-ins (27 of 416
  in VT)** have a trail within 50 m. The lot side is fine at 31%; the launch side is the ceiling.
  Extrapolates to **~150–300 new pairings across five states**, against 1,351 already found.
- **Cost:** ~600–900k line geometries (VT alone is 642k vertices, so memory wants streaming), a
  coordinate-hashed graph, a budget-bounded BFS with property tests for cycles and disconnection.
- **Why not yet:** the case is already served twice — `setOfficialParking` accepts a human's
  association at any distance (D72 amendment), and 840 lots already survived the gate on the pairing
  bypass. See [`phase-A06d`](../phases/A06d-body-access-points.md) *§Sized 2026-08-14*.
