# N9 — A bay is a place: sub-areas become destinations, not labels

> **Scoped 2026-08-07, unbuilt.** Founder ask, arrived out of the N7 Great Lakes question:
> *"I would love if `waterBodySubAreas` could be favorited, supported put-ins, parking, bathrooms,
> outlets, hazards/reports, etc… have their own maxDepth and windRose, and borrow cropped versions of
> their parents' contours… Maybe they don't store much of this info themselves, but they should be
> able to (based on their boundary polygon), pull all these data from their parent on demand, and be
> findable/routeable in search & drive time!"*
>
> **Depends on:** N7's corpus (landed), N2's sub-area authoring (landed), N6b's contour build
> (landed). **Blocks nothing.** Deliberately sequenced *after* the N7 PR — see §Ordering.
>
> **Scope note:** this is about **all** sub-areas — Malletts Bay, Spencer Bay, Alton Bay — not just
> the Great Lakes case that surfaced it. That case took a different answer (see §The bay class,
> below) and is not a dependency.

---

## Why this is smaller than it sounds

The audit that produced this doc found that **most of a sub-area's first-class behaviour already
exists**, built incrementally across N2, N5c and N6b without anyone naming the through-line:

| already built | where |
| --- | --- |
| full-text search, with **aliases** and a denormalised `searchText` | `waterBodySubAreas.searchText`, `search_subarea`, `searchSubAreas` |
| its own cell index, so it draws and hit-tests independently of its parent | `waterBodySubAreaCells` |
| its own D49 display curve — `displayScore`, `minVisibleZoom`, `curatedBoost` | so Malletts Bay labels at regional zoom while a cove waits for z13 |
| reports, hazards, hazard recurrence and bounties can already name one | `subAreaId` on all four tables |
| contour cropping to a nested shape | `clipDrawnToBody`, built for N6b's `alsoCovers` |
| containment survives the parent changing shape | `reclipSubAreasToParent` + `systemDelistReason` |
| moderator authoring: create / redraw / rename / remove / restore, all audited | `subAreas.ts` |

**What a sub-area cannot do today**, and it is a short list: be favourited, hold a put-in or an
access marker, hold a known outlet, own a GPS track, carry its own depth / wind / elevation, be
stamped on a contour tile, or get a drive-time band.

So the phase is: **close seven gaps, and settle one rule that touches everything.**

---

## The principle: derive from the parent and the polygon, store only what is expensive

The founder's framing is the design — *"maybe they don't store much of this info themselves, but
they should be able to… pull all these data from their parent on demand."* Applied field by field,
that resolves into three different answers, and the differences are the interesting part.

| | how | why this one, and not the others |
| --- | --- | --- |
| **put-ins, parking, toilets, outlets, hazards, reports, tracks** | stored on the **parent**, tagged with `subAreaId` **at write time** by point-in-polygon; re-derived on redraw | Already the shape of `reports.subAreaId`. **Tag-at-write rather than derive-at-read, because a derived value cannot be indexed** — the schema already calls out wanting `['subAreaId', 'moderationStatus', 'skateEndTime']` for the bounty gate. |
| **favourites** | its own `subAreaId` on `waterBodyFavorites` | A favourite is not derived from anything: wanting alerts about Malletts Bay is a *different* statement from wanting alerts about all of Champlain, and only the user can make it. |
| **elevation** | **inherit, never fetch** | It is the same water surface. Fetching it would spend quota to reproduce a number by definition equal to one we hold. |
| **wind rose** | **inherit the parent's rose**; compute the bay's **own `fetchProfileM`** from its own polygon | Wind climate is a 2 km grid, so a bay and its lake are the same cell and the rose is genuinely shared. **Fetch is what differs**, and fetch is the thing that drives pressure ridges and wind holes — so the derived half is the half that matters. Costs no WTK requests at all. |
| **max / mean depth** | **derive** by clipping the parent's soundings to the bay polygon, then **store** | ⚠ **Inheriting would be a safety-relevant lie.** Malletts Bay is not as deep as Champlain's broad lake, and a bay page reading "max depth 122 m" is worse than one reading nothing (D3). Expensive to recompute per read, so it is stored — which makes it a derived-and-cached value with an invalidation rule, see §The redraw problem. |
| **contours** | crop the parent's at **build** time | `clipDrawnToBody` already does exactly this for the 9 nested bodies `alsoCovers` found. |
| **drive-time** | from the bay's **own** put-ins where it has any, else inherit the parent's bands | This is the point of the ask: the bay's parking is closer than the lake's nominal representative point, and a drive-time computed from the lake under-serves the bay. |

