# Phase A10 — Reporting: one sheet, three doors

> **Scoped 2026-09-18; A10-1, A10-2 and A10-2b built 2026-09-21.** Founder ask: the reporting flow must feel effortless while
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

## Built record — A10-1 (2026-09-21, `phase-a10-reporting-flow-1`)

§1 (the eval and the contract), §2.1–§2.3 (the schema, widened → deployed → backfilled → narrowed
on dev) and §3 (the core sheet model), in twelve commits off `main` at `b6ced1de`. Suites at build:
core 2,858 · convex 1,698 · extraction 24 · web and mobile unchanged and green. Dev backfilled:
`reports.backfillA10Shapes` lifted 2 rows, `posts.backfillFromReports` created 2 Posts. **Prod is
deferred, as for every phase since A01.** Eval spend: $8.3 of the founder's $20 (Haiku $2.1,
Sonnet 5 $6.2 including 28 failed calls); Jev $0.053 for 310 requests / 2.0M tokens — a blended
2.7¢ per MTok, ~40× under Haiku's input rate (founder, from the console).

### What shipped, by workstream

- **§2.3 the vocabulary** in `@skating/core` (`OBSERVED_FROM`, `SUITABILITIES`, `SIGHTINGS`,
  `SKATE_END_PRECISIONS`, `SNOW_*`, `THICKNESS_METHODS` + `poke`, `THICKNESS_SCOPES`,
  `WHERE_EXTENTS`, `SECTORS`, `ACCESS_CONDITION_REASONS` disjoint from the blockers) and the `where`
  union as one object (`where.ts`). `06-data-model.md`'s register and its guard test cover them.
- **§2.1–§2.2 the schema**: `posts`; `reports.postId` / `putInId` / `skateEndPrecision` /
  `observedFrom` / `sighting` / `suitability` / `snow` / located chips / widened readings;
  `photos.reportId`; `accessAlerts.reportId` + `idempotencyKey`. `validateReportInput` accepts the
  pre-A10 input shapes forever and normalizes at the contract; `minimumSetGaps` is D189 as a pure
  check. Every reader goes through `iceTypeKeys` / `surfaceTagKeys`; the server DTOs keep the key
  arrays, so the clients changed by one call each.
- **§3.1** `reportSheet.ts` — the reducer: fixed sections, fill and summaries, the three tiers, the
  touched-field rule, the sequence guard, the sheet's own `observedFrom` default that yields to the
  author's prose, `confirmList` safety-first, `toReportInput`, `sheetGaps`.
- **§3.2** `sectorGeometry.ts` — wedges + `middle` partition, `near_shore` overlapping, cast from
  the interior point and clipped with turf; fast-check over six real dev outlines (a committed
  fixture: Willoughby, Morey, Dunmore, Shelburne Pond, Waterbury Reservoir, Curtis Ponds).
- **§3.3** `endTimeChips.ts` — the pinned minute, the local half-hour ladder, solar gating, the D199
  predicate; fast-check across both 2026 DST transitions and the week boundary.
- **§3.4** `passedHazards.ts` — bbox prefilter, footprint distance, segment crossing for linear
  hazards; **§3.5** `photoWindow.ts` — the padded window, the same-day option, EXIF-then-path
  placement.
- **§1.1** `packages/extraction` — the contract (types + Zod, misses first-class), `Extractor`, the
  floors table, and three engines: Claude-only, Stage A (segmentation) and Stage B (Jev voting).
- **§1.2–§1.4** the harness under `training_data/tools/eval/` (gitignored): the stratified sample,
  the runner with a dollar cap, the recall-tier and value-tier scorers, the floor sweep, the label
  drafter, and `review.html` for the founder's pass.

### What the eval found — first run, provisional

The 147-email stratified sample (≥ 15 per report kind, seed 20260921) plus 60 non-report emails
for the recall tier's false positives. Three engines: Claude-only Haiku 4.5, Claude-only Sonnet 5,
Claude Haiku + Jev. Value labels are **Sonnet's draft, unverified** — the founder's pass through
`review.html` is what turns these into floors that ship.

