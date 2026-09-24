# Access-point authoring — a moderator adds a put-in or a lot, and the skaters' points become a queue

> **Feature — scoped 2026-09-21 at the A10-3 kickoff, scheduled after A10.** Founder observation:
> *"I thought we had a moderator path for adding new put-ins, parking, etc. manually! We should
> absolutely build that."* There is none: put-ins and lots come from the A06d ETL (OSM + the
> parking match), and the only moderator writes are `putIns.setOfficial`, `putIns.hide`,
> `accessPoints.setPutInAccess` (the lot association and the approach kind) and
> `setOfficialParking`. Nothing in the deferred register noted the gap. Delete when it ships; the
> record is the register row and any `D#` it mints.

## What exists, and what the sheet adds

- **`putIns` rows** are `osm`, `official` or `derived`. The derived kind is no longer written; the
  read (`putIns.listForBody`) instead **clusters the put-in points of visible reports** on the
  body, snapped to the shore, and returns them as derived markers. `setOfficial` promotes a
  cluster into a real `official` row. That is a proposal queue in all but name.
- **The A10-3 sheet** (`AccessSection`) writes `reports.putInId` when the skater tapped a known
  launch, and `reports.point` alone — *somewhere else* — when they did not. Every such point is
  therefore a skater saying "I got on here", and the cluster read already gathers them. The sheet
  proposes nothing else on purpose: a second table would re-implement what the cluster read does,
  and a proposal row with no reviewer is a row nobody looks at.

## The feature

1. **Add by hand (moderator).** On the admin body page: *add a put-in* / *add a lot* — a tap on
   the map, a name, the source `moderator`, an optional lot association through
   `setPutInAccess`. One mutation each (`putIns.create`, `parkingAreas.create`), moderator-gated,
   with a `moderationActions` row. The approach line stays for the ETL's next pass (D87: never
   route from a request path).
2. **The proposal queue (moderator).** The same page lists the body's derived clusters — the
   skaters' *somewhere else* points, grouped, with the count and the last date — with three
   answers per cluster: **accept** (`setOfficial`, which exists), **merge into** a known launch
   nearby (a `putIns.mergeDerived` that re-stamps the member reports' `putInId` so their condition
   chips have a target), or **not a put-in** (hide the cluster: `putIns.hide` today takes a row,
   so the derived marker needs an id — the read mints a stable one from the cluster's rounded
   coordinate, or the hide is stored as a suppressed coordinate). Bounded by the read's existing
   caps; a body's queue is a page, never a scan.
3. **Edit in place.** Rename, move, or retire (`hide`) an `official` or `osm` launch; the same
   for a lot. Moves re-run the shore snap and clear the routed approach (the `setPutInAccess`
   rule).
4. **The web console first**, the mobile admin surface never: this is a sit-down task.

## Not this

- **A `putInProposals` table.** The reports' points *are* the proposals; a copy would drift the
  first time a report is edited or removed.
- **Skater-side naming.** A skater names nothing in A10-3; a moderator names what the cluster
  shows. Named landmarks ([`named-landmarks.md`](./named-landmarks.md)) are the skater-facing
  vocabulary for "where", and a launch's name is the moderator's call.
- **Auto-accepting a cluster at a count.** A launch on the map is a claim other skaters will drive
  to; a person accepts it (the `setOfficial` rule, applied to the queue).

## Register

Roadmap deferred rows: the A10 entry's *Moderator put-in and lot authoring* (⚪, after A10) and the
A06d entry's note that the ETL is the only writer. Blocks nothing; the sheet's *somewhere else*
works without it and the cluster read already shows the points.