**The through-line worth stating once:** a sub-area's own *geometry* is the only new information it
brings. Everything that follows from geometry (fetch, depth-within-the-outline, contour crop, which
put-in is inside it) is derived; everything that does not (wind climate, elevation) is inherited;
and the one thing that is neither (a favourite) is stored.

---

## The rule that touches everything: what a report on a bay is a report *on*

**This is the hard part, and it is one decision applied in six places.** A report inside Malletts Bay
is also a report on Lake Champlain. The feed, the notification queue, the bounty gate, the D2
prominence score, the trust corroboration count and the conditions strip all currently assume **one
body per report**.

Proposed rule, to be settled before any of the seven gaps is closed:

> **A report belongs to the finest-grained place that contains it, and appears under every place that
> contains that one — once.**

Which means concretely:

- **Feed:** one row, attributed to `Malletts Bay`, appearing in both Champlain's feed and the bay's.
  Not two rows. The label carries the specificity, the membership carries the reach.
- **Notifications:** de-duplicated at the delivery layer. Favouriting *both* Champlain and Malletts
  Bay must yield **one** notification, not two — and that is a real case, because a user who cares
  about the bay very plausibly favourited the lake first.
- **Bounties:** a bounty on the bay is satisfied by a report in the bay; a bounty on the lake is
  satisfied by any report in the lake, **including** one in the bay. Not symmetric, and the
  asymmetry is correct.
- **Prominence / corroboration / conditions:** roll up to the parent. A lake is not less prominent
  because its reports were precise about where they were.

**The failure mode to design against is double-counting, and it is silent in every one of those six
places.** That is why the rule is written down before the schema changes rather than discovered per
consumer — the N7 audit's own recurring lesson.

---

## Seven gaps, and what each costs

1. **`waterBodyFavorites.subAreaId`** — plus a uniqueness rule and the notification de-dup above.
   Small, except for the de-dup, which is the rule not the column.
2. **`putIns.subAreaId`** — tagged at write. N6d's access layer (parking, toilets, trails) rides the
   same change; check whether it landed on `putIns` or its own table before writing the migration.
3. **`bodyFeatures.subAreaId`** — known outlets and springs (D103). The vocabulary rule still binds:
   *"known outlet", never "outlet"*.
4. **`gpsActivities.subAreaId`** — and this one has a bonus: **a recorded track is the evidence that
   settles the mouth line.** See §The mouth line.
5. **Depth / fetch / wind / elevation on `waterBodySubAreas`** — per the table above. The only
   genuinely new computation is the sounding clip.
6. **A tile stamp.** Contour tiles are stamped with `externalId`, and a sub-area has none. It needs
   the `waterBodyKey` treatment — **which is D93's argument paying off a second time**: the reason
   identity was split from the foreign catalogue key was so that a thing we mint can be stamped on a
   tile. Mint `subAreaKey` the same way, at insert, opaque and sortable.
7. **Drive-time.** ~120 sub-areas against a corpus of 25,136 is a rounding error on the ORS budget;
   the work is in the read path deciding which bands to show, not in the fetch.

---

## The redraw problem, which is new

A lake's outline changes when a catalogue re-publishes it — rarely, and the loader already gates the
expensive work on `footprintMoved`. **A bay's outline changes whenever a moderator decides it
should**, and the founder has explicitly signed up for that: *"If we learn that skaters venture past
our mid-lake straight-line edge that defines the mouth of the bay, we can always adjust our geometry
to accommodate all historical skate paths over time!"*

