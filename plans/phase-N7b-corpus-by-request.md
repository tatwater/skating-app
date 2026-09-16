# N7b — Corpus by request: the skater says "this is skateable", and the catalogue answers

> **Status:** 📋 Scoped, not built (2026-08-03). Split out of [`N7`](./phase-N7-unified-corpus.md)
> because it is a product feature across two clients, not a data campaign.
> **Depends on:** N7's `includedByRequest` field and `belongsInCorpus` predicate — **both landed
> 2026-08-03**, deliberately ahead of this phase, because without them N7's own prune deletes
> exactly the bodies this feature admits.
> **Reuses:** N2's lake-editor review queue, Phase 8's `pathToBody`, the archive lane in
> `scripts/etl`.
> **Decisions:** D106–D108, proposed here; **D175 proposed 2026-09-16** (see *§The other half*).
> **Widened 2026-09-16 (founder):** this phase is now the home for **corpus lifecycle** as a whole —
> not only admitting a body by request, but demoting and removing one, keeping a removed body out of
> the next ETL campaign, and what happens to everything attached to a body in each state. The first
> concrete piece, the consequence of an N6f `none` verdict, is scoped below; the rest is named with
> what exists today so it can be scoped in one pass when this phase is picked up.

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

### ⚠ The client half is already written and unmounted — wire it, don't write it (noted 2026-08-16)

`apps/mobile/src/components/NewWaterPrompt.tsx` **exists, is complete, and has zero callers.** It
takes `{ activityId, onResolved, onDismiss }` and queries `waterBodies.findMatchCandidates` — which is
itself referenced from nowhere else, so the query and the component are an orphaned pair. Building a
new prompt in this phase would be writing the second one.

