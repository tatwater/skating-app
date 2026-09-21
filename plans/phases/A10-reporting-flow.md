# Phase A10 — Reporting: one sheet, three doors

> **Scoped 2026-09-18, unbuilt.** Founder ask: the reporting flow must feel effortless while
> collecting as much hard data as a skater can give — the least taps, no forced order, the
> author's own voice kept, every report style the community already writes accepted (a one-line
> hazard, a lake writeup, a multi-lake day, a before-and-after-work pair, a drive-by), suggested
> answers a skater can "yep, yep, yep" through without the layout ever moving under them, and a
> post that always lands even with no signal.
>
> **Depends on:** Phase 08 (the recorder + Strava push), A09 (sub-areas as places), A06d + A06e
> (access points, access alerts, solar times), 09a / A05b / A05c (hazard authoring and identity),
> Phase 06 (polymorphic thumbs), A08 (delivery). All landed on dev. **Blocks nothing.**
>
> **Research:** [`research/report-corpus-classification.md`](../research/report-corpus-classification.md)
> — 2,449 community emails hand-classified; 53% contain a report. Every vocabulary and ordering
> call below cites it.
>
> **Decisions minted at scoping:** D186–D200 in [`01-decisions.md`](../01-decisions.md).

---

## Why this exists

Today's `ReportForm` (mobile and web, mirrored) is a single scroll of every field in the schema,
each rendered the way the schema stores it: a datetime picker for when you got off, chip rows for
ice types and surface, a `Single | Range` + `measured | estimated` widget per thickness reading,
one number for snow, a pin for the put-in, a text area. It works, and it is the shape of the
schema, not the shape of a report. The corpus says what a report is shaped like: a quarter of
them are five chips and an access note, a fifth span more than one body or more than one visit,
half locate something by compass or by bay, forty percent give a thickness — but by poke count,
lower bound and "supportable" nearly as often as by a measured number — and **96% never say when
the skater left the ice**, the one fact the whole freshness model sorts by.

The phase replaces the form with a **sheet** that can be filled three ways, wraps per-body reports
in a **Post** that carries the narrative, and gets the hard data out of prose when the author lets
it. It is the last piece of the enrichment era that faces the skater as an author rather than a
reader.

## The shape — Post and Report (D186)

A **Report** stays what it is: one body, one visit, one `skateEndTime`, the hard data, and every
downstream consumer unchanged — body feed, bounties, D56 contradiction, D59 decay, A09 bay
membership, notifications. A **Post** is the new object: the narrative, the photo set, the
ordering, and one or more Reports. The newsfeed and the profile show Posts; the body page and the
map show Reports. A Post **requires at least one Report** — the platform is for reports, and the
email lists remain the place for questions and planning (founder call). Photos are tagged to the
Post *and* to the Report they belong to, so a body page can show its photos without the Post.

That resolves every multi-thing case in the corpus with the same move: the Champlain
circumnavigation is one Post with several Reports (bay membership already handled by A09); the
before-and-after-work day is one Post with two Reports on one body, two end times, and the
freshest-eyes sort just works; a drone flight over the bay is one Post whose single Report is a
scouting observation.

## The sheet (D187)

One scrollable **report sheet**, fixed section order forever, every section collapsing to a
one-line summary once filled, *How was it?* pinned at the top. No wizard: a skater who wants to
put the thickness first scrolls to thickness. The sheet is also the **review screen** after prose
extraction and the **edit screen** after posting — one component, three entrances:

1. **Door one — the chips.** Open on a body, tap through. This is the native format for the
   quarter of reporters who write five-chip reports.
2. **Door two — the page.** The same sheet opened with the prose area focused and everything else
   collapsed below it. Write; the sections fill in as extracted chips (§5) as paragraphs complete;
   scroll down to review. With extraction off, the minimum set (D189) is met by hand.
3. **Door three — the track.** Opened from a finished recording, a pushed activity, a GPX file, a
   parking-lot detection or an unreported skate: bodies, end time, start, put-in, photos-in-window
   and hazards-passed are filled before the skater sees the sheet. The skater's job is *How was
   it?* and anything the track can't know.

**Two tiers of suggestion (D188).** What the author *said* and what someone else *implied* are
different things and the sheet treats them differently:

- **Ghost chips** — suggestions from anything other than the author's own words: other skaters'
  recent reports on the body, the weather, the track's geometry, a prior visit. Outlined, glyphed;
  only a tap makes one solid and only solid persists. Peer suggestions render as one collapsed line
  per section — *"2 people said glass earlier today — same?"* — that expands to ghost chips.