| engine | ¢ / email | mean latency | has_report F-score | hazards F-score (recall tier) | thickness F-score | poke F-score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-only Haiku 4.5 | 0.64 | 4.4 s | 93% | 83% | 88% | 93% |
| claude-only Sonnet 5 | 4.22 | 37.4 s | 99% | 89% | 86% | 100% |
| Haiku + Jev | 0.49 + Jev | 4.6 s | 96% | 84% | 83% | 96% |

- **Sonnet is 7× the cost and 8× the latency of Haiku** for a few points of precision, and 28 of
  147 calls failed on output length (`max_tokens` at 8,192 — raised to 16,000; three still fail on
  journal-length emails). Not the sheet's engine.
- **Jev's calibrated probabilities separate; Haiku's self-reported confidences mostly do not.**
  Against the draft labels, Haiku's confidence reaches the target precision on one field
  (`iceTypes` at 0.90); Jev reaches it on `iceTypes` (0.93 → 81%, 121 values), `surfaceTags`
  (0.99 → 82%, 38), `hazards` (0.98 → 94%, 17) and `accessConditions` (0.66 → 80%, 10). **Stage B
  is earning its place on the enums** — the plan's drop condition ("Claude-only matches Jev") did
  not hold on this run. Thickness reached 90% at 0.98 on one pass and lost it on the re-run with
  support exactly 10; no floor.
