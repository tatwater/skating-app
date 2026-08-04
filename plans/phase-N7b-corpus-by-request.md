# N7b — Corpus by request: the skater says "this is skateable", and the catalogue answers

> **Status:** 📋 Scoped, not built (2026-08-03). Split out of [`N7`](./phase-N7-unified-corpus.md)
> because it is a product feature across two clients, not a data campaign.
> **Depends on:** N7's `includedByRequest` field and `belongsInCorpus` predicate — **both landed
> 2026-08-03**, deliberately ahead of this phase, because without them N7's own prune deletes
> exactly the bodies this feature admits.
> **Reuses:** N2's lake-editor review queue, Phase 8's `pathToBody`, the archive lane in
> `scripts/etl`.
> **Decisions:** D106–D108, proposed here.

---

## Why this exists

D91 put a floor under the corpus — five acres, or one acre with a name — and deleted 102,000 bodies.
The entire decision rests on one sentence:

> *"If I get user feedback that someone's pond isn't there, then we can relax the rule and re-run the
> import."* — founder, D91

**That fallback has never existed as anything but a sledgehammer.** Relaxing the rule means lowering
the floor globally and re-importing ~100,000 rows to rescue one pond. Nobody would ever do it, so in
practice a missing pond has no remedy at all.

This is the scalpel: a skater points at water we filtered out, and if a catalogue knows about it, it
comes into the corpus — that body, alone, with its real geometry.

**It also dissolves a question N7 could not answer honestly.** N7 measured 19,610 unnamed bodies NHD
would add to our region and had to pick a size bar for them. Any bar is a guess. With a request path,
the answer is *admit what is clearly worth having, and let demand pull the rest* — a skater saying "I
skate this" is evidence, and a threshold invented at a desk is not.

---

## D106 — The request is a coordinate, and the catalogue supplies the geometry

**Proposed.** A user long-presses (mobile) or right-clicks (web) on water that has no body, and picks
**"This is skateable"**. That writes a request — a coordinate and a requester — and nothing else.

**The user never draws the polygon.** N2's lake editor exists for hand-drawing and stays for the cases
where nothing else works, but a hand-drawn outline is worse in every measurable way than the one OSM
or NHD already holds: less accurate, no `nhdId`, no path to depth or contours, and no provenance. The
request's job is to say *where*, not *what*.

### The lookup cannot happen in a mutation, and that shapes the design

**Convex cannot read the archives.** They are local files and R2 objects. So "search NHD for this
coordinate" is not something a tap can do synchronously. Three routes were considered:

| | cost | verdict |
| --- | --- | --- |
| **(a) async resolve** — the request queues; a cron or moderator action resolves it against the archives or the live service | no new storage | **chosen** |
| (b) pre-load the below-floor set into a side table | ~120k rows **plus** a spatial index — the N1 cell machinery again, for a rarely-used feature | rejected |
| (c) ship the below-floor set as PMTiles and resolve client-side | most work; the basemap already does PMTiles so it is not exotic | deferred, revisit if latency matters |

**(a) is chosen and the latency is irrelevant**, because a moderator is in the loop regardless. The
resolver has two sources and should try them in this order:

1. **The local archives** (`.raw-nhd/`, `.raw-3dhp/`, `.raw/`) — reproducible, already checksummed,
   and the geometry is identical to what a campaign would import.
2. **`hydro.nationalmap.gov`**, a single point query, as the fallback when the archives miss. It is
   the same service N7 used throughout and it answers in one HTTP call.

Whichever answers, **record which one and what it returned**. A body admitted by request has a
provenance story exactly as much as one admitted by a campaign.

---

## D107 — A request is a proposal; a moderator admits

**Proposed.** The resolver attaches a candidate polygon to the request and queues it. A moderator sees
the outline on a map, the catalogue it came from, its area, and the requester, and approves or
declines.

**Automatic admission is wrong here for a reason worth stating**: the floor deleted 102,000 bodies,
and the overwhelming majority of them are farm dugouts, retention basins and widenings in a brook.
One tap is not evidence against that; it is a request to look. The review is cheap — the moderator is
approving *geometry that already exists in a catalogue*, not adjudicating a drawing.