That is the right product answer and it creates a cache-invalidation surface that does not exist
today. A redraw must re-run: `reclipSubAreasToParent`'s containment check (built), the cell index
(built), **the sounding clip, the fetch profile, the contour crop, and every point-in-polygon tag on
put-ins, hazards, reports and tracks** (all new).

**Make the re-derivation one function with one caller**, and make the redraw mutation call it. Two
places that recompute a bay's derived state is how a bay ends up with last week's depth and this
week's outline — the same class of drift `extract.ts` was created to end.

---

## The mouth line

A bay's seaward edge is a straight line we drew across open water. It is the one part of a sub-area's
geometry that is a **judgement**, not a tracing, and it is the one a skater can prove wrong by
skating past it.

**Founder call, 2026-08-07:** adjust it from historical skate paths over time. Once `gpsActivities`
carry a `subAreaId` (gap 4), the evidence collects itself: a track that starts inside the bay and
runs past the mouth is exactly the signal, and it accumulates without anyone doing anything. Surface
it in `/admin/water/$id` beside the redraw control rather than acting on it automatically — a mouth
line that moves on its own is a boundary nobody can reason about.

---

## The bay class — settled separately, and not a dependency

The Great Lakes question that surfaced this phase took its own answer and it does **not** rely on any
of the above (founder, 2026-08-07):

**A bay whose only candidate parent is a Great Lake stays a body, classed `bay`.** Chaumont Bay
(9,169 ac), Black River Bay (4,455), Braddock, Little Sodus, Blind Sodus, Three Mile, Muskellunge,
Sherwin, East Bay and Long Bay become first-class bodies rather than sub-areas of a lake we do not
carry. Lake Erie and Lake Ontario are **not** added to the corpus: they already draw (the region mask
layers Natural Earth `ne_10m_lakes`, and the Protomaps world basemap has water everywhere), and
adding a 4.7M-acre polygon would put a Great Lake into every viewport query along 300 miles of
shoreline for no pixels gained.

**Two things that decision buys, recorded because they were the reasons for it:**

- The `bay` class was effectively unreachable after D121 and is now useful again, for exactly the
  case it should cover: an arm of water whose parent we deliberately do not carry.
- **A salt-water bay can be added by hand later without adding the ocean** — through N7b's
  `includedByRequest` flow, one body at a time, with a human looking. So "people skate somewhere on
  the sea" stops being an argument for weakening the ocean veto.

Whether Lake Erie and Lake Ontario themselves should ever be skateable water in their own right is
**open and deliberately unanswered**. Erie is the shallowest Great Lake and reaches high ice cover in
some winters. Because the bays are not children of anything, that decision can be taken later and
changes nothing about them.

---

## Ordering

**After the N7 PR.** N7's re-merge changes admission rules (the wetland rule, the three bay rules,
the duplicate matcher fixes), and every number in this document's sibling docs is re-measured against
that run. Starting a schema-changing phase on top of a corpus that is about to move is the ordering
trap D100 names, one table over.

The one piece worth doing **early**, because it is cheap and unblocks the rest: settle §The rule that
touches everything. It is a decision, not code, and every gap below it is easier to close once it is
written down.

---

## Related

[`phase-N2-lake-editor-and-subareas.md`](./phase-N2-lake-editor-and-subareas.md) ·
[`phase-N6b-bathymetry-layer.md`](./phase-N6b-bathymetry-layer.md) ·
[`phase-N6d-lake-access-points.md`](./phase-N6d-lake-access-points.md) ·
[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) ·
[`phase-N7b-corpus-by-request.md`](./phase-N7b-corpus-by-request.md) ·
[`phase-N8-notification-pipeline.md`](./phase-N8-notification-pipeline.md) ·
[`01-decisions.md`](./01-decisions.md)