- **The two Claude engines disagree on ~40% of values** (712 of 1,474 drafted values contested
  between Sonnet and Haiku), and only a tenth of that is report-splitting (visit numbering, "the
  Broads of Newfound" as its own body). That is the case for the verification pass in one number:
  precision against a draft is precision against Sonnet's opinion.
- **Jev is noisy below 0.5 and over-fires on `thin_ice`, `ridge_crossing`, `supportable` and the
  snow facets** (a `noul` at 0.3 for every hazard type on a long unit is common); the floors
  absorb it, but the sheet must never show a below-floor Jev value as anything but a ghost.
  Jev's infrastructure returned 503 / 529 on 7 of 147 calls — the pipeline needs a retry.
- **Haiku over-returns `quality`, `supportable`, `endTime` and same-day visits** on the recall
  tier (supportability precision 7%: it infers "held me" where the author gave no word; end-time
  precision 39%: it turns "this morning" into a clock time despite the prompt). Prompt work for
  A10-4, measured against verified labels.
- **The miss list is already informative** on three emails: air temperature, crowd size, snow
  texture ("unbonded drifts"), time *on* the ice, "the surface changed color as the sun set" —
  every one a real slot the sheet lacks, exactly what D200 wants at corpus scale.

**Provisional floors** (`PRECISION_FLOORS`, `basis: 'provisional'`): `iceTypes` 0.93,
`surfaceTags` 0.99, `hazards` 0.98, `accessConditions` 0.66 from the Jev run; everything else a
ghost. Nothing ships to a skater on a provisional floor (A10-4 checks `basis`).

### Deltas from the plan — read these before extending

1. **The §1.3 cache warning was misdiagnosed** — the prefix order was right; Haiku 4.5's minimum
   cacheable prefix is 4,096 tokens and the prompt was ~800. Corpus-scale passes use the Batch API.
2. **Sectors: `middle`, and `near_shore` overlaps** (founder, 2026-09-21; D193 amended). The eight
   wedges + `middle` carry the partition property; `near_shore` is a band.
3. **The narrow happened in A10-1**, not A10-5: `iceTypes` / `surfaceTags` are objects only and
   `snowCoverCm` is gone from the schema. The old forms keep working because the *mutation args*
   stay wide and the validator lifts the bare shapes — the dual-write validator §2.4 budgeted is
   the contract, not a second schema. The old forms' edit path was lossy for everything the sheet
   adds (a chip's `where`, the snow facets, a poke's count, the vantage, the suitability) until the
   PR #71 review: `reportFormFromReport` now carries all of it through `ReportFormState.carried`
   and `buildReportInput` re-emits it, restoring the form's own round-trip contract. Client-side
   rather than in `reports.update`, because the server cannot tell "this client has no control for
   it" from "the author cleared it" — only the client knows. Both forms also offer only
   `FORM_THICKNESS_METHODS` (no `poke`): they have no count field, so a poke reading could never
   validate from them. **Installed clients are not a migration concern here:** prod has never been
   initialized and the one APK is the founder's EAS preview, rebuilt from the branch, so the read
   APIs return the stored objects with no compatibility shim (which would also block §12.1).
4. **A structured-output schema with fourteen typed lists is "too large"** (Anthropic 400: the
   compiled grammar); the Claude wire shape is one flat `values` list with a `field` discriminator,
   and the wrapper validates enum-shaped strings against the vocabulary so an unknown value is a
   `miss`, not a failed parse.
5. **Jev `noul` answers carry no confidence** — the probability is the number (D196 note). Jev
   has no TypeScript SDK; the client is one `fetch`.
6. **A sighting needs a vantage off the ice** in both engines' mappings, mirroring the validator —
   Sonnet returned `sighting: frozen` for on-ice authors 91 times before the gate.
7. **§12.3 named**: the water-body map on feed cards and on the sheet, with A10-2.
8. **The `reportSheet` reducer keeps a `defaulted` flag** on the sheet's own `observedFrom: on_ice`
   chip: solid (serializes) but steps down to a ghost when the author's prose says otherwise — a
   default is what stands until someone says so, and the author counts.

### Owed

- The founder's verification pass (`training_data/google_group/eval/review.html`) → verified
  floors; A10-4 is gated on `basis: 'verified'`.
- A retry on Jev 503 / 529 in the pipeline, and Stage B's per-unit requests in parallel; the
  recall tier over the full 2,449 via the Batch API when the corpus replay (A10-2 §1.5) needs it.
- `photos.reportId` is now written by `reports.create` / `reports.update` beside the list it
  mirrors (`syncReportPhotoLinks`), and a photo another report claims is refused at the write —
  so `posts.create` (A10-2) inherits one photo, one report, rather than having to establish it.
  The backfill returns `photosShared` for any legacy pair that broke the rule (none on dev).
- Two seams the self-review found for the next PRs: `ExtractedWhere.placeName` is structurally a
  core `Where` with nothing set, so the sheet must map it to `point.name` when it applies an
  extraction (A10-4), never pass it through; and `accessAlerts.reason` still narrows to the blocker
  set until §7.2's write path lands (A10-2).

## Built record — A10-2 (2026-09-21, `phase-a10-reporting-flow-2`, PR #72)

§2.4 (the plumbing: `posts.create`, moderation, purge, export, the feed), §7.2's server half, §9.4,
§12.1, the `showPutIn` switch that had waited on a local branch since 2026-09-20, and PRIVACY.md's
sentence about it. Eighteen commits off `main` at `8c53098c`, ~6,600 lines over 91 files. Suites at
build: core 2,905 · convex 1,730 · web 573 · mobile 112. No data runs; the schema change (`accessAlerts.reason` widens) needs a
`convex dev --once` before the app is used against dev.

**Deferred to A10-2b by the founder's size rule** (this PR is ~6,600 lines with the switch; 9k was
too many): §9.1–§9.3 (the queue reshaped around Posts, D55 ids in the draft, *Waiting to send*),
§12.2 (aggregates learn `where`), §12.3 (the water-body silhouette on cards and the sheet), and the
profile history as Posts. §1.5 (the corpus replay) waits on the founder's eval review — the engine
decides what the pipeline stores — and ships with its run, `posts.importBackdated` included.

### What shipped, by workstream

