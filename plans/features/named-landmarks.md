# Named landmarks — the points skaters steer by, as map labels and as a `where`

> **Feature — scoped 2026-09-20, scheduled with A10-2.** Two founder observations, the same day:
> *"a bay is a sub-area only when skaters go there and mostly skate the bay; otherwise it's a
> reference point, like an island or a peninsula, used for directions or to say where a hazard is
> — a map label, not a sub-area"*; and, on "Inner Bay": *"inner / outer are a sort of cardinal
> direction, not a proper noun"* (that half became the D193 amendment — `head` / `mouth` sectors).
> This doc is the label half. A10's §Later item "named-landmark ETL" moves here. Delete when it
> ships; the record is the register row and D202.

## What the corpus says

The LLM mention inventory ([`research/report-corpus-classification.md`](../research/report-corpus-classification.md))
found **194 named places of kind `other`** — islands (Apple, Cedar, Savage, Knight, Ball, Providence,
Valcour), points and headlands (Shelburne Point, Mallett's Head, Willsboro Point, Carleton's
Prize), beaches and launches (Leavitt Beach, Charlotte Town Beach, Leddy Beach, Basin Harbor),
narrows ("the gut"), and stores skaters meet at (Hero's Welcome) — plus **23 bays named as reference
points rather than skated** (Missisquoi, Kingsland, Willsboro, Whallons, Spaulding…). Half of all
reports locate something, and a large share of those locate it by one of these names: *"off
Apple Island"*, *"between Bear Island and Jolly Island"*, *"from Leavitt Beach"*, *"a wind hole
west of the bird poop rock"*. None of them is on our map, and the `where` union (D193) reserves
`point(coord, radius, name?)` for exactly them.

## The feature

**A `bodyLandmarks` table** — `waterBodyId`, `name`, `kind` (`island | point | beach | narrows |
bay_reference | marina | other`), `point`, optional `subAreaId` (the bay it sits in, stamped by the
A09 rule), `source` (`osm | gnis | corpus | moderator`), `externalId`, `aliases[]`, and the
corpus's `messages` count as a prominence hint. Bounded per body; read with the body's hazards and
put-ins (the reads the drawer already makes), never viewport-wide.

**Three producers, in this order:**

1. **ETL from OSM + GNIS** over the corpus footprint: `place=islet | island`, `natural=cape |
   peninsula | beach | strait`, named `natural=bay` *nodes* (the ones with no polygon — a bay
   polygon is a sub-area, a bay node is a landmark), GNIS bay / gut / island / cape points. Same
   `scripts/etl` shape as bays: extract, match to a parent body by containment or shoreline
   distance, load with a campaign id, dry by default.
2. **The corpus inventory** as a name-and-alias source: a landmark the ETL found gets the
   community's spelling as an alias ("bird poop rock" will not be in GNIS; a moderator adds it).
3. **A moderator** on the admin body page — drop a point, name it, pick a kind. Same map as the
   chord editor ([`subarea-chord-editor.md`](./subarea-chord-editor.md)).

**Two consumers:**

- **Map labels** — a label layer per body at bay zoom and closer, prominence from `messages`
  and kind so Apple Island draws before an unnamed islet. Labels are text on the map, never
  markers with affordances: a landmark has no page, no favorite, no reports.
- **`where: point(name)`** in A10's sheet and extraction (D193): a located chip or reading can say
  "off Shelburne Point"; the sheet offers the body's landmarks as tappable options after the bays
  and sectors, and Stage B's `choice` over `where` includes them. A hazard placed "near the word
  lake on my screenshot" becomes a hazard placed near a named point.

## Not in this feature

- Landmarks as places (favorites, feeds, bounties) — that is what a sub-area is; the founder's
  rule draws the line.
- Put-ins and lots — A06d owns those; a beach that is also a launch is a put-in with a landmark
  name, not two rows.
- Rivers as named reaches (D4).

## Decision to mint at build

**D202 — A place skaters steer by but do not skate as a destination is a landmark: a labeled point,
never a sub-area.** The corpus's skated-message count is the test (≥ 2 → sub-area candidate); a
moderator can promote a landmark to a sub-area with the chord tool when its reports show it earned
one.
