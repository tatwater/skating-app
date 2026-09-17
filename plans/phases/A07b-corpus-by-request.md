# A07b — Corpus by request: the skater says "this is skateable", and the catalogue answers

> **Status:** ✅ **Built 2026-09-16, two PRs** — PR 1 (`phase-n7b-corpus-lifecycle`, #61): the
> lifecycle model — standing, transitions, the seed, the rollover, the surfaces, the docs. PR 2
> (`phase-n7b-requests`, stacked on PR 1): requests — the table, the gestures, the resolver, the
> moderator queue, `NewWaterPrompt`. Neither deployed to dev nor device-tested; the seed not run.
> Split out of [`A07a`](./A07a-unified-corpus.md) because it is a product feature across two
> clients, not a data campaign.
> **Depends on:** A07a's `includedByRequest` field and `belongsInCorpus` predicate — **both landed
> 2026-08-03**, deliberately ahead of this phase, because without them A07a's own prune deletes
> exactly the bodies this feature admits.
> **Reuses:** A02's body-editor review queue, Phase 08's `pathToBody`, the archive lane in
> `scripts/etl`.
> **Decisions:** D106–D108 (requests, proposed here, PR 2); **D176–D178 decided and built 2026-09-16**
> (standing, retention, prunes-demote — see *§What PR 1 built*). The L1 draft below proposed a
> number that A09 took; it is superseded by D176 and kept as the record of the argument.
> **Widened 2026-09-16 (founder):** this phase is now the home for **corpus lifecycle** as a whole —
> not only admitting a body by request, but demoting and removing one, keeping a removed body out of
> the next ETL campaign, and what happens to everything attached to a body in each state. The
> founder's vision at kickoff: *"instead of 25,000 bodies clogging up our map, we should eventually
> settle down to a refined corpus of actually-accessible, actually-skated bodies … more like 500."*
> The skater-facing story is [`docs/corpus-lifecycle.md`](../../docs/corpus-lifecycle.md).

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

**It also dissolves a question A07a could not answer honestly.** A07a measured 19,610 unnamed bodies NHD
would add to our region and had to pick a size bar for them. Any bar is a guess. With a request path,
the answer is *admit what is clearly worth having, and let demand pull the rest* — a skater saying "I
skate this" is evidence, and a threshold invented at a desk is not.

---

## D106 — The request is a coordinate, and the catalogue supplies the geometry

**Proposed.** A user long-presses (mobile) or right-clicks (web) on water that has no body, and picks
**"This is skateable"**. That writes a request — a coordinate and a requester — and nothing else.

**The user never draws the polygon.** A02's water body editor exists for hand-drawing and stays for the cases
where nothing else works, but a hand-drawn outline is worse in every measurable way than the one OSM
or NHD already holds: less accurate, no `nhdId`, no path to depth or contours, and no provenance. The
request's job is to say *where*, not *what*.

### The lookup cannot happen in a mutation, and that shapes the design

**Convex cannot read the archives.** They are local files and R2 objects. So "search NHD for this
coordinate" is not something a tap can do synchronously. Three routes were considered:

| | cost | verdict |
| --- | --- | --- |
| **(a) async resolve** — the request queues; a cron or moderator action resolves it against the archives or the live service | no new storage | **chosen** |
| (b) pre-load the below-floor set into a side table | ~120k rows **plus** a spatial index — the A01 cell machinery again, for a rarely-used feature | rejected |
| (c) ship the below-floor set as PMTiles and resolve client-side | most work; the basemap already does PMTiles so it is not exotic | deferred, revisit if latency matters |

**(a) is chosen and the latency is irrelevant**, because a moderator is in the loop regardless. The
resolver has two sources and should try them in this order:

1. **The local archives** (`.raw-nhd/`, `.raw-3dhp/`, `.raw/`) — reproducible, already checksummed,
   and the geometry is identical to what a campaign would import.
2. **`hydro.nationalmap.gov`**, a single point query, as the fallback when the archives miss. It is
   the same service A07a used throughout and it answers in one HTTP call.

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
in A07a — every one of those passes gates on it now, so a requested body is a first-class citizen the
moment it is admitted rather than a second-class row nothing enriches.

**Declining is not deleting.** A declined request stays as a record, so the same pond requested by
four different people reads as four people rather than as one unanswered tap.

---

## D108 — A track over unknown water is the same request, with better evidence

**Proposed.** When a recorded GPS activity (Phase 08) covers water with no body, prompt the same
lookup.

**This is the stronger signal and it should be weighted as such.** A long-press means *someone thinks
this is skateable*; a track means *someone skated it*. Phase 08 already built `pathToBody`, so the
mechanism exists — what is new is checking the catalogues before falling back to a path-derived
outline.

Two cases the resolver must distinguish, because they need different answers:

- **The catalogue knows this water** — we filtered it out. Admit the catalogue's polygon.
- **No catalogue knows it** — a flooded field, a beaver flowage, a new impoundment. That is A02's
  hand-drawn path, and Phase 08's `pathToBody` is already the right tool.

### ⚠ The client half is already written and unmounted — wire it, don't write it (noted 2026-08-16)

`apps/mobile/src/components/NewWaterPrompt.tsx` **exists, is complete, and has zero callers.** It
takes `{ activityId, onResolved, onDismiss }` and queries `waterBodies.findMatchCandidates` — which is
itself referenced from nowhere else, so the query and the component are an orphaned pair. Building a
new prompt in this phase would be writing the second one.

It could not be mounted before A06f for a concrete reason worth keeping: it needs a **server**
`activityId`, and the only surface that offered an unmatched skate was the recorder's stop-card, which
holds a *local* draft id (the track often hasn't flushed yet). Its "add it from your track" button was
`disabled` for exactly the unmatched case it was written for.

**A06f removed that blocker.** `UnreportedSkates` in the You tab is `listMine`-backed, so every row
carries a server `activityId`, and an unmatched skate now renders this line instead of a dead button:

> *"We couldn't match this to a lake we know, so there's nothing to report it against yet."*

**That sentence is this phase's to delete.** Replacing it with `<NewWaterPrompt activityId={…} />` is
the smallest honest version of D108 — the resolver and the admission flow are still the real work, but
the surface that reaches them is already built and already has the id it needs.

---

## What A07a already landed for this, and why it could not wait

**`includedByRequest` and `belongsInCorpus` shipped with A07a, before this phase was written.** Not
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
is asking for a water body they *want* to skate. Protect it only by use, and the next prune deletes it
before anyone can use it.

The second reason is the one running through all of A07a: **prominence gets tuned.** D2 weights,
`curatedBoost`, A06c's profile richness. The moment somebody re-weights prominence they would be
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

## What PR 1 built — the lifecycle model (2026-09-16)

*The kickoff pass answered fourteen questions; the answers are D176–D178 and the founder's calls are
quoted there. This is the shape of what landed, and the seams PR 2 plugs into.*

### The model

**Standing** (`@skating/core` `standing.ts`): `standingOf(body)` derives `unlisted › removed › dormant
› active` from `reviewStatus`/`dedupStatus`, `removedAt`, `publicAccess.verdict` and the new stored
`dormant: { since, reason, byUserId?, note? }` (reasons `inactive` · `not_in_campaign` · `moderator`;
`no_public_access` and removal are *read* from their own fields, never copied). `isActive` gates every
push surface; `isListed` (Convex) now means *reachable* and a removed body is listed. A non-active
body draws at `DORMANT_MIN_VISIBLE_ZOOM` (z16), past the D49 floor; A06f's −2-zoom penalty is gone.

**The transition** (`convex/lib/standing.ts`): `transitionStanding` is the one write — re-score with
richness, cell rows, sub-area cells (a bay follows its water body's *active* standing), weather registry
membership, `activatedAt`, audit row. `activateBody` / `demoteBody` / `activateOnEvidence` wrap it.
`remove`, `restore` (now an activation), `setPublicAccess` (`none` ⇒ dormant, `open` ⇒ activation
that clears a stored dormancy too), `setCuratedBoost` (a positive boost on a shelved body brings it
back) and `setIncludedByRequest` all go through it. Scoring moved to `lib/scoring.ts`
(`scoreFields({ …, active })`, `richnessFor`, `zoomSortKey`).

**Evidence hooks:** `reports.create`, `gpsActivities.ingestTrack` (every body the track resolved
to), `hazards` create, `putIns.setOfficial`, the A06d access pass on a *new* launch. Only `inactive`
and `not_in_campaign` yield; coming back from `not_in_campaign` sets `includedByRequest`.

**The prunes demote** — all three, `deleted` kept as the tally name, `alreadyDormant` added.

**The surfaces:** fan-out (`body_not_active` stop; favourites still told unless removed), weather
discovery, recommended strip, bounty creation and fan-out, the feed (hides reports on *removed*
bodies, shows dormant), the weather cell registry, `listNeedingElevation` / `listNeedingWindRose`
(`includeDormant` opt-in, `dormant` tally), imagery masks, sub-area seeding, favourites (dormant yes,
removed no), tracks (`listTracksForBody` hides removed), search (dormant badged and ranked last,
removed absent), `get` (returns removed/dormant whole), `regionStats` (`bodiesActive`).

**The operator surface** (`convex/standing.ts`): `setStanding` (moderator; refusals name the right
verb), `listLane` × 5, `listRecentActivations` (with `via` and what enrichment is missing),
`seedStanding` (dry by default, paged, `keepIds`), `demoteInactiveBodies` + `runStandingRollover`
(an `importRuns` row, `standing_rollover`) + `maybeRunStandingRollover` (daily cron, July 1–14,
gated on the run row). `scripts/seed-destinations seed-standing --gazetteer=<csv>` builds the keep
list from the destination shortlist and the design-corpus gazetteer and drives the seed;
`run-corpus.sh` names it as the campaign's third manual step.

**Clients:** `StandingNotice` under the drawer title (both), the map's `inactive` property from
`isActiveRow` (both), *Inactive* on search hits (both), bounty composer hidden off-active, the About
page's per-state *known · active* pair. Web admin: the water body editor's Listing card is now *Standing*;
`/admin/water/standing` lists the lanes and recent activations.

### The regression net

`standing.test.ts` (34 tests): the **campaign walk** — one body per standing through a re-affirming
re-import, a non-re-affirming campaign prune and the floor prune, each asserted to land where the
table says, with the rung on every cell row — plus transitions, the evidence hooks (including the
three that must *not* flip), every push surface seeding a non-active body and asserting absence, the
seed, the rollover and its once-per-season gate, and the lanes. Core `standing.test.ts` (24) pins the
precedence, the retention arithmetic and the copy.

### Not built, and why

- **The tombstone.** No path hard-deletes a removed row and the walk pins it (D178).
- **Auto-elevation on activation.** EPQS is a plain HTTP point service and an action could fetch it;
  deferred to keep PR 1 to the model. `activatedAt` + `listRecentActivations`' *missing* column are
  the hooks.
- **The attachment matrix as a document.** The cells the model changed are stated in D176/D177
  (a removed body's reports attach, reach no push surface; bays follow the water body; favourites on
  dormant yes / removed no; tracks hidden on removed). The rest — comments, photos, access alerts,
  notification-queue rows — behave as before and were not audited cell by cell.
- **Mobile moderator controls.** Standing is set from the web editor, like every other water body edit.

### PR 2 — requests (built the same day; D179)

**Model** (`@skating/core` `corpusRequests.ts`, `convex/corpusRequests.ts`, `waterBodyRequests`
table): five kinds — `activate` · `admit` · `restore` · `contest_access` · `takedown` — with
`requestKindsFor(standing)` deciding which a water body admits; `create` (one open ask per person per water body
per kind, ten open per person; an `admit` at a point we already hold is refused with `known_water`
+ the body and its standing); `resolveAdmit` (an action: one fetch of the 3DHP waterbody layer,
parsed by `parseCatalogueResponse` — smallest containing polygon, classified, with provenance;
misses and outages recorded on the row, `reresolve` for a moderator); `listMineForBody`,
`listMine`, `openCountsForBody` (public — the "3 people have asked" count); `listQueue` /
`queueCount` (moderator); `approve` (performs the act through `activateBody` / `restore` / `remove` /
`setPublicAccess('open')` / `admitCandidate`, closes siblings, `restore` + `takedown` take an admin) /
`decline` (a note is required — the requester reads it). Audit: `approve_request` / `decline_request` on a
`waterBodyRequest` target; an admitted body gets `set_included_by_request` with the service URL.

**Clients:** `RequestButtons` under `StandingNotice` (both), `AdmitPrompt` on long-press (mobile,
MapLibre RN `onLongPress`) / right-click (web, `contextmenu`) — it resolves the coordinate first and
hands off to a water body we hold; `NewWaterPrompt` mounted in `UnreportedSkates` behind *Add it from your
track*, its matches carrying standing, `removed_water` attaching the skate to the removed water body;
`/admin/water/requests`. Dialog copy is `requestPrompt` in core.

**Tests:** core `corpusRequests.test.ts` (10: kinds by standing, the query URL, the parser's four
outcomes); Convex `corpusRequests.test.ts` (15: every kind's guards, the resolver record, each
approval's effect including the admit insert and the no-twin rule, the queue, the D48 edge).

**Not built:** a notification to the requester (in-app on the water body instead — see D179); a You-tab
list of one's own `admit` asks (`listMine` exists, no surface yet); the archive-lane fallback script
for a service outage (the water body editor's hand-draw is the fallback today).

### The review pass on PR 2 — one root cause, five findings

Greptile returned five times to `corpusRequests.ts`, and every finding was the same one: the
sibling set a decision closes (open asks of one kind on one water body, or on one catalogue feature)
has **no bound by construction**, so every read of it needed its own defense, and each defense
created the next finding — a page cap truncated the group; walking it all could exceed a
mutation's write budget; paging across scheduled mutations let an ask filed mid-drain inherit a
decision made before it existed; and a per-row sibling read in `listQueue` was 200 × 200 documents
against the 16,384-read limit. What shipped: `by_water_body` is `[waterBodyId, kind, status]` so
one kind's open asks are a contiguous range; `decide` closes the request plus one page and
schedules `closeSiblings` for the rest, the range ended at `_creationTime <= decision.now`; the
queue's asker count is grouped from the page already read and marked as a floor when the queue is
a backlog; `listMineForBody` reads by requester (`by_requester_body`), not by everything ever filed
on the water body. **The founder chose paging over a create-time cap on the group** (~100 open asks per
water body per kind would have deleted `closeSiblings` and the snapshot outright); the cap is the
roadmap's Deferred lever if the code bites again. The lesson: bound an unbounded set at the write,
not at each read.

### The seed run — dev, 2026-09-17

`convex dev --once` put both PRs on dev, then `seed-standing --gazetteer=training_data/google_group/gazetteer.csv`
dry, then `--apply` as campaign `standing-seed-20260916` (run row `succeeded`), then
`regionStats:recompute`.

| | |
| --- | --- |
| Scanned | 24,961 |
| **Shelved — dormant, `inactive`** | **23,520** |
| Kept active | 1,441 — 1,377 attached (put-ins etc.) · 52 keep-list · 3 curated · 1 by request · 8 already inactive |
| Active per state | NY 345 · VT 106 · NH 238 · ME 401 · MA 358 |

**The first dry run found three matcher defects**, fixed before anything was applied
(`d6d70e1`, `fd6615c9` — both in PR #64): the gazetteer's `region` is where the *posters* are,
not the water — a Vermont list discusses Lake George, Lake Placid, Saranac and Sebago, all four
"unmatched (VT)"; `normalizeName("Reservoir Pond")` was `""` and matched every body called
"Reservoir" (1,375 candidates); an apostrophe was a word break, so "Joe's Pond" could never meet
GNIS's "Joes Pond". The founder's call on the first: every state in `region_breakdown` is *tried*,
but a match resting on a poster state alone is reported and never kept — the risk is shelving the
right water body to keep a same-named wrong one. In the end only Lake Placid hit that path, and it was
kept by its put-ins anyway, as were every marquee lake on the list.

**What the matcher could not settle** — a hand list for the water body editor's Standing card, since
the seed never re-activates: 23 ambiguous (Long Pond NH ×18 and Beaver Pond NH ×31 want a `near`
coordinate in the shortlist, not a hand fix; Lake George ×3 across states), 27 unmatched (Saranac
is Lower / Middle / Upper in the corpus; Sebago is ME and the gazetteer never mentions ME; the bays
are A09 sub-areas, not bodies). Each seed pass is 12–25 minutes — one `convex run` subprocess per
50-body page — so run it in the background.

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
| **merged** | `dedupStatus: 'merged'` + `mergedIntoId` (D36) | moderator / A07a dedup | no; reads follow the survivor | kept by the prune; **unverified** against the loader |
| **removed** | `removedAt` + `removalReason` (D48) | admin `remove` | no (`isListed`) | **yes** — `importCanonical` preserves it, the prune keeps it (`kept.delisted`) |
| **no public access** | `publicAccess.verdict: 'none'` (A06f) | moderator | yes — dimmed, −2 zoom | yes — the six `scoreFields` sites (A06f §2) |
| **admitted by request** | `includedByRequest` (this phase) | moderator | yes | left alone — the transform drops it at the floor (above) |

Two things fall out of the table. **`isListed` is the only membership predicate the read paths
share** (`lib/listing.ts`: not rejected ∧ not merged ∧ not removed), and the `none` verdict is
deliberately *not* in it — a `none` body is listed. And **"survives re-import" was answered
per-state, in different phases, by different mechanisms** — a field list in `importCanonical`, a
`continue` in the prune, six scoring sites. There is no single test that walks every state through a
campaign. That test is the first thing this workstream should write.

### Workstream L1 — What a `none` verdict does next: on the map and marked, never recommended

> **Superseded by D176 (2026-09-16), the same day it was written.** The kickoff pass generalised
> this into *standing*: a `none` body is one dormancy reason among four, drawn at the dormant rung
> rather than the −2 demotion, and `isActive` is the one predicate. The D-number this section
> proposed was taken by A09. Kept as the record of the argument — the *push vs reference* table below
> is exactly the split the build made.

**The founder's read** ([A06h](./A06h-weather-detail.md), open questions): a moderator-confirmed
`none` should *"eventually remove a body from the corpus rather than have every query learn to skip
it — the ideal situation eventually (way down the line) would be managing 5,000 water bodies that actually
get skated on, not 20,000 nobody ever touches."*

**The scoped version, agreed 2026-09-16.** Deleting on a verdict is the wrong mechanism for the right
goal. A06f's own argument for a third state — someone may hold a key, an invitation, or a landowner's
word, and a ruling we got wrong is only corrected by someone who went anyway — is an argument
against ever purging on it automatically. What the founder actually wants is narrower and better: a
water body nobody can lawfully reach **stops being pushed at people**. So:

> **D175 (proposed) — A `none` verdict removes a body from every *discovery* surface and from no
> *reference* surface.** One core predicate, `isDiscoverable(body)` ≡ `isListed(body) ∧
> !isNoPublicAccess(body)`, applied to every surface that *recommends* a water body and to nothing a
> skater navigates to on purpose. Removal from the corpus stays a human act with a reason (D48).

| Filter — these *push* | Leave — these are *reference* |
|---|---|
| Phase 04 drive-time notification fan-out (`notifications.ts` — `bandForCoord` call site) and the 8 pm nearby digest | the map — never-hide (D49), the dim + demotion is the whole treatment |
| A06h weather-discovery cards (`weatherDiscovery.ts:288` gates on `isListed` today, **deliberately** not on `none`) | search, and the drawer |
| the Phase 06 recommended strip (`listFeed` recommended caps) | favourites — *if you favourited it, you know something we don't* |
| bounty requests fanned to nearby reporters (`bounties.ts`) | the viewport list (already sinks `none` to the bottom — A06f §4) |
| the A08 `great_report_nearby` and `activity_detected` triggers, if the body is the subject | a report or hazard *on* the body — content is never suppressed (A06f's `AccessSection` invariant) |

**Build shape.** This is the A06d "a new surface added to a system that enumerates its inputs" shape,
so the work is the enumeration, not the predicate: each push surface gets the filter *and a test that
seeds a `none` body and asserts it is absent*, because every omission fails silently and
permissively. Five surfaces, five tests, one predicate in core. Its own PR — it touches the Phase 04
fan-out, and should not ride a feature phase.

**The purge half, deliberately human.** `waterBodies.remove` (D48) already exists, takes a reason,
and is preserved through re-import. The only new lever worth building is a **purge-candidate list**
in the admin tree: bodies with `none` standing **and** zero reports for N seasons (A05a boundaries),
surfaced for a moderator to act on one at a time — a queue, never a cron. That gives the founder the
"5,000 water bodies" trajectory without a machine ever deciding a water body is gone.

**Not in L1:** a notification copy change for `content_flag_resolved` on a water body (A06f follow-up
finding 5 — founder call pending); a `none` body's hazards and reports, which stay exactly as they
are.

### What still needs scoping — named, not specced

Each of these has *some* machinery today; the gap in every case is that nobody has written down the
rule and tested it across states. Listed so the pass that picks this phase up scopes them together.

- **Demoting versus removing.** Today there are two demotions (`curatedBoost` < 0, and the A06f
  penalty) and one removal (D48). Whether a moderator needs a *third* rung — "keep it but stop it
  ever surfacing wide" without the legal claim `none` makes — or whether `curatedBoost` already is
  that rung, is a founder call. The A02 editor's Prominence tool already exposes the boost.
- **Keeping a removed body out of the next campaign.** `importCanonical` preserves `removedAt` and
  the prune keeps delisted rows, so today this *works by upsert* — but only because the row still
  exists. If a removed body's row were ever hard-deleted, or its `externalId` changed under a
  catalogue re-key (A07a-3's D95 lane is still unbuilt), the next campaign re-admits it as new, with no
  memory of the takedown. A **tombstone keyed on `externalId`** (or a `removedExternalIds` set the
  loader consults) is the durable version. Wants a test: remove → hard-delete the row → re-import →
  assert absent.
- **What happens to attached records, per state.** `bodyAttachmentKind` (the prune's guard) knows
  what *kinds* of rows hang off a body; nothing states what each transition does to them. The
  matrix to fill in, per attachment kind — reports, hazards (+ recurrences, A05c), comments, photos,
  favourites, bounties, put-ins / parking (A06d), access alerts, sub-areas (inherit listing, A02
  Decision 11), weather-registry rows (A06h), notification-queue rows (A08) — against each transition:
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
water body nobody has tapped stays invisible either way.

**Whether declines should be visible to the requester.** Telling someone "no" costs goodwill; telling
them nothing costs more. Not decided.

---

## Related

[D91](../01-decisions.md), [D62](../01-decisions.md), [`A07a`](./A07a-unified-corpus.md),
[`phase-A02`](./A02-body-editor-and-subareas.md), [`phase-08`](./08-native-capture.md)