- **§2.4 the write path** — `lib/reportWrite.ts`: `createReportRow` writes one Report with its
  hazards, photos, bay membership, track link and side effects; `createPost` gates the author
  once, dedups on the Post's key, validates the title and prose (`validatePostInput`, bounds in
  core), inserts the Post first so each member is **born with its `postId`**, writes the members
  in the author's order, and fills `reportIds`, `latestSkateEndTime` (the max) and `photoIds` (the
  ordered union — `postPhotoIds`). `reports.create` is the one-Report form of the same path and
  stays until A10-5 removes the last pre-sheet form; its key is both the Post's and the Report's.
  A Report's own key is stored and a reuse refused, never shared.
- **§2.4 the create-only rules** — `assertMayPost`: D199's window, then D189's set, per Report,
  after its hazards are filed and before the Post is written; a throw rolls the transaction back.
  The three sentences live in core and the pre-sheet forms ask them client-side
  (`formCreateRefusal`) before posting — never on an edit, never on *Save draft*.
- **§2.4 moderation** — `post` is a flag target and a moderation target. Hidden or removed
  cascades to every visible member with an audit row each (`cascadedFromPostId`); a Post restore
  brings back only what that cascade took down. `applyReportStatus` is the one place a Report's
  verdict moves its counter, body card, bay join and Post sort key. **Zero visible members hides
  the Post as a stored fact** (`derivePostVisibility`, audit row `derivedFromReportId`), and a
  member restore brings a Post hidden *that* way back — the feed's gate stays in the index.
- **§2.4 purge, export, sweeps** — `contentPurge` gains `posts` first (title + body, aged on
  `latestSkateEndTime`); `reportRedaction` now also clears a located chip's `note` (missed since
  A10-1); `dataExport` enumerates `posts`. The photo sweeps add no `posts` arm on purpose — the
  album is derived from the members — and say so where each argues its completeness.
- **§2.4 / §12.1 the feed** — `posts.listFeed` replaces `reports.listFeed`: Posts paginated on
  `by_moderation_and_latest_skate_end_time` with the season bound in-range, then a `PostCardData`
  per Post: the words over the members the viewer's filters matched, in the author's order, the
  members the filters hid counted (`omittedCount`), the members a moderator hid neither shown nor
  counted, a Post with nothing to show dropped. The card builder and the narrowing moved to
  `lib/feedCards.ts`, shared with the offline cache and the recommended strip. `FeedCardData` gains
  `suitability`, `observedFrom`, `sighting`.
- **§12.1 the cards** — `PostCard` on both surfaces over one `buildPostCardView`: the author's
  words (who, when, title, prose clamped with the rest a tap away in place) over one `FeedCard` per
  Report, each a button to that Report; two or more lakes get a hairline rail with a mark per
  lake, the day's itinerary in the author's order; a legacy Post (one Report, no words) draws no
  header and *is* the card it always was. The report card leads with the author's suitability
  ("Don't go" in the warning treatment), shows the vantage only off the ice, and a sighting.
- **§12.1 the details** — both ReportDetails: the same axes; each chip with its `where` in words
  (`describeLocatedChip`, lifted from the sheet reducer, compass words not letters; `reports.get`
  returns `bayNames`); snow in one line (`describeSnow`, shared with the sheet); the Post's title
  and prose over the data and the other lakes of the day one tap away (`posts.getForReport`).
- **§7.2 the server half** — `accessAlerts.reason` widens to `ACCESS_REASONS`; `create` takes the
  author's own `reportId` (theirs, about this body) and the queue's `idempotencyKey`;
  `blockedIds` is built from the blockers alone; one label map in core replaces two client copies
  that would have rendered a plank as "Access problem". The pickers still offer the blockers only —
  the conditions' door is the sheet (A10-3).
- **§9.4** — the queue asks the create-only rules at flush **before the uploads**; a server
  refusal parks the draft with the server's sentence (`flushErrorMessage` reads
  `ConvexError.data`), not the wire form; `UnreportedSkates` stops offering a skate outside the
  window.
- **The `showPutIn` switch** (Phase 04 debt) — rebased onto A10-1 (two additive conflicts) and
  landed as the first two commits; PRIVACY.md now describes it.