- **Extracted chips** — values a machine read out of the author's own prose (§Extraction). These
  arrive **pre-selected**, marked *from your writing*, with their evidence span a long-press away,
  and **persist unless the author deselects them**. The author already said it once; making them
  say it again with a tap is how reports end up half-complete. An extraction below its field's
  precision floor (§1.4) demotes to a ghost chip — confidence decides the tier. When any extracted
  chip exists, the Post button becomes **Confirm & Post**: one screen lists everything *from your
  writing* — the safety-flavored values first (don't go, suitability, thickness, hazards) — and one
  tap both confirms and posts. Never a tap per chip; always one glance (founder call, 2026-09-19).

Nothing another skater or a model *guessed* is ever stored as this author's observation; nothing
the author *wrote* is thrown away for lack of a tap. The layout never reorders around either.

**One Post button, and a draft.** On mobile, *Post* never fails for lack of signal: it enqueues,
flushes if online, and otherwise lands on the *Waiting to send* screen (§9). *Save draft* stays as
the deliberate "not done yet" — a skater must never face "finish now or lose it" — but it is not
the fallback for no bars. On web there is no queue: a Post with no connection fails with a message
and the draft survives a refresh (§10).

**The freshness window (D199).** A Report's end time may be at most **seven days** before now and
never in the future (the existing clock-skew tolerance stays). The picker cannot offer an older
date; a saved draft, a queued item or an imported track older than the window is refused with a
plain message — at flush too, so a phone that comes back online after a week does not post a
stale report. Editing an existing Report is always allowed. `reportTime − skateEndTime` is stored
on every report and is reviewed after a season before the window is tightened.

**The minimum set (D189)** per Report, engine-independent: a body, an end time, *How was it?*, and
one of {an ice or surface chip, a thickness reading, a hazard}. A scouting Report substitutes
"still open / frozen over / snow-covered" for the last term. Prose alone never posts; with
extraction on, prose usually satisfies the set and the review is a confirmation; with it off, the
same fields are four taps.

## The fields, section by section

Every section below names its storage; §2 carries the schema diff. Imperial in, metric stored
(D25) throughout.

**How was it?** Two axes on one row each (D190): `skateQuality` great / good / fair / poor, and
**suitability** — *don't go* / *experienced only* / *not for beginners* / *beginner-friendly*.
"Don't go"
lives on the suitability axis because it is a claim about *who*, not about "safe" (D3 explicitly
makes don't-go reports first-class). The quality row's left end must never read as safe; the copy
is checked for that.

**How did you see it?** (D191) *On the ice* (default) / *from shore* / *someone told me*. Two taps
to change. Stored as `observedFrom`; the reader-facing card carries it. This is where the corpus's
15% scouting and 9% relay land: three peer values of one provenance field, none of them a kind.
The one asymmetry is in the minimum set — a shore observation may substitute *still open / frozen
over / snow-covered* for a chip it cannot honestly offer, while a relayed thickness is still a
thickness reading, just marked secondhand.

**When did you get off?** (D192) Required. GPS fills it exactly when a track exists. Otherwise a
chip row: **"04:12 PM"** — the minute the sheet was opened, pinned, kept if the draft is resumed
later — then half-hour steps backward, then a date picker bounded by D199. Preselected only when the open time
falls in plausible daylight for the body (A06e's solar times); after dark, nothing is preselected
and the row starts at sunset. `skateEndPrecision: gps | minute | half_hour` is stored; there is
no part-of-day value on purpose. Start time or duration stays optional, same widget as today.

**Ice and surface.** The existing chip rows, plus **where** (D193): after a chip is selected a
small affordance offers *whole lake* / *mostly* / *patches* and the `where` union — a named bay
(A09), a compass **sector** (N / NE / E … / center / near shore, computed from the body's geometry
by `compassPointFor` so "north end" renders as a soft highlight), or a coarse **point** from a tap
on the mini-map (the A05b tap-to-place primitive). Named landmarks ("off Shelburne Point") are a
later ETL (§Later); the union reserves `point` with a `name` for them. Storage widens
`iceTypes: string[]` to `{type, where?, note?}[]`, same for `surfaceTags`.

**Snow** (D194). Three chip rows from the corpus — **coverage** (none / patches / lanes through it
/ mostly / everywhere), **impediment** (didn't matter / slowed me / avoided areas), **drifts**
(none / avoidable / everywhere) — plus optional depth (dusting / ~inches) and *plowed path*.
`snowCoverCm` becomes a `snow` object; the old number backfills as `depth`. Dry-vs-heavy texture
stays in prose for v1 and is watched.

**Thickness** (D195). Quick path: a chip row *under 2 / 2–3 / 3–4 / 4–6 / 6+ / didn't check* with
scope *everywhere I tested* or *at this spot* (a `where`). Precise path: today's readings, with
`THICKNESS_METHODS` widened to `measured | estimated | poke`, a **poke count**
field on `poke` (person-relative; the reading keeps the count and the skater's own inch estimate
separately), a lower-bound-only reading (`minCm` without `maxCm`), and a `supportable |
unsupportable` flag a reading may carry — the skater's word, never ours. Multiple readings, each
with an optional `where`.

**Hazards.** D55 bundling stays. Three additions: (a) *mark one here* — the A05b authoring flow
launched from the sheet with the Report as provenance; (b) **you skated past these** — the track
∩ each active hazard's stored `bbox` footprint, computed client-side over the cached per-body
hazards, yields a tick-through list that files confirmations `via: 'report_flow'` (the value has
existed since D12 with no caller); (c) a `ridge_crossing` passage marker is offered on any
pressure ridge the track crossed; (d) with **no track**, the same component asks *did you see any
of these?* over the body's active hazards — bounded, nearest to the chosen put-in first, the D52
verdicts plus an explicit *didn't go there* so that silence is never a vote. The track version is
the no-track list filtered by the path.

**Access.** Tap your put-in and lot on the mini-map with A06d's known points drawn; *use my
location* if still there; a GPS start point **snaps only within a fixed radius** (D198,
`PUT_IN_SNAP_METERS`, start at 150 m) and otherwise asks. Then optional **condition chips** on the
put-in or lot (D197) — `icy_lot`, `mud_at_launch`, `plank_needed`, `walk_in`, `plowed_trail`,
`snowed_in` — a **separate** `ACCESS_CONDITION_REASONS` set on the same `accessAlerts` row, so
they ride A06d's decaying, corroborated alerts with the Report as provenance without reading as
blockers (a live blocker demotes the launch in directions; a plank does not), plus a one-line
note. This structures "plank needed at the
boat launch" and "pull-off is sheer ice, park on the road" without a new table.

**Photos.** *Photos from your skate* is one tap: a media-library query over the activity window
(±30 min; "same day" as the wider option), EXIF read on device for time and coordinate, plotted
along the path as a local preview *before* anything uploads. The skater picks the subset; the
rest are simply not uploaded — **nothing is ever deleted from the camera roll**. `placeOnMap`
stays the D42 opt-in and is the visible consequence of the preview. A photo can be tagged *this is
a hazard*, which opens (a) above pre-located from its coordinate or its position in the track.
Vision-suggested hazard types are §Later. **Video** is a second pass (§8.3): the same window query
returns clips, but `photos` is image-shaped and video wants a device-made poster frame, a size
ceiling, playback on both surfaces and probably R2 rather than Convex file storage for a
drone-length clip. Drone footage needs no vendor API for that — the DJI app saves clips to the
phone's camera roll, where the window query already finds them.

**Title and prose.** A Post has a **title** — the community's subject-line habit, "Crystal Lake,
Enfield 12/6" — and a body; the sheet encourages both and extraction reads both. Prose is always
available and always the author's; it lives on the Post, not the Report (a Report may carry a
short per-body note). With extraction on it is also door two.

## Extraction (D196)

Prose → structured fields is **author-side**: it fills the author's own sheet, the author reviews
every field with its evidence span before anything persists, and the author is the claimant. It
is not Q9's reader-side digest and does not touch L6. The contract is engine-independent:

```
{ text, bodyCandidates[], subAreas[], sectors[], enums }
  → { reports: [{ bodyRef, visit?, fields: { iceTypes: [{ value, confidence, evidence }], … } }] }
```

Runs as a Convex action over title + body, per completed paragraph (debounced), online only —
offline the prose is kept and the sheet is filled by hand. Each value comes back with a
confidence; at or above its field's floor it is an **extracted chip** (pre-selected, persists
unless deselected), below it a ghost (D188). **Opt-out** is a persisted profile preference; an
opted-out author still gets an *Extract from my writing* button per Post, and their minimum set
is the same four taps. The privacy policy gains a sentence: report text you choose to have parsed
is sent to a model provider for that purpose only.

**Two engines, two stages, built from the start** (both keys are in hand):

- **Stage A — Claude, segmentation.** Haiku 4.5 first, Sonnet 5 if the eval says. Title + body →
  observation *units*: which sentences belong to which body and which visit, plus candidate spans
  — numbers with units, poke counts, compass phrases, named places, clock times. Structured
  outputs against a Zod schema. This is the multi-hop, free-string half: Jev is documented weak on
  indirection and cannot return a string it was not offered.
- **Stage B — Jev, voting.** Per unit, one request fanning out a `noul` over every enum value (ice
  types, surface tags, hazard types, snow facets, suitability, don't-go, `observedFrom`) and a
  `choice` over Stage A's candidates for thickness, snow depth and `where` (the body's bays and
  sectors as options, `none` hatch). Jev returns a calibrated probability per value — the tier
  decision reads straight off it, and a value it was never offered cannot appear.
- Both behind one `Extractor` interface; a Claude-only extractor exists too. The eval runs both
  per field: if Claude-only matches Jev on the enums, Stage B is not earned and is dropped.
  Cost is under a cent per report either way; latency is two round trips, ~2–4 s per paragraph.
- `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` live in the Convex dev env; their `05-accounts` rows
  land with §5.1, when code first reads them and `credentialsRegister.test.ts` demands the rows.

## The corpus replay (D200)

Three seasons of community email, replayed into a **dedicated replay deployment** as Posts and
Reports by fake authors on the dates they were sent — never on the shared dev deployment, where
the alpha crew would be reading other people's words under invented names (the L5 line, whatever
the byline says). Two things it buys, in order of value:

1. **A populated world.** Decay, seasons, weather-since, contradiction settling, bounty
   fulfillment and the freshest-eyes sort were all built against a handful of test reports. The
   replay gives every one of them 1,300 real reports across three winters to be judged on, and the
   founder a feed that feels like a season.
2. **The coverage check.** For every email with a report in it, the extraction pipeline (§Stage A +
   Stage B) produces the Post and its Reports *and* a **miss list** — anything the author said that
   the contract has no slot for. The miss list is the "pause and decide" list the founder asked
   for, generated in an hour rather than a season. The question it answers per email is the one
   that matters: *could this person have conveyed what they wrote through our components?* Not
   whether they would have tapped it.

Mechanics, all of which exist or are one internal function away: `REPORT_SOURCES` has carried
`imported` since Phase 02 (Q8's inbound-bridge shape); an internal `posts.importBackdated`
bypasses D199 and stamps `reportTime` from the email date; fake profiles via the Clerk CLI on a
replay Clerk instance (or profile rows with a synthetic subject — a call at build); the weather
archive already reaches past 92 days (D153); hazards in prose become hazards on the body located by
`where`. The replay deployment is disposable — wiped and re-run whenever the contract changes —
and its data never migrates anywhere.

## Review pass — 2026-09-19

A fresh-eyes review against the code, before any build. What it found and what changed:

- **Wrong claims corrected.** The flush order is hazards → tracks → reports, not tracks first.
  `compassPointFor` is a label lookup; the sector geometry is new (§3.2) and casts from the
  interior point. `strava_path` has no caller either — passed-hazards is a first build, not a
  wiring job (§3.4). A min-only thickness reading is a validator change, not a schema one.
  `validateReportInput` requires only body + end time, and its header says a notes-only "don't
  skate here" is valid by design — so the minimum set is create-only (§2.4). `reportTime −
  skateEndTime` is a query, not a field. The mobile EXIF pass reads coordinates, not `takenAt`.
  D55 bundling does not survive a saved draft today (§9.1).
- **Consumers listed** (§2.4): a dozen readers of `iceTypes` beyond the four named, the
  calibration instrument's hard-typed method, `readingUpperCm` on a min-only reading, the photo
  orphan sweep, content purge, data export, flag and moderation targets, notification
  coalescing, bounty fulfillment on thumbs.
- **Shape changes.** One transactional `posts.create`; Post moderation semantics; conditions as a
  reason set separate from blockers; `observed_others` dropped; `sighting` added; no
  `observedFrom` backfill; `where` composes bay + sector; thumbs stay on Reports; five PRs, not
  four, with the plumbing PR ahead of the sheet.
- **Founder calls the same day:** *Confirm & Post* for extracted chips; partial Posts show their
  matching Reports; moderation per Report or per Post; no register note for the eval corpus; a
  week-old Post takes no new Report (D199); the whole corpus replayed on its own deployment, the
  miss list as the coverage check (D200).

## Workstreams

### §1 — Extraction eval and contract *(experiment; gates §5)*

- §1.1 The contract above as a core type + a Zod schema; an `Extractor` interface with one method.
- §1.2 The eval harness under `training_data/google_group/eval/` (gitignored): the recall tier
  scores presence and kind against `classify/labels_all.jsonl`; the **value tier** needs ~150
  reports field-labeled (a Sonnet agent drafts, a human verifies) — labeled here, not assumed.
- §1.3 Run three extractors — Claude-only (Haiku 4.5, then Sonnet 5) and Claude + Jev — and
  record precision/recall per field, latency and cost per report. The harness takes any
  `Extractor`; the title is part of the input. ⚠ **Fix the prompt-cache boundary first:** the
  2026-09-19 mention inventory (Haiku over 2,449 emails) cost $5.68 because caching never engaged —
  the shared prefix (system prompt + vocabulary) sat after the per-message text. Confirm
  `cache_read_input_tokens > 0` on the second call before running the corpus.
- §1.4 The go/no-go for ghost-chip extraction is a per-field precision floor — a wrong ghost chip
  is a tap to dismiss, but a wrong *confident* one on thickness is a claim we suggested. Floors are
  set from the first run, not before it.
- §1.5 **The corpus replay** (D200): a replay deployment; `posts.importBackdated` (internal,
  `source: 'imported'`, skips D199, stamps the email date); fake authors; the extraction pipeline
  run over every report-bearing email (1,309) producing Posts + Reports + the **miss list**;
  a `replay-summary.md` under `training_data/` that groups the misses by what they would need
  (a new enum value, a new field, a `where` the union can't say, a kind of report the sheet has
  no door for). The founder reads the miss list, not the UI. Re-run on every contract change; the
  miss count is the coverage metric. Named-landmark mentions from the inventory feed the §Later
  ETL from here.

### §2 — Schema

- §2.1 `posts` table: `authorId`, `title`, `body` (prose), `reportIds[]` (ordered), `photoIds[]`,
  `latestSkateEndTime` (denormalized from its Reports — the D28 sort key; never `createdAt`),
  `moderationStatus`, `idempotencyKey`, `createdAt / updatedAt / editedAt`. Indexes lead with
  `moderationStatus` (the `isDone: false` lesson on the feed index), then `latestSkateEndTime`;
  `by_author`. `reports.postId` (optional; `eq()` reads only — the optional-index trap), backfilled
  one Post per existing report. `reports.putInId` (the tapped A06d point; `point` stays the
  representative coordinate). `photos.reportId` beside the Post link. `accessAlerts.reportId` +
  `idempotencyKey` (today `accessAlerts.create` has neither, so a replayed flush would file a
  corroborable claim twice).
- §2.2 `reports`: `observedFrom` (no backfill — absent means unstated), `suitability`,
  `sighting` (open / skim / frozen / snow_covered; valid only off-ice — the scouting term of the
  minimum set has storage), `skateEndPrecision`, `iceTypes` / `surfaceTags` widened to located
  objects, `snow` object, `iceThickness.readings[].{method, pokeCount, supportable, where}` and
  `iceThickness.scope`. A min-only reading needs no schema change — all three numbers are already
  optional; only `validateReportInput`'s "a range needs both" rule relaxes. `snowCoverCm` kept
  through widen→deploy→backfill→narrow, then dropped; `snow_covered` / `drifted` stay in
  `SURFACE_TAGS` for old rows, leave the sheet, and the Phase 04 `noSnow` filter reads both through
  one accessor.
- §2.3 Enums in `@skating/core`: `OBSERVED_FROM`, `SUITABILITIES`, `SIGHTINGS`,
  `SKATE_END_PRECISIONS`, `SNOW_COVERAGES / SNOW_IMPEDIMENTS / SNOW_DRIFTS`, `THICKNESS_METHODS`
  → `measured | estimated | poke` (no `observed_others` — that is `observedFrom`'s job; "fishing
  holes were 4 inches" is `estimated` + note), `ACCESS_CONDITION_REASONS` as a **separate set**
  from `ACCESS_ALERT_REASONS` (a condition is not a blocker: `accessPoints.ts` puts every live
  alert's target into `blockedIds` and directions demote it), `WHERE_KINDS`. `06-data-model.md`
  register updated (`dataModelRegister.test.ts`).
- §2.4 Validators and every consumer. `posts.create` is **one transactional mutation** taking its
  Reports inline (one Post key, per-Report idempotency keys) — a Post-less Report can never exist
  and "a Post requires a Report" is enforceable. The minimum set (D189) and the freshness window
  (D199) apply on **create only**, version-gated; `update` keeps today's rule so no existing
  notes-only report becomes uneditable. Readers of `iceTypes` / `surfaceTags` as `string[]`, every
  one through a core accessor: `reputation.ts` (`shareIceType`, D50 corroboration),
  `recommended.ts` + `reports.ts` (`black_ice`), `feedFilters.ts` (Phase 04 incl. `noSnow`),
  `feed.ts` chips, `contradictions.ts`, `reports.ts` feed cards / `recentCardsForBodies`, both
  `WaterBodyDetail`, `ReportDetail`, `FeedFilterBar`, the weather reducer, the admin rollups, and
  their tests. Readers of `readings[].method`: `iceCalibration.ts` (hard-typed
  `'measured' | 'estimated'` — D160's instrument counts `measured` only; `poke` is excluded like
  `estimated`), `reputation.ts` (`measured_thickness` boost), `feedFilters.ts` (`readingUpperCm` —
  a min-only reading has no upper bound and must read as *unknown*, not pass), `contentPurge.ts`
  (per-reading note redaction). One-report-per-post assumptions: `listFeed` (paginates reports;
  becomes a Post feed that lists matching Reports under a header), profile history,
  `seasonsForBody`, `notifications.ts` coalescing (`latestReportId` on a multi-body Post: the
  bucket names the Post, the tap target is the Report), `bodySummary.latestReportAt`,
  `attachReportToOpenBounties`, `ratings.ts` (bounty fulfillment flips on a helpful thumb *on the
  Report* — thumbs stay on Reports). Photos: `photoOrphans.ts` and `photoReconcile`'s expiry
  mode scan `reports.photoIds` + `hazards.photoIds` + access only — they learn `posts.photoIds`,
  and one writer (`lib/postPhotos.ts`) keeps `posts.photoIds`, `reports.photoIds` and
  `photos.reportId` from drifting on an edit. Departed-user redaction: `contentPurge.ts`
  `CATEGORIES` gains `posts` (title + body are exactly the typed-text bucket D62 clears at 30 days;
  the cutoff is the Post's `latestSkateEndTime`); `dataExport.ts` enumerates posts;
  `FLAG_TARGET_TYPES` / `TARGET_TABLE` / `resolveFlagTarget` and `MODERATION_TARGET_TYPES` gain
  `post`. Moderation semantics: a Post hidden ⇒ every Report hidden (and the `reportSubAreas`
  mirror — the writer list in `schema.ts` grows by one); one Report hidden ⇒ the Post shows the
  rest with all its prose; zero visible Reports ⇒ the Post is not shown. The same rule for feed
  filters: a Post appears with only its matching Reports under the header and not at all when none
  match, so filters stay per-Report and the `posts` indexes carry no filter columns. A `where: subArea(id)` on a chip is a label
  inside the Report and does **not** change A09 membership (`reportSubAreas` stays track- or
  point-derived); surfacing chip-located reports in a bay feed is a later read enhancement.
  The old web `ReportForm` (a `string[]` writer) keeps working against the widened schema until
  A10-5 — a dual-write validator, budgeted here.

### §3 — Core sheet model

- §3.1 A pure `ReportSheetState` reducer: sections, fill state, collapse summaries, the
  minimum-set check, the three chip states (`ghost` never serializes; `extracted` serializes and
  is marked; `solid`), and "author-touched fields are never overwritten by a later extraction".
- §3.2 `where`: the union, and **new** sector geometry — `compassPointFor` is a bearing-to-label
  lookup with no geometry and is reused only for the label. Wedges are cast from the body's
  **interior point** (never `centroid`, which is Turf `pointOnFeature` and sits on the shoreline),
  clipped to the outline; on a body with sub-areas a sector composes with a bay
  (`where = {subArea?, sector?}`: "north end of Malletts Bay"), which is what keeps a wedge honest
  on a concave or multi-lobed body; scoped to a bay, `sector` also takes `head` / `mouth` from the
  bay's mouth line (D193 amendment) — "the back of the bay" is a direction, not a name. `fast-check` property over real outlines: the sectors
  partition the outline, each non-empty, each inside it.
- §3.3 End-time chips: pin-at-open, half-hour ladder, solar gating, precision stamping, the D199
  window — `fast-check` across DST and midnight and the week boundary.
- §3.4 Passed-hazards: track × footprint bbox → candidates, refined by Turf against the footprint.
  **New**: neither `report_flow` nor `strava_path` has ever had a caller; D12's second bullet is
  built here for the first time.
- §3.5 Photo-window selection and EXIF → path-time placement (pure, given a track). The mobile
  EXIF pass today reads the coordinate only; `takenAt` is read here for the first time.

### §4 — Mobile: the sheet and its doors

- §4.1 The sheet replaces `ReportForm` (Tamagui); sections as collapsible summaries; *How was it?*
  pinned. Same component for create, review and edit (A06f's edit path folds in).
- §4.2 Doors: from a body (chips), from the New Post tab (page), from a finished recording, from
  `UnreportedSkates`, from a parking-lot detection (D20's on-water test at app open, when a skate
  today has no Report), from a saved draft, from **GPX import** (file picker → `pathToBody` →
  one Post if one day, a guided sequence if several), and from **search** (pick one or several
  bodies, no track).
- §4.3 Multi-Report Posts: the sheet stacks one section-set per Report with a body header;
  *add another lake* / *add an earlier visit* (same body, earlier end time).
- §4.4 Suggestions from others' recent reports as collapsed lines (D188).

### §5 — Ghost chips and extraction wiring

- §5.1 The Convex action behind the `Extractor` (Stage A + Stage B, or Stage A alone per the
  eval), behind the contributor + minor gate `reports.create` uses and a per-user meter
  (`lib/apiMeter.ts`); Stage A runs over the full title + body once per completed paragraph with
  a sequence guard (a late result never overrides a newer one or an author-touched field), Stage B
  per unit; evidence spans on long-press of an extracted chip. Stage A's per-body segments fill
  each Report's `note` with that body's own sentences (author-editable) — the body page shows
  prose without the Post.
- §5.2 The opt-out preference (a `NOTIFICATION_PREF_KEYS`-style profile pref), the per-Post
  *Extract from my writing* button, the privacy-policy sentence.
- §5.3 The two tiers: extracted chips pre-selected at or above the field floor, ghosts below;
  gated on §1.4's floors per field.

### §6 — Hazards in the flow

- §6.1 *Mark one here* — the existing `HazardCapture` (on-ice FAB *and* the from-the-couch
  tap-to-place of A05b) launched from the sheet as its third entry point, Report as provenance.
  One component, three doors; nothing new is drawn.
- §6.1a D55 bundling: without a track the candidate window (author's own unattached hazards on
  the body) widens to the whole day when no start time is given, so a morning hazard reaches an
  evening write-up. The ids must ride the offline draft (§9.1).
- §6.2 *You skated past these* tick-through, confirmations `via: 'report_flow'`.
- §6.3 Ridge-crossing offer on crossed pressure ridges; photo → hazard pre-location.

### §7 — Access in the flow

- §7.1 The put-in / lot picker over A06d points; snap radius (D198); create-new falls through to
  the A06d put-in flow.
- §7.2 Condition chips → access alerts (D197) with Report provenance; the one-line note.

### §8 — Photos

- §8.1 `expo-media-library` (new direct dependency) time-window query; EXIF on device (the D31/D42
  pass already exists); the path preview; subset selection; tag to Post + Report.
- §8.2 Web: drag-drop with the same window logic from EXIF.
- §8.3 **Video** — second pass: clips from the same window query, poster frame made on device
  (`expo-video-thumbnails`), a per-upload size ceiling, playback via `expo-video` / `<video>`,
  storage on R2 rather than Convex file storage above a threshold; `photos` grows a `kind`
  or a sibling `media` table — decided when the pass is scoped.

### §9 — Offline (mobile only)

- §9.1 *Post* enqueues a Post + its Reports + attachments as one unit in the draft queue and
  flushes as one `posts.create`; the flush order is hazards → tracks → reports (`flushService`,
  safety content first) and a Post takes the report slot. D55 bundling must survive the queue —
  today `ReportDraft` carries no hazard ids and `toCreateArgs` never sends `attachHazardIds`; only
  the online path bundles. Fixed here.
- §9.2 The *Waiting to send* screen: signal state, the queue with hazards first, "safe to close".
- §9.3 Extraction offline: prose kept, action runs at flush *only if* the author asked for it
  before posting; nothing is ghost-chipped after the fact.
- §9.4 The D199 window is enforced at flush too: an expired queued item is surfaced, not posted;
  `UnreportedSkates` stops offering a skate older than the window.

### §10 — Web console

- §10.1 A full-screen authoring view: the body map with the path and placed photos, a thumbnail
  rail, the prose page, and every section of the sheet as a panel — the same sheet model, a
  different composition for keyboard and width. Dark-mode language from the Figma file.
- §10.2 Multi-Report Posts as tabs over one map.
- §10.3 State: **TanStack Form** holds the field state, bound to the core reducer's validation
  (§3.1); a small `localStorage` subscription keeps a half-written Post across a refresh. No
  offline queue on web — a Post with no connection fails with a message. No Zustand (one route,
  no cross-route state) and no SQLite; TanStack Store is the primitive under Form and Query,
  not something to adopt.

### §11 — Thumbs stay on Reports

- §11.1 No thumbs on Posts: nothing consumes them — D59 freshness, bounty fulfillment
  (`ratings.ts`) and D50 trust all key on Reports. The Post card shows the sum of its Reports'
  thumbs; a thumb from the card lands on the Report it is under.

### §12 — The reading side

- §12.1 Cards and details show `observedFrom`, suitability and don't-go; the body page shows
  **several** latest Reports, not one; the feed shows Posts.
- §12.2 Aggregates that read `iceTypes` learn about `where` (a "black ice, north end" isn't
  "black ice everywhere").

## PR breakdown

Fewest sensible PRs; sub-workstreams are commits.

- **A10-1 — §1 + §2.1–§2.3 + §3.** The eval, the schema (widen half), the core model. Pure and
  testable; no UI. Deploy, backfill Posts and snow, narrow.
- **A10-2 — §2.4 + §9 + §12 + §1.5.** The plumbing: `posts.create`, every consumer, the purge/export/
  moderation paths, the offline queue reshaped around Posts, the reading side on both surfaces,
  the dual-write validator for the old web form, and the corpus replay (its import needs
  `posts.create`'s shape). What every later PR depends on.
- **A10-3 — §4.1, §4.3, §4.4 + §6 + §7.** The mobile sheet with the chips, page and
  recording/unreported-skate doors; hazards; access. Device-tested on the Android preview build.
- **A10-4 — §5 + §8.1–§8.2 + the rest of §4.2.** Extracted chips, photos, GPX import, the
  parking-lot and search doors; gated on A10-1's eval floors.
- **A10-5 — §10.** The web console. §8.3 (video) is a backlog doc, not a PR.

## Budgets

Set to be tested against, and broken with a reason when completeness wins: a quick hazard ≤ 3
taps / 15 s; a track-backed Report ≤ 60 s with nothing typed; a no-track Report ≤ 2 min. The
founder expects roughly half of skates to arrive without a track; the no-track path is a first
path, not a fallback.

## Later

- **Named landmarks** — scoped as [`features/named-landmarks.md`](../features/named-landmarks.md)
  (2026-09-20), scheduled with A10-2: OSM/GNIS islands, points, beaches, narrows and reference bays
  as `bodyLandmarks`, map labels, and `where: point(name)`; extraction maps "off Shelburne Point"
  onto them. Sub-areas by chord are [`features/subarea-chord-editor.md`](../features/subarea-chord-editor.md).
- **Painting** ice, surface or snow onto the body — web-only if ever (terra-draw has no RN
  adapter); the `where` union is the honest 90%.
- **Vision-suggested hazard types** on a photo the skater already called a hazard.
- **Snow texture** as a chip if prose shows it matters.
- **Garmin / Coros / Health adapters** — `ACTIVITY_PROVIDERS` already reserves them.
- **Outbound bridge** — posting a Post to the author's email list on their behalf (Q8's outbound
  half) fits naturally once Posts exist — scoped in
  [`backlog/email-group-bridge.md`](../backlog/email-group-bridge.md).
- **Water-body map in feed cards and the report sheet** (Phase 05 decision 6, never built on the
  feed) — folded into this phase by founder call, 2026-09-20; a workstream to name when A10-1 opens.
- **Subject-line reports** — a title field on the Post is cheap; whether extraction should read it
  is a §1 question.

## Ruled out

- **A wizard.** Order is the enemy of the ADHD requirement and of muscle memory.
- **A part-of-day end time.** It is vaguer than the answer we want and everything downstream
  (freshness sort, weather-since) is better with a half-hour estimate than with "afternoon".
- **Relay as a report kind.** The other person should post; if they can't, *someone told me* is
  provenance the reader can see, not a kind that needs its own decay.
- **Pre-selected suggestions from anyone but the author.** Peer and data suggestions are ghosts
  (D188); only the author's own extracted words arrive selected, through *Confirm & Post*.
- **A multi-body report row.** Everything downstream keys on one body; the Post carries the many.

## Open at scoping

1. The extraction engine's per-field floors — §1 answers with numbers.
2. `PUT_IN_SNAP_METERS` — 150 m is a guess to be tuned on real tracks.
3. The video pass (§8.3): its storage threshold, and when it is scoped.

Settled 2026-09-19 (founder): extracted chips confirm through one *Confirm & Post* screen; a
partial Post in the feed shows its header with only the matching Reports (fallback if it feels
broken: the whole Post when any Report matches); a moderator acts on one Report or on the Post and
visibility follows — a hidden Report leaves, the Post and its prose survive; the eval corpus needs
no register note.
