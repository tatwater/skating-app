# Named landmarks — the points skaters steer by, as map labels and as a `where`

> **Feature — scoped 2026-09-20, scheduled with A10-2.** Two founder observations, the same day:
> *"a bay is a sub-area only when skaters go there and mostly skate the bay; otherwise it's a
> reference point, like an island or a peninsula, used for directions or to say where a hazard is
> — a map label, not a sub-area"*; and, on "Inner Bay": *"inner / outer are a sort of cardinal
> direction, not a proper noun"* (that half became the D193 amendment — `head` / `mouth` sectors).
> This doc is the label half. A10's §Later item "named-landmark ETL" moves here. Delete when it
> ships; the record is the register row and D202.
>
> **Building 2026-09-29, in two PRs stacked on A10-9 (#82):** the data, the labels and the
> moderator's card first; the sheet, skater proposals and extraction second. Founder calls at
> kickoff are under *Kickoff calls*; what the first PR built and found is under *Built*.

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
   chord editor (D201, shipped).

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

## Kickoff calls (founder, 2026-09-29)

- **The kinds to cover, on as many bodies as possible:** named beaches, islands, peninsulas,
  bridges, marinas, channels and rivers (inlets, outlets, passthroughs), towns and villages,
  lighthouses — and the "murkier" shore owners: camps, campgrounds, hotels, resorts, restaurants.
  The build added dams (a reservoir's reference point) and named rocks, reefs and shoals (GNIS
  `Bar` / `Pillar`, OSM `natural=rock`).
- **Businesses by how long they last, not only by whether they stand alone:** a camp, campground,
  resort or hotel is always a landmark; a restaurant, café, bar or general store only when no other
  named business is within 250 m (a row of five is a street). A store skaters meet at that OSM
  lacks ("Hero's Welcome") comes from a moderator or a skater's proposal.
- **Every listed body, not only the corpus's** — but only landmarks on or beside a body we carry;
  the matching is the filter that makes the volume sane.
- **Labels by size and loneliness:** a name appears when its footprint draws big enough, or when its
  prominence earns it, and where names crowd the important ones win; put-ins outrank labels at
  whole-lake scale. Prominence from the corpus now and from reports as they come. A tap near a
  known landmark takes its name.
- **Selected-body only, for now.** Labels, contours and markers appearing on zoom without a
  selection — perhaps by auto-selecting the lake a skater has zoomed to — is a design question for
  later (deferred register).
- **Skaters propose landmarks** — "bird poop rock" is in no catalog, and if skaters steer by it,
  it belongs on the map. A seventh request kind, `name_landmark`, like `name_bay` (D201).

## Built

**PR 1 — the table, the ETL, the labels, the moderator's card.**

- `bodyLandmarks` (D202): name, kind (13), point, footprint area, bay stamp (A09, holes filled so an
  island is in the bay around it), source, upstream ids as an array (one island is an OSM way *and*
  a GNIS point), aliases, `corpusMessages`, `reportCount`, `moderatorEditedAt`, soft `removedAt`.
  Capped at 1,500 live per body at the write, so the per-body read can take the cap.
- `scripts/etl`: `pnpm landmarks` exports listed bodies' outlines once (`landmarks:listBodyGeometry`,
  ~45 MB, cached), runs osmium over the five archived extracts and reads GNIS, places each candidate
  by its kind's rule offline, merges same-place sightings per kind radius, and attaches the corpus.
  `pnpm load-landmarks` writes through `landmarks:importBatch`, dry unless `--apply`.
- Both maps label the focused lake; the lake editor gets a Landmarks card (find, edit, move, remove,
  restore, drop, *Draw as bay*).

**The first data run (dev, 2026-09-29, campaign `landmarks-20260929`):** 155,945 candidates (OSM
131,111 + GNIS 24,834) → 24,087 placed → 23,989 rows on 10,600 of 24,953 listed bodies. By kind: 9,501 river
mouths, 6,154 shore towns, 2,653 dams, 1,683 islands, 1,157 points, 1,137 establishments, 932
reference bays, 391 beaches, 166 marinas, 103 bridges, 93 narrows, 93 rocks and shoals, 24
lighthouses. 28,771 crowded businesses dropped by the standalone rule; 96 skipped because a live
bay already carries the name. Champlain holds ~560, Winnipesaukee ~370, Lake George ~315. A re-run
is idempotent (23,989 unchanged). The corpus: 154 of 391 place names attached, 16 ambiguous, 221
unmatched — the unmatched list (`.scratch/landmarks/corpus-unmatched.csv`, gitignored) is the
moderator's worklist and the proposal lane's first customers.

**What the data taught the build** (each a rule now, with a test):

- *Two catalogs, one island* — an OSM polygon and a GNIS point for the same place sit up to a
  kilometer apart, a passage's two ends five. The merge radius is per kind.
- *The corpus's alias lists are an LLM's clusters, not spellings* — Carry Bay's carried "Carleton's
  Prize", Malletts Bay's "inner bay". An alias attaches only when it resembles the name.
- *A named parent is binding* — Champlain's "Northwest Bay" (26 messages) must not lend its count to
  Lake George's; neither catalog has Champlain's, so it goes on the unmatched list (and to the chord
  queue, where it already is).
- *Apple Island is not an island any more* — a causeway joined it to South Hero, and neither
  catalog lists it on Champlain. An island joined to land falls back to the shore rule.
- *The corpus's kinds are loose* — "Leavitt Beach" is filed under `bay`; a corpus bay may attach to
  anything on the water, never to the village or the business that shares its name.
- *Numbered campsites are not names* — Green River Reservoir's thirty "Campsite #N".
- *A re-run must be able to forget* — the importer first unioned stored and incoming spellings, so a
  spelling a later run dropped could never leave; and two candidates for one row took turns
  overwriting it. It now resolves every candidate to its row first and writes each row once.
- *Rendered, not argued*: the label layer drawn outside the app on Champlain's real rows shows
  Valcour, Savage, South Hero and Keeler Bay at z11, the reefs and points by z14.

**The self-review (`/code-review xhigh`) before the PR opened** found fifteen; all fixed: a bay could
take a landmark's name by rename, restore or import without retiring it (the retire moved into the
one sub-area insert, plus rename and restore, and only within 1 km — Champlain has two Mud Bays);
a promoted landmark could be restored beside its bay (refused now); the loader split giants across
calls, undoing resolve-then-write (a body now travels whole); a run without `--mentions` would have
erased every corpus count (refused unless meant); "same place" had three rules in three places (one
in core now); the editor's labels named no font (a silent 404 on Protomaps' glyph host); and the
smaller ones — the landmark restamp pages like the others, the bay stamp prefilters by bbox, the
geometry export pages by bytes, `source` follows the catalog that won, the drop form starts empty.

**PR 2 — the consumers** (next): `where.point.landmarkId` beside the name; the sheet's landmark
chips (ranked, a search for the rest) and tap-to-name; `reportCount` bumped when a report names one
(a monotonic tally that orders labels — never a claim about the ice); `name_landmark` proposals,
filed when a skater names a spot in the sheet, answered on the lake editor; the extraction
contract's landmark candidates.