### Deltas from the plan — read these before extending

1. **`reports.create` stays** as the one-Report form rather than being deleted: both pre-sheet
   forms and ~180 test call sites use it, and one path underneath makes the two entrances one rule.
2. **No version gate on D189/D199** (D189, D199 amended): the fixtures that posted notes-only or
   January-dated reports spread a minimum-set constant nothing downstream reads (`suitability` +
   `glass`) and post at a fresh time; an aged fixture moves the clock for the write.
3. **The Post's album is derived**, so "one writer keeps three fields from drifting" became
   `syncPostPhotos` (the union) + `syncReportPhotoLinks` (the back-link) — and the sweeps needed
   nothing. `lib/postPhotos.ts` became `lib/postSync.ts`, with the sort-key writer beside it.
4. **"Zero visible Reports ⇒ not shown" is stored** (D186 amended) — the read-side rule alone would
   have re-opened the `isDone: false` short-page problem the in-index gate exists to close.
5. **`refreshPostLatestSkateEnd` keys on visible members** — a Post whose freshest Report a
   moderator hid sorts on the freshest one a reader can still see.
6. **The body page already shows several latest Reports** (`listByWaterBody`, paginated); §12.1's
   "several, not one" needed no change there. The profile history stays per Report until A10-2b
   renders `PostCard`s.
7. **Notifications needed no change**: a multi-body Post enqueues one candidate per body, which is
   what a favoriter of one body should hear; the tap target was already the Report.

### Owed

- `convex dev --once` on dev before the app is used (the `accessAlerts.reason` widening).
- ~~A10-2b: §9.1–§9.3, §12.2, §12.3, the profile history as Posts.~~ Built, stacked on #72.
- **§7.2's client half (A10-3) must decide the cap:** conditions and blockers share
  `MAX_ACCESS_ROWS_PER_BODY` (64) on `by_water_body_status_expires_at`, so a lake with many live
  "plank needed" rows could push a live "gate locked" out of the window `blockedIds` is built from.
  Nothing writes a condition until the sheet does; a reason column in the index or a second bounded
  read for the blockers is the fix, and it lands with the first writer.
- The replay PR (§1.5) after the founder's eval review: the deployment (a `skating-replay` project
  is the recommendation — preview deployments auto-delete after 5 / 14 days), the snapshot import,
  `posts.importBackdated`, the runner and `replay-summary.md`.

## Built record — A10-2b (2026-09-21, `phase-a10-reporting-flow-2b`, PR #73 stacked on #72)

The half the size rule split off A10-2: §9.1–§9.2 (the queue around Posts, D55 offline, *Waiting
to send*), §12.2 (aggregates learn `where`), §12.3 (the silhouette, D203), and the profile history
as Posts. Nine commits off `-2`, ~2,900 lines over 44 files. Suites at build: core 2,947 · convex 1,733 · web
576 · mobile 112. No schema change, no data run.

### What shipped, by workstream

- **§9.1 the queue is Posts** — core `draftQueue.ts`: `PostDraft` (the words plus one or more
  `ReportDraft`s, each with its own key, body, form, photos, track and `hazardRefs`) flushed by
  `flushPost` as one `posts.create`. Every Report is resolved, validated and held to the create-only
  rules before any Report uploads; then the uploads; then one create — one bad leg parks the whole
  Post, named by its lake, and a sound first leg spends nothing on it.
  `postDraftFromLegacy` lifts a pre-A10-2b row; the mobile store's fourth migration runs it row by
  row under the `post` kind (tested against real sqlite). The pre-sheet form saves a one-Report
  Post and edits a Post's first Report; the sheet (A10-3) edits them all.