**Approval sets `includedByRequest: true`** and runs the body through the ordinary pipeline: cells,
prominence, depth, elevation, wind, bathymetry. That is the whole point of `belongsInCorpus` landing
in N7 — every one of those passes gates on it now, so a requested body is a first-class citizen the
moment it is admitted rather than a second-class row nothing enriches.

**Declining is not deleting.** A declined request stays as a record, so the same pond requested by
four different people reads as four people rather than as one unanswered tap.

---

## D108 — A track over unknown water is the same request, with better evidence

**Proposed.** When a recorded GPS activity (Phase 8) covers water with no body, prompt the same
lookup.

**This is the stronger signal and it should be weighted as such.** A long-press means *someone thinks
this is skateable*; a track means *someone skated it*. Phase 8 already built `pathToBody`, so the
mechanism exists — what is new is checking the catalogues before falling back to a path-derived
outline.

Two cases the resolver must distinguish, because they need different answers:

- **The catalogue knows this water** — we filtered it out. Admit the catalogue's polygon.
- **No catalogue knows it** — a flooded field, a beaver flowage, a new impoundment. That is N2's
  hand-drawn path, and Phase 8's `pathToBody` is already the right tool.

---

## What N7 already landed for this, and why it could not wait

**`includedByRequest` and `belongsInCorpus` shipped with N7, before this phase was written.** Not
eagerness — necessity. A requested body is by definition below the floor, and four passes gate on the
floor:

| gate | what happened to a below-floor body before |
| --- | --- |
| `pruneBelowAreaFloor` | **deleted** it, unless `source: 'user'` or a `curatedBoost` |
| `listNeedingElevation` | skipped — no elevation, ever |
| `listNeedingWindRose` | skipped — no wind rose, ever |
| `transform.ts` | classified `BELOW_AREA_FLOOR` — not re-imported |

**Without the predicate, this feature eats its own output**: the next campaign's prune deletes the
pond somebody asked for, and the requester watches it disappear.

### Why not "has this ever been skated?"

It was the founder's first instinct and it is a **good signal that cannot do this job**.

It is durable — D62's second amendment keeps published observations forever, redacting only what a
person typed ("*there is no report cascade any more*"), and seasons scope reads rather than deleting
rows. It is already honoured: the prune's attachment check covers reports, hazards, bounties,
`gpsActivities`, favourites, put-ins, body features and sub-areas. And it already feeds prominence,
which is where it belongs.

**But at the moment of admission there is no report and no track.** That is the entire point — someone
is asking for a lake they *want* to skate. Protect it only by use, and the next prune deletes it
before anyone can use it.

The second reason is the one running through all of N7: **prominence gets tuned.** D2 weights,
`curatedBoost`, N6c's profile richness. The moment somebody re-weights prominence they would be
silently changing what survives a prune — `externalId` doing three jobs, again.

**So the two stay separate.** *Has this been skated* answers **is this good ice** → prominence.
`includedByRequest` answers **does this belong in the corpus** → membership.

### One consequence, recorded rather than engineered around

A body admitted by request is **not re-imported** by a later campaign: the transform drops it at the
floor before the loader ever sees it. Since the import is an upsert, the row is simply left alone and
keeps the geometry it was admitted with. Acceptable, and deliberate — but if a catalogue later
revises that shoreline, we will not pick it up until someone re-requests. Worth revisiting if the set
grows large.

---

## Open questions

**Abuse and volume.** One tap per pond is fine; a thousand taps is a moderation queue nobody clears.
Rate-limiting exists for the client signal channel (`analytics.recordClientSignal`) and is the model.
Unmeasured until the feature has users.

**What the requested set will look like.** It skews toward wherever people happen to be, which is not
the same as what is skateable — so this **complements** the named gap-fill rather than replacing it. A
lake nobody has tapped stays invisible either way.

**Whether declines should be visible to the requester.** Telling someone "no" costs goodwill; telling
them nothing costs more. Not decided.

---

## Related

[D91](./01-decisions.md), [D62](./01-decisions.md), [`N7`](./phase-N7-unified-corpus.md),
[`phase-N2`](./phase-N2-lake-editor-and-subareas.md), [`phase-8`](./phase-8-native-capture.md)
