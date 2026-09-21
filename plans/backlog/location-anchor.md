# The location anchor — search from wherever you'll actually be

> **Backlog — founder ask, 2026-09-17.** Unscoped. The UX is open ([`02-open-questions.md`](../02-open-questions.md) § Q17);
> the register row is *Location anchor (Q17) + a hosted geocoder* in the roadmap's deferred register
> (`07-roadmap.md`); the geocoder is also in `03-tech-stack-options.md` § Maps & routing and § Deferred
> tech, and the geocoding source options are in `04-integrations.md` § Geocoding. Update all of them
> when this is scoped or built.

## The ask

> *"The user should be able to search either within a radius of their device location OR a radius
> from an address (their home address, the address of an Airbnb or a friend they might visit,
> etc)."*

Today every "near" in the app is anchored on one of two things: the device's current location
(map framing, D20) or the private home coordinate (drive-time bands, D18; the feed's distance
weighting; nearby notifications). Both are right most of the time and wrong the moment a skater is
planning a weekend somewhere else — the question is *"what's within an hour of the cabin,"* and the
app can only answer *"of your house"* or *"of where you're standing now."*

## The shape, roughly

An **anchor**: a named point the map and the feed measure from. Three kinds —

- **Here** — device location (the default, unchanged).
- **Home** — the saved private coordinate (D11), one tap.
- **Somewhere** — an address or place name, geocoded; optionally saved with a label ("the cabin",
  "Dave's") for reuse.

Explore recenters on it; Latest re-weights distance from it; the drive-time bands recompute from it
(cached per anchor, the D18 pattern — an isochrone for an Airbnb is a second cache entry, not a
new mechanism). Notifications keep using Home: an anchor is a *browsing* posture, not a
subscription, unless the design says otherwise.

## What it touches

| Piece | Today | With an anchor |
| --- | --- | --- |
| Home coordinate (D11) | set from device geolocation only — no address entry | also settable from an address, via the same geocoder |
| Drive-time bands (D18) | one isochrone set per user, from home | per anchor; the hosted ORS quota is per user-change, so still tiny |
| Map framing (D20) | home when browsing, water body when on the ice | the anchor when browsing |
| Latest / discovery (D159, D165) | distance from home | distance from the anchor |
| Weather-first search (D159) | "within an hour of home" | "within an hour of *here*" |
| Geocoding | none | a hosted geocoder — options in `04` § Geocoding |
| Privacy | home never leaves the device beyond `setHome` | a typed address is at least as private as home; never stored beyond the coordinate + label the skater chose |

## Open

The UX: where the anchor lives on Explore and Latest (the search box? a chip by the filter row?),
whether a saved anchor syncs across devices, and whether picking an anchor is a session posture or
a setting. Q17.