- **§9.1 D55 offline** — `hazardRefs` carry a server id or the queue's local id; the bundle prompt
  offers the phone's queued hazards beside the server's (`local:`-prefixed); the flush resolves a
  local ref through the hazard queue, which now **keeps a flushed hazard's row** (`done`, with
  `hazardId`) while a draft points at it and sweeps it after (`removableHazardItems`) — the rule a
  flushed track's row already followed. A bundled hazard is the observation the minimum set asks
  for at flush. Online, a checked hazard still in the queue is **flushed at submit** and attached
  by the id it lands with (`resolveBundledHazardIds` over `resolveQueuedHazardId`); one that cannot
  be sent stops the post with a sentence (`UNSENT_HAZARD_REFUSAL`), never a silent omission.
- **§9.2 *Waiting to send*** — the Report tab's queue: the signal state in one sentence from core
  (`WAITING_TO_SEND_COPY`; offline: "…it's safe to close the app"), hazards first, then the Posts
  labeled by title or lakes (`postDraftLabel`), *Sync now* only with signal.
- **§9.3** — nothing to build until extraction exists (A10-4); the prose already rides the draft
  (`PostDraft.title` / `body`).
- **§12.2 aggregates learn `where`** — `whereOverlaps` / `whereCoversBody` in core. Corroboration
  (`shareIceType`) needs a shared type *about the same water*; the contradiction test keeps the
  by-key reading (a shared type anywhere keeps a pair out of the queue); the recommended bar wants
  black ice claimed of the lake — not one bay, one sector or "patches". Feed filters stay
  by key on purpose: black ice in the north is black ice on the lake.
- **§12.3 the silhouette (D203)** — core `bodySilhouette.ts` (payload, ring simplification to a
  240-point budget, the equirectangular fit, the SVG path builders; fast-check over the fit, the six
  real outlines over the budget); the server builds the per-body half once per page in
  `bodyInfoFor` from the polygon the card read already carried and the per-report half in
  `toFeedCard` (put-in only when the viewer may see it, the skate trimmed under D58's clip, the
  first located chip's `where` — its sector and its bay together, never one chip's sector beside
  another's bay); `BodySilhouette` on web and mobile draws the same paths. The card's right column
  is the time over the silhouette.
- **§12.1 the profile history** — `getPublicProfile` returns `posts: PostCardData[]` through the
  feed's `toPostCard`, bounded in Posts *and* in member Reports hydrated (one number, cut at a Post
  boundary); both profile pages render `PostCard`s.

### Deltas from the plan — read these before extending

1. **The silhouette is computed per page, not stored** — the body doc's polygon is already in the
   card's read, so simplifying it costs CPU and no bytes; a stored `cardRing` would have meant a
   backfill plus five writer sites. If a profile ever says otherwise, the per-body half is one
   function and can move to the row.
2. **The card carries the skate's path** (the founder's "the report track is static") — simplified
   to the same budget, D58-clipped for a stranger. The plan's §12.3 named only the put-in and the
   sector.
3. **A flushed hazard's row is kept, not deleted** — the plan said "the ids must ride the offline
   draft" and left the resolution unsaid; keeping the row with its server id is the same rule the
   track queue already had, and the sweep is the same shape (`sweepHazardItems` beside `sweepTracks`).
4. **Contradiction stays by key** while corroboration reads `where` — asymmetric on purpose: fewer
   awards for different places, no more flags for them.
5. **The flush resolves hazard refs before the create-only check and the uploads** (self-review),
   so a ref that comes back empty cannot pass the minimum set and then fail the create after the
   photos were spent; a hazard flushed on demand this way frees its photo files like one flushed by
   the drain (`flushOneHazard`).
6. **Reopening a draft applies its saved bundle choice** as the opt-outs once the candidates load —
   the last explicit choice wins over D55's pre-checked default, including for a hazard that synced
   in since. A call made at build; say so if the default should win instead.
7. **The bundle window is one rule** (`bundleWindow` in core): the prompt's queued candidates and
   `hazards.listBundleCandidates` read the same skate-window-or-24-hours.