It could not be mounted before N6f for a concrete reason worth keeping: it needs a **server**
`activityId`, and the only surface that offered an unmatched skate was the recorder's stop-card, which
holds a *local* draft id (the track often hasn't flushed yet). Its "add it from your track" button was
`disabled` for exactly the unmatched case it was written for.

**N6f removed that blocker.** `UnreportedSkates` in the You tab is `listMine`-backed, so every row
carries a server `activityId`, and an unmatched skate now renders this line instead of a dead button:

> *"We couldn't match this to a lake we know, so there's nothing to report it against yet."*

**That sentence is this phase's to delete.** Replacing it with `<NewWaterPrompt activityId={…} />` is
the smallest honest version of D108 — the resolver and the admission flow are still the real work, but
the surface that reaches them is already built and already has the id it needs.

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

## The other half — corpus lifecycle (added 2026-09-16)

*Admission is one transition. A body has several states and the code got them one phase at a time,
each with its own field, its own verb, and its own idea of what "gone" means. This section is the
map of them, one fully-scoped workstream, and the list of what still needs scoping.*

### The states a body can be in today

| State | Field | Set by | On the map? | Survives an ETL re-import? |
|---|---|---|---|---|
| **listed** | *(none of the below)* | import / approval | yes | yes — upsert on `externalId` |
| **pending review** | `reviewStatus: 'pending'` (user-drawn, D37) | `waterBodies.create` | yes, marked | n/a — never in a catalogue |
| **rejected** | `reviewStatus: 'rejected'` | moderator | no (`isListed`) | n/a |
| **merged** | `dedupStatus: 'merged'` + `mergedIntoId` (D36) | moderator / N7 dedup | no; reads follow the survivor | kept by the prune; **unverified** against the loader |
| **removed** | `removedAt` + `removalReason` (D48) | admin `remove` | no (`isListed`) | **yes** — `importCanonical` preserves it, the prune keeps it (`kept.delisted`) |
| **no public access** | `publicAccess.verdict: 'none'` (N6f) | moderator | yes — dimmed, −2 zoom | yes — the six `scoreFields` sites (N6f §B) |
| **admitted by request** | `includedByRequest` (this phase) | moderator | yes | left alone — the transform drops it at the floor (above) |

Two things fall out of the table. **`isListed` is the only membership predicate the read paths
share** (`lib/listing.ts`: not rejected ∧ not merged ∧ not removed), and the `none` verdict is
deliberately *not* in it — a `none` body is listed. And **"survives re-import" was answered
per-state, in different phases, by different mechanisms** — a field list in `importCanonical`, a
`continue` in the prune, six scoring sites. There is no single test that walks every state through a
campaign. That test is the first thing this workstream should write.

### Workstream L1 — What a `none` verdict does next: on the map and marked, never recommended

**The founder's read** ([N6h](./phase-N6h-weather-detail.md), open questions): a moderator-confirmed
`none` should *"eventually remove a body from the corpus rather than have every query learn to skip
it — the ideal situation eventually (way down the line) would be managing 5,000 lakes that actually
get skated on, not 20,000 nobody ever touches."*

**The scoped version, agreed 2026-09-16.** Deleting on a verdict is the wrong mechanism for the right
goal. N6f's own argument for a third state — someone may hold a key, an invitation, or a landowner's
word, and a ruling we got wrong is only corrected by someone who went anyway — is an argument
against ever purging on it automatically. What the founder actually wants is narrower and better: a
lake nobody can lawfully reach **stops being pushed at people**. So:

> **D175 (proposed) — A `none` verdict removes a body from every *discovery* surface and from no
> *reference* surface.** One core predicate, `isDiscoverable(body)` ≡ `isListed(body) ∧
> !isNoPublicAccess(body)`, applied to every surface that *recommends* a lake and to nothing a
> skater navigates to on purpose. Removal from the corpus stays a human act with a reason (D48).

| Filter — these *push* | Leave — these are *reference* |
|---|---|
| Phase 4 drive-time notification fan-out (`notifications.ts` — `bandForCoord` call site) and the 8 pm nearby digest | the map — never-hide (D49), the dim + demotion is the whole treatment |
| N6h weather-discovery cards (`weatherDiscovery.ts:288` gates on `isListed` today, **deliberately** not on `none`) | search, and the drawer |
| the Phase 6 recommended strip (`listFeed` recommended caps) | favourites — *if you favourited it, you know something we don't* |
| bounty requests fanned to nearby reporters (`bounties.ts`) | the viewport list (already sinks `none` to the bottom — N6f §D) |
| the N8 `great_report_nearby` and `activity_detected` triggers, if the body is the subject | a report or hazard *on* the body — content is never suppressed (N6f's `AccessSection` invariant) |

**Build shape.** This is the N6d "a new surface added to a system that enumerates its inputs" shape,
so the work is the enumeration, not the predicate: each push surface gets the filter *and a test that
seeds a `none` body and asserts it is absent*, because every omission fails silently and
permissively. Five surfaces, five tests, one predicate in core. Its own PR — it touches the Phase 4
fan-out, and should not ride a feature phase.

**The purge half, deliberately human.** `waterBodies.remove` (D48) already exists, takes a reason,
and is preserved through re-import. The only new lever worth building is a **purge-candidate list**
in the admin tree: bodies with `none` standing **and** zero reports for N seasons (N5a boundaries),
surfaced for a moderator to act on one at a time — a queue, never a cron. That gives the founder the
"5,000 lakes" trajectory without a machine ever deciding a lake is gone.

**Not in L1:** a notification copy change for `content_flag_resolved` on a lake (N6f follow-up
finding 5 — founder call pending); a `none` body's hazards and reports, which stay exactly as they
are.

### What still needs scoping — named, not specced

Each of these has *some* machinery today; the gap in every case is that nobody has written down the
rule and tested it across states. Listed so the pass that picks this phase up scopes them together.

- **Demoting versus removing.** Today there are two demotions (`curatedBoost` < 0, and the N6f
  penalty) and one removal (D48). Whether a moderator needs a *third* rung — "keep it but stop it
  ever surfacing wide" without the legal claim `none` makes — or whether `curatedBoost` already is
  that rung, is a founder call. The N2 editor's Prominence tool already exposes the boost.
- **Keeping a removed body out of the next campaign.** `importCanonical` preserves `removedAt` and
  the prune keeps delisted rows, so today this *works by upsert* — but only because the row still
  exists. If a removed body's row were ever hard-deleted, or its `externalId` changed under a
  catalogue re-key (N7-3's D95 lane is still unbuilt), the next campaign re-admits it as new, with no
  memory of the takedown. A **tombstone keyed on `externalId`** (or a `removedExternalIds` set the
  loader consults) is the durable version. Wants a test: remove → hard-delete the row → re-import →
  assert absent.
- **What happens to attached records, per state.** `bodyAttachmentKind` (the prune's guard) knows
  what *kinds* of rows hang off a body; nothing states what each transition does to them. The
  matrix to fill in, per attachment kind — reports, hazards (+ recurrences, N5c), comments, photos,
  favourites, bounties, put-ins / parking (N6d), access alerts, sub-areas (inherit listing, N2
  Decision 11), weather-registry rows (N6h), notification-queue rows (N8) — against each transition:
  remove / restore / merge / unmerge / `none` / clear / prune. Some cells are known (merge: reads
  follow the survivor; sub-areas: follow the parent; prune: refuses if anything is attached); most
  are "whatever the code happens to do." Fill the matrix first, then decide which cells are wrong.
- **Restore semantics.** `restore` clears `removedAt` and re-syncs cells. Whether it should also
  re-run the derived scoring (a removed body's `minVisibleZoom` may be stale by several campaigns)
  and re-check dedup is unstated.
- **The one test that walks every state through a campaign.** Seed one body per row of the table
  above, run `importCanonical` + `pruneBelowAreaFloor` over them, assert each is exactly where the
  table says. This is the regression net for everything else in this section, and it should be
  written before any of it is changed.

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