8. **An online post flushes a checked queued hazard at submit** (PR #73 review). The build had it
   silently unattached — "no id yet, posts on its own" — which lost the author's explicit, shown
   choice (D55: never silent) whenever a transient sync failure or an unfinished drain left the row
   without a server id. Now the form asks the queue for the id, flushing the row if it must, and a
   hazard that cannot go stops the post with what to do; the posted form then runs the drain's
   sweep (`sweepFlushedHazards`) so the spent row is not re-offered to the next report on the lake.
   The draft path is unchanged.
9. **The flush checks every leg before any leg uploads** (PR #73 review): two passes over the
   Post's Reports, so a two-lake Post whose second leg is stale or under-observed spends none of
   the first leg's photos. The on-demand hazard flush stays in the first pass — it is not an upload
   spent on this Post, and the minimum-set count needs it.
10. **The silhouette draws one chip's `where`, whole** (PR #73 review): the first located chip's
    sector and bay together, never a sector from one chip beside a bay from another — a wash and a
    ring that composed "the south end of North Bay" out of "black ice, south" and a reading in
    North Bay was a place no one claimed.
11. **The profile history is bounded in Reports, not only Posts** (PR #73 review): the fifty-Post
    window could hydrate five hundred cards (a Post is up to ten), each with every thumbnail URL —
    `photoIds` has no per-report cap on the write path. One number bounds both, cut at a Post
    boundary. A paged history is the next step if a profile ever wants more than the window.

### Owed

- A10-3 device pass of the queue: a two-lake Post saved offline, a queued hazard bundled, the
  *Waiting to send* line with airplane mode on and off.
- The A10-3 sheet edits every member of a Post draft; the pre-sheet form edits the first.

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
  `Extractor`; the title is part of the input. ~~⚠ Fix the prompt-cache boundary first: the
  2026-09-19 mention inventory (Haiku over 2,449 emails) cost $5.68 because the shared prefix
  (system prompt + vocabulary) sat after the per-message text~~ — **misdiagnosed** (build,
  2026-09-21): the inventory's prefix order was right (system block first, `cache_control` set);
  caching never engaged because **Haiku 4.5's minimum cacheable prefix is 4,096 tokens** and the
  prompt was ~800 (every row has `cache_creation_input_tokens: 0`, not just reads). Sonnet 5's
  minimum is 1,024. Caching would have saved ~$1.50 of the $5.68 — 4.37M input tokens were
  per-message body. Corpus-scale passes use the **Batch API** (50% off) instead of chasing the
  cache; the sheet's per-paragraph calls are too short to cache on Haiku. Still confirm
  `cache_read_input_tokens > 0` on the second call whenever a prompt is long enough to qualify.
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
- §12.3 **The water-body map on feed cards and on the sheet** (Phase 05 decision 6, never built on
  the feed; folded in by founder call 2026-09-20 — named here when A10-1 opened). The card gets the
  body's outline as a small inline map with the Report's put-in and, when a `where` is set, the
  sector highlight from `sectorGeometry.ts`; the sheet's mini-map (§4 / §7) is the same component.
  Lands with A10-2's reading side.

## PR breakdown

Fewest sensible PRs; sub-workstreams are commits.

- **A10-1 — §1 + §2.1–§2.3 + §3.** The eval, the schema (widen half), the core model. Pure and
  testable; no UI. Deploy, backfill Posts and snow, narrow.
- **A10-2 — §2.4 + §7.2 (server) + §9.4 + §12.1.** The plumbing: `posts.create`, every consumer,
  the purge/export/moderation paths, the Post feed and cards, the details, the pre-sheet forms
  held to the create-only rules. What every later PR depends on. *(Built 2026-09-21; the size rule
  split the rest off.)*
- **A10-2b — §9.1–§9.3 + §12.2 + §12.3 + the profile history as Posts.** The offline queue
  reshaped around Posts (D55 ids in the draft, *Waiting to send*), aggregates that learn `where`,
  the water-body silhouette on cards (D203). *(Built 2026-09-21, stacked on #72.)*
- **The replay PR — §1.5.** After the founder's eval review decides the engine: the replay
  deployment, the snapshot import, `posts.importBackdated`, the runner, the miss list.
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
