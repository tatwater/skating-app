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
>
> **Status 2026-09-16: ✅ built, both PRs on dev (PR 1 = #58, PR 2 stacked on it); prod deferred.** See §Built record,
> directly below, for what shipped and where it departs from the kickoff pass. The §Kickoff pass
> after it is the build spec — every call it records supersedes the scoping prose after it where the
> two disagree, and each such place is marked ⚠ inline.

---

## Built record — 2026-09-16 (PR 1, `phase-n9-subareas-as-places`)

Built in one sitting against `main` at `5bb3f93`, in the eight commits the kickoff pass planned plus
two review passes (a local `/code-review` and a headless web smoke). **D175** is written. Deployed to
dev (`agile-bee-397`) and backfilled: `mintSubAreaKeys` keyed and fetch-profiled all 128 bays,
`backfillReportSubAreas` found the two dev reports have no bay, `restampAllParents` swept the 22
parents and tagged 132 of their 388 put-ins (Champlain 42/172, Winnipesaukee 69/76, Mascoma 6/6).
Suites at build: core 2,689 · convex 1,614 · web 552 · mobile 111, all green; ~4,600 lines over 63
files. **Prod is deferred, as for every phase since N1.**

### What shipped, by workstream

- **The rule + the join.** `reportSubAreas` (one row per report × bay, `moderationStatus` +
  `skateEndTime` mirrored, every writer through `lib/reportSubAreas.ts`); `reports.subAreaIds` +
  `subAreaNames`; the bay feed and the bay bounty gate read the join; the old per-report bay index
  dropped. `attachReportToOpenBounties` accepts any member bay.
- **The re-derivation.** `insertSubArea` (mints `subAreaKey`, computes `fetchProfileM`) and
  `rederiveSubArea` (derived fields, depth invalidation on a real outline change, cells) are the only
  two writers of a bay's geometry; six former inline copies are gone. `restampParent` walks
  `gpsActivities → reports → hazards → putIns → bodyFeatures`.
- **Stamps at write.** Put-ins by distance to the outline (30 m, smallest wins, tie judged to a
  millimetre); features by footprint centre; tracks by majority of 64 samples with `leftSubArea`;
  activity reports from their track.
- **Favorites** with `subAreaId` (triple uniqueness), split reads (`loadFavorites` for the feed's
  per-report test, `loadFavoriteBodyIds` for the map/discovery's per-lake test), the recipient-set
  de-dup in `enqueueReportNotifications`, and the copy *"New report in Malletts Bay (Lake Champlain)"*.
- **Drive-time** from the bay's best put-in (`subAreaDriveCoord`), in the feed and the fan-out.
- **The bay view** on both clients (`describeSubAreaHeader`, `windRoseCaption` on every body),
  narrowed hazards / bounties / access reads, the admin card line (`adminStatsForBody`).
- **Workstream G**: `maybeRefreshBayTier` daily, season-gated, Tier A days + hours per live bay.

### Deltas from the kickoff pass — read these before extending

1. **Restamp order is tracks first**, not "put-ins and tracks after reports": an activity report's
   membership *is* its track's list, so the report pass reads the stamp the track pass just wrote.
   `bodyFeatures` joined the walk too (five tables, not four).
2. **`reports.subAreaNames` mirrors `subAreaIds`**, stored only when there is more than one (the
   `waterBodyIds` convention). The list-form location line on the feed card and both report-detail
   screens therefore costs no reads. `memberSubAreaIds` in core is the one reader of the pair.
3. **A membership floor** (`SUB_AREA_MEMBERSHIP_MIN_SHARE` = 10% of samples, ~6 minutes of an hour).
   Found by the review: with plurality alone, a lake-wide skate that crossed Malletts' mouth for
   one sample would be labelled, banded, fed and notified as a Malletts Bay report — and before N9 it
   carried no bay at all. Below the floor the samples are open water for everything but the
   mouth-line flag. The primary is a plurality among *members*, the body rule.
4. **`depthDerivedAt` survives the invalidation.** The kickoff said clear all four; the admin card's
   sentence *"derived Sep 2 · geometry changed Sep 14"* needs the date it is replacing, so the
   number, its source and its caveat go and the date stays. Readers key on `maxDepthM`.
5. **`notificationResolve` had no `subAreaName` path** — the kickoff's "via the existing path" was
   wrong. One was added: a bucket of exactly one report names its bay; a bucket of several names the
   lake, since it may span bays.
6. **The bay bounty list keeps lake-wide bounties**: a lake-wide ask is satisfiable from this bay
   (D175), so it is an ask the bay's skaters can answer. A bounty on a *different* bay is dropped.
7. **The bay view omits the lake's profile caption** (smoke finding): it carried the lake's 399 ft
   and 11-mile fetch one line under "no depth inside this bay".
8. **`restampAllParents`** is a third one-off the kickoff did not list: nothing else would ever have
   tagged the put-ins, tracks and features from before the phase.
9. **`putIns.by_sub_area`** was added (the drive-time read and the bay access read); the kickoff's
   schema block did not have it.

### Smoke — Malletts Bay on web, headless (2026-09-16)

Signed in by Clerk sign-in token (the N6h recipe; Chrome needs `--use-angle=swiftshader` or MapLibre
throws into the error boundary). Header: *Malletts Bay* + own heart · *Part of Lake Champlain* +
lake's heart · *1585.1 acres* · *No depth inside this bay recorded* (reveal) · *Elevation 97 ft —
the lake's*. Overview: the wind caption's bay form. Reporting: bay filter seeded to Malletts.
Planning: *Put in at ESE launch* (a bay launch, chosen over the lake's 172), the spread, the bay's
weather. Camera framed the bay with the parent's contours drawing under it. Console clean apart from
a pre-existing `<div>`-in-`<p>` warning in `DetailSkeleton` (not this phase's).

### PR 2 — `phase-n9-bay-depths` (2026-09-16, stacked on PR 1)

`scripts/bathymetry/src/bayDepths.ts` (the clip rule, tested) + `exportBayDepths.ts` (the CLI,
`export-bay-depths`, README §10) + `subAreas.exportForDepths` / `setDerivedDepth`. **Run on dev**,
campaign `n9-bay-depths-20260916`: 128 live bays on 22 parents; 104 sit on a parent the archive
covers; **63 got a depth** — 21 measured from soundings (Champlain's ten, Moosehead, Sebec, Seboeis),
42 isobath floors (Winnipesaukee 41, Cochituate 1); 41 had no sounding or isobath vertex inside
their outline and 24 sit on an uncovered parent (Placid, Belleau, Pine River Pond…), both correctly
nothing. Refused 0. Sanity: Champlain's *Broad Lake* bay takes the lake's 121.6 m — the deepest
point is in it — and *Malletts Bay* reads 24.7 m measured. Delta from the kickoff: contour lanes are
**not** superseded here (that list governs lake depth, where NH's band polygons win; nothing clips
bands per bay), and the isobath test is *any vertex inside*, not *fully inside* — a vertex of the
60 ft line inside the bay is water at least 60 ft deep inside the bay, and the tighter rule threw
away exactly the crossing contours a bay mouth has most of.

### Deferred / not built

- The mobile bay view is type-checked and suite-green but not device-tested.
- The shelter index, the station study, US spellings — post-alpha, as scoped.

---

## Kickoff pass — 2026-09-16 (founder calls + the code audit)

Everything in this section was settled in one sitting with the founder, against the code as it
stands on `main` at `5bb3f93` (PR #56/#57 merged, N8 complete). Nothing here is built yet.

### The dev corpus, for sizing

Measured on dev (`agile-bee-397`) 2026-09-16 with a one-off query:

- **128 live sub-areas on 22 parents.** Winnipesaukee 48, Moosehead 13, Champlain 10, Belleau 9,
  Pine River Pond 8, Squam 7, Sebec 6, Lake Placid 5, then a tail of 1–3.
- **11 of the 22 parents have contours/soundings in the bathymetry archive** (`bathymetryCoverage`
  rows): Winnipesaukee, Moosehead, Champlain, Pine River Pond, Seboeis, Ossipee, Mascoma, Balch,
  Cochituate (South Pond), Sebago. That is **~85 of the 128 bays that can get a real depth**; the
  other ~43 get nothing, which is the correct D3 answer.
- Every parent carries `windRose`, `fetchProfileM` and `elevationM`; put-ins per parent run from 0
  (Pine River Pond, Seboeis) to 172 (Champlain).
- **0 `gpsActivities`, 0 `bodyFeatures`, 14 `waterBodyFavorites`** on dev — so the track and
  feature stamps ship tested but empty, and the favorites migration is trivial.
- The bathymetry archive is on this machine: `scripts/bathymetry/.raw/` is 299 MB (ME soundings,
  VT soundings incl. Champlain, NH + MA contours, MIDAS crosswalk), `.scratch/join/lakes.json` is
  the last join, so the depth lane (§Workstream F) can run without a refetch.

### What the audit found already built — corrections to the scoping table

The scoping doc's list of "what a sub-area cannot do" is right; its account of §The rule is
**mostly already satisfied**, because reports, hazards and bounties are stored on the *parent* with a
`subAreaId` stamp and never moved:

| rule clause | state on `main` |
| --- | --- |
| feed: one row, under both the lake and the bay | ✅ `reports.listByWaterBody` takes an optional `subAreaId` served off `by_sub_area_moderation_and_skate_end_time`; the global feed is one row per report by construction |
| bounties: bay ⊂ lake, not symmetric | ✅ `bounties.attachReportToOpenBounties` line 715: a bay bounty skips reports whose `subAreaId` differs; a lake bounty takes any |
| prominence / corroboration / conditions roll up | ✅ nothing to do — reports never leave the parent, so `bodySummary`, `pointEvents.by_ref` and `richness.hasActivity` already count them |
| **notifications de-dup** | ❌ **the one new surface.** `enqueueReportNotifications` scans `waterBodyFavorites.by_water_body`; once a favorite can name a bay, a person who favorited both would be enqueued twice under the same coalesce key and get *"2 new reports"* for one |
| drive-time band for a bay | partly — `weather.resolveForecastPlace` already judges the band on the bay's own weather point (`arrivalBandMinutes`); the feed, the digest/great fan-out and the lake list still use the parent's `centroid` |

Two premises of the scoping doc that do not survive contact with the code:

1. **"max / mean depth"** → **max only.** `scripts/bathymetry/src/lakeDepths.ts` deliberately
   produces no mean: the founder ruled on 2026-08-09 that a sounding cloud is a survey track, not a
   sample of the basin, and NH's published bands are the only honest mean source. A bay therefore
   gets `maxDepthM` with the same contour-lane caveat the parents carry (NH/MA: the deepest isobath
   fully inside the bay is a **lower bound**, `understatesMax`).
2. **"Make the re-derivation one function"** → true for everything *except depth.* Fetch, cells,
   stamps and put-in tags can be recomputed inside Convex on a redraw. The soundings are not in
   Convex — they are in `.raw/` on disk — so a redraw **clears** the bay's derived depth and the
   admin card says *"re-run `export-bay-depths`"*, rather than leaving last week's number under this
   week's outline.

### Founder calls (all seven questions, 2026-09-16)

1. **No contour re-tile.** A bay is viewed inside its parent's drawer (`/water/$id?sub=`) and the
   contour layer is keyed off the *parent*, so the bay's contours already draw; a bay-keyed crop
   would only *hide* the contours of adjacent water at the mouth. **`subAreaKey` is still minted at
   insert** (D93's argument, cheap, forward-looking); the build / tile / R2 / coverage re-run is
   skipped. ⚠ supersedes gap 6 below.
2. **Drive-time coordinate for a bay:** its best put-in (`official` > `osm` > `derived`), else the
   bay's own `representativePoint` — **never the parent's**, whose representative point is 30.7 km
   off mid-Champlain. Bands are per-viewer polygon tests against a coordinate, so this costs no extra
   cache — N2's "multiplied cache" objection was mistaken about the mechanism. ⚠ supersedes the
   drive-time row of the principle table ("else inherit the parent's bands").
3. **Put-in tagging by distance, not containment.** Put-ins are snapped *to the shoreline*, so
   point-in-polygon is a coin flip at the edge: tag by `distanceToPolygonMeters(coord, bay.polygon) ≤
   SUB_AREA_PUT_IN_TOLERANCE_M` (~30 m), smallest bay wins — the `nearestBodyForPoint` shape.
   **Parking gets no stored tag**: a lot belongs to a bay via the put-in it serves
   (`putIns.parkingAreaId`), else by proximity to the bay polygon within `PARKING_INFER_RADIUS_M`,
   derived at read from the parent's bounded set (Champlain's 160 lots is the worst case).
4. **Tracks — option (a), "list both bays", with a join table.** See §The two-bay skate.
5. **Favorites UX** as proposed — see §Favorites.
6. **The bay view filters its other lists too** (hazards, bounties; reports already), and **the
   "this rose is the 2 km cell's" caveat goes on every body's `WindExposure`, not only a bay's** —
   the over-claim is corpus-wide and the founder wants it said everywhere.
7. **The depth lane runs against dev as part of this phase.**

Plus three things that came up alongside:

- **Widen the weather archive's *coverage* to every bay, all season** (§Workstream G). Retention was
  never the gap — `weatherDays` is kept for ever (D153) — coverage was: Tier A (bay-resolution) rows
  are fetched lazily, only for bays somebody opened.
- **The shelter index and the station-bias study are post-alpha**, scoped in
  [`next-gen-weather-shelter-index.md`](./next-gen-weather-shelter-index.md) and
  [`next-gen-weather-stations.md`](./next-gen-weather-stations.md). Not built here.
- **US spellings everywhere**, as a separate mechanical PR *after* this phase lands — findings in
  [`next-gen-US-spellings.md`](./next-gen-US-spellings.md). New text written for this phase uses US
  spellings; the existing prose in this doc is left for that sweep.

### The rule, settled — to be written as **D175** in `01-decisions.md` by PR 1

> **A report belongs to the finest-grained place that contains it, and appears under every place
> that contains that one — once.** Membership carries reach; the label carries specificity. Nothing
> is ever counted twice: one feed row, one notification per person per event, one corroboration, one
> prominence contribution — however many places contain the report.

Applied: reports stay on the parent (`waterBodyId` never changes); `subAreaId` is the **primary**
bay (the label, the weather strip's point, the index); `reportSubAreas` rows are the **membership**
(every bay the report is in); notifications de-dup on the recipient set before enqueue; bounties on
any member bay are satisfied; everything that rolls up already rolls up.

### The two-bay skate (founder, Q4)

A skater spends an hour in one bay, traces the parent's shoreline for a mile, spends an hour in a
second bay, and comes home. Three candidate answers — (a) the track and report list both bays,
(b) auto-split into two reports, (c) promote to the parent only. **(a)**, for reasons the rule
already names: (b) manufactures two skates from one — two feed rows, two weather strips, two
corroborations, exactly the double-counting the rule forbids — and (c) throws away the finest
information we hold to dodge a hard question.

**Shape:**

- `gpsActivities.subAreaId` (primary = the bay with the **majority of sampled points**, the same
  rule `resolveTrackToBodies` uses for the body) and `gpsActivities.subAreaIds` (every bay touched,
  primary first, stored only when more than one — the `waterBodyIds` convention).
- `gpsActivities.leftSubArea?: true` when samples also fall on the parent **outside every bay** —
  **this flag is the mouth-line evidence.** Nothing acts on it; `/admin/water/$id` counts it.
- `reports.subAreaId` stays the primary; `reports.subAreaIds` mirrors the track's list when the
  report is activity-sourced or later linked (`linkActivityToReport`); a pin-only report has one.
- **`reportSubAreas` join table** (founder: *"just to be safe"*) — one row per (report, bay)
  membership, because Convex cannot index an array and the bay-scoped feed and the bay bounty gate
  must both see a spanning report under its *second* bay too. The `parkingAreaBodies` argument, one
  table over.
- The location line lists every member: *"Malletts Bay & Shelburne Bay · Lake Champlain ·
  Colchester, VT"* (`formatLocationLine` grows a list form).
- **Today's bug this also fixes:** an activity-derived report's `point` is the GPS *start* (D44), so
  it is currently stamped with the bay you launched from, whatever you skated.

### Favorites (founder, Q5)

- `waterBodyFavorites.subAreaId?` — a bay favorite still carries the parent's `waterBodyId`, so one
  `by_water_body` scan finds both audiences. Uniqueness index becomes
  `by_user_water_body_sub_area: ['userId', 'waterBodyId', 'subAreaId']` and the lake row is looked
  up with `.eq('subAreaId', undefined)` — the pattern `bodyWeatherCells.by_body` and
  `recurrenceQueue.by_season_skipped_claimed` already rely on (an optional-field index is not
  sparse; `undefined` is a real key).
- **Drawer:** when `?sub=` names a live bay, the header shows the bay's name with its **own heart**;
  the lake's heart stays. `toggle` / `isFavorite` take an optional `subAreaId`.
- **List** (`listForUser`): *"Malletts Bay · Lake Champlain"*, navigates to `?sub=`; follows a merge
  to the survivor as today; a favorite of a delisted bay is skipped, not surfaced.
- **Map highlight** pins the **parent** (a bay only draws at z ≥ 10 anyway).
- **Feed boost / badge** only on reports whose membership includes the favorited bay.
- **Notifications:** `enqueueReportNotifications` builds the recipient set once — lake favoriters ∪
  favoriters of any member bay — then enqueues once per person; the coalesce key stays
  `${userId}:${waterBodyId}:favorite`, so lake + bay collapse by construction. Copy: *"New report in
  Malletts Bay (Lake Champlain)"* via the existing `subAreaName` path in `notificationResolve`.
- Merge (`waterBodies.merge`) repoints the row's `waterBodyId` and dedups on the **triple**;
  `dataExport` and `accountDeletion` need only carry the new field.

### The re-derivation — one function, every caller

`rederiveSubArea(ctx, subArea, parent)` in `subAreas.ts`, called by `create`, `redraw`, `restore`,
`reclipSubAreasToParent`'s clipped branch, `importSeed` and `importBaySubAreas`. It owns, in order:

1. geometry-derived fields already computed today (`bbox`, `representativePoint`/`centroid`,
   `surfaceAreaSqM`, `displayScore`, `minVisibleZoom`) — moved in, not duplicated;
2. **`fetchProfileM`** from the clipped polygon via `@skating/core`'s `fetchProfileMeters` (pure,
   O(vertices × 16), fine for a 1,100-vertex bay);
3. **`subAreaKey`** — minted **once** at insert (`create`/seed/import), never on redraw; opaque and
   sortable like `waterBodyKey`;
4. **depth invalidation** — clears `maxDepthM` / `maxDepthSource` / `depthUnderstatesMax` /
   `depthDerivedAt` when the polygon changed (`restore` and `redraw`), stamping
   `geometryUpdatedAt` so the admin card can say the depth is owed;
5. `syncSubAreaCells` (built);
6. `scheduleRestamp` (built) — **extended** to walk `putIns` and `gpsActivities` after `reports` and
   `hazards` (`RESTAMP_TABLES` grows to four), rebuilding `reportSubAreas` for every report it
   touches.

`scoreFields` for a sub-area stays area + boost; a bay does **not** get the D2 richness terms in
this phase (its parent already earns `hasActivity` from the bay's reports — rolling up is the rule).

### Schema changes (all optional ⇒ migration-free, per the widen→deploy→backfill→narrow rule)

```
waterBodySubAreas  + subAreaKey?, fetchProfileM?, maxDepthM?, maxDepthSource?,
                     depthUnderstatesMax?, depthDerivedAt?, geometryUpdatedAt?
                   + index by_sub_area_key ['subAreaKey']   (eq() only — not sparse)
waterBodyFavorites + subAreaId?
                   ~ by_user_water_body → by_user_water_body_sub_area ['userId','waterBodyId','subAreaId']
putIns             + subAreaId?
bodyFeatures       + subAreaId?
gpsActivities      + subAreaId?, subAreaIds?, leftSubArea?
                   + index by_sub_area_start_time ['subAreaId','startTime']   (the admin count, take-bounded)
reports            + subAreaIds?
reportSubAreas     NEW { reportId, subAreaId, waterBodyId, moderationStatus, skateEndTime }
                   + by_sub_area_moderation_skate_end ['subAreaId','moderationStatus','skateEndTime']
                   + by_report ['reportId']
```

`reportSubAreas.moderationStatus` and `skateEndTime` are **mirrors**, kept by the only writers of
those fields — `reports.create`/`update` (skate time), `moderation.setStatus` (status),
`restampParent` (membership) and `waterBodies.merge` (`waterBodyId`). Readers: `listByWaterBody`
with a `subAreaId` and `bounties.recentReports` with a `subAreaId` move onto the join; the
`by_sub_area_moderation_and_skate_end_time` index on `reports` is then unread and is **dropped**
(an unread index is write amplification plus a trap, per the `accessAlerts` note). A backfill
internal mutation pages `reports` once to seed the join from `subAreaId` for the rows that already
carry one (Champlain's restamp already ran; the seed is a few hundred rows).

`bounties.subAreaId` is unchanged; the create gate reads the join.

### Stamps at write — where each lands

| table | writer(s) | rule |
| --- | --- | --- |
| `putIns` | `setOfficial`, `hide`, the N6d OSM upsert (`accessPoints.ts`), `restampParent` | nearest bay within `SUB_AREA_PUT_IN_TOLERANCE_M`, smallest wins |
| `bodyFeatures` | `promote` / `create` in `bodyFeatures.ts` | `hazardCenter`-style point, `smallestContainingSubArea` — the hazard rule |
| `gpsActivities` | `ingestTrack`, the Strava push (`strava.ts`), `resolveTrackToBodies` callers | majority-of-samples primary + all touched + `leftSubArea` |
| `reports` (via activity) | `reports.create` when `activityId` is set, `linkActivityToReport` | copy the track's list; pin-only reports keep the single stamp |
| `reportSubAreas` | every reports writer above + `restampParent` | one row per member |

### Drive-time — the coordinate, and the three read paths that change

`subAreaDriveCoord(bay, putIns)` in `@skating/core`: best put-in in the bay else
`representativePoint`. Applied in:

- `reports.listFeed` / `recentCardsForBodies` — `bandForCoord` on the bay's coord when the report
  has a primary bay (cached per bay per page beside `bodyInfo`);
- `notifications.fanOutNearbyNotifications` — the digest/great band for a bay report;
- `weather.resolveForecastPlace` — already the bay's point; unchanged.

`ViewportLakeList` / the map are per body and stay so.

### The bay view (both clients)

`WaterBodyDetail` with a live `?sub=`:

- header: bay name + own heart, then *"part of Lake Champlain"*; area, **own max depth** (or nothing),
  **inherited elevation**, own fetch;
- `WindExposure`: the **parent's rose + the bay's own fetch**, captioned *"Wind climate is the 2 km
  grid cell's; fetch is measured from this bay's own outline."* — and **every** body's rose now
  carries the first half of that caption;
- Reporting tab: reports (built), **hazards and bounties filtered to the bay** — `hazards.listForBody`
  and `bounties.listForBody` take an optional `subAreaId`;
- Planning tab: `AccessSection` filtered to the bay's put-ins + the lots they serve / lots within
  radius; the weather panels are already bay-aware.

### The admin card (`/admin/water/$id`, beside the redraw control)

Per bay: *"N skates this season ran past the mouth line"* (`gpsActivities.by_sub_area_start_time`
∩ `leftSubArea`, take-bounded), *"depth derived <date> · geometry changed <date> — re-run
`export-bay-depths`"* when `geometryUpdatedAt > depthDerivedAt`, and the stored `fetchProfileM`.
Nothing automatic.

### Workstream G — every bay's weather, every day of the season

`bodyWeatherCells.by_bay` already lists every live bay's browse cell (~128 rows). A daily internal
mutation, gated by the same season-open signal as Tier B (D161), fetches each bay's Tier A day
(`weatherDays` + `weatherHours`, the drawer's own path) so the season's record is complete for every
bay whether or not anyone opened it. ~128 calls/day. The consumer is the post-season study in
`next-gen-weather-stations.md`; nothing renders it in this phase.

### PR breakdown (two PRs; Greptile credits are metered)

**PR 1 — `phase-n9-subareas-as-places` (app + schema).** Commits, in order:

1. `docs(n9)`: this kickoff pass + the three next-gen docs (this commit).
2. `feat(n9)`: D175 in `01-decisions.md`; schema; `rederiveSubArea` + `subAreaKey` + fetch; the
   depth-clearing invalidation; `restampParent` over four tables; `reportSubAreas` + backfill +
   readers moved + old index dropped.
3. `feat(n9)`: favorites with `subAreaId`; notification recipient-set de-dup; merge/export/deletion.
4. `feat(n9)`: stamps — put-ins (tolerance rule), body features, tracks (majority + list +
   `leftSubArea`), reports via activity, `formatLocationLine` list form.
5. `feat(n9)`: drive-time coordinate in core + the three read paths.
6. `feat(n9)`: web + mobile bay view (heart, header, filtered lists, access, wind caption on every
   body); admin card.
7. `feat(n9)`: Workstream G cron.
8. `docs(n9)`: built record.

Estimate 5–7k lines incl. tests — under the ~8k / ~100-file bar. Local gate before the PR:
`pnpm check-types`, `pnpm test`, `pnpm lint`, `/code-review`, then push the functions to dev
(`pnpm convex-dev --once`) and smoke the bay view on web against a Champlain bay.

**PR 2 — `phase-n9-bay-depths` (ETL).** `scripts/bathymetry/src/exportBayDepths.ts`: read the
join, export live sub-areas (`_id`, `subAreaKey`, parent catalogue ids, polygon) from Convex via an
internal query, clip each archived parent's soundings / isobaths to each bay polygon, emit
`{ subAreaId, maxDepthM, lane, understatesMax }`, and load through a new
`subAreas.setDerivedDepth` internal mutation (writes `maxDepthSource: 'state_agency'`,
`depthDerivedAt`, refuses when `geometryUpdatedAt` is newer than the export's snapshot). One
`importRuns` row. Run on dev in the same PR; record the numbers in the built record.

### Tests to write (D40)

- core: `subAreaDriveCoord` ladder; `formatLocationLine` list form; put-in tolerance rule; track
  primary/list/`leftSubArea` on a fixture crossing two bays and open water.
- convex (convex-test): favorites uniqueness on the triple; lake+bay favorite ⇒ **one** queue row
  with `count: 1`; `reportSubAreas` mirrors on `moderation.setStatus` and on `reports.update`;
  `listByWaterBody(subAreaId)` returns a spanning report under both bays; bay bounty satisfied by a
  spanning report; `rederiveSubArea` clears depth on redraw and not on rename; `restampParent`
  re-tags put-ins and tracks; the backfill is idempotent.
- web/mobile: bay header renders the heart + inherited elevation + own depth; the wind caption on a
  plain body.

### Pickup checklist — for a fresh thread

1. Branch `phase-n9-subareas-as-places` off `main` (this commit is the first on it).
2. Read this §Kickoff pass, then `packages/convex/convex/subAreas.ts` (1,381 lines — the module
   being extended), `schema.ts` lines ~1199–1276 (`waterBodySubAreas`, cells), ~2653–2779
   (favorites, put-ins), ~1839–1971 (reports + its sub-area index), ~388–448 (`gpsActivities`).
3. Then `notifications.ts` lines 137–184 (`enqueueReportNotifications`), `bounties.ts` 86–130 +
   699–732 (`recentReports`, `attachReportToOpenBounties`), `reports.ts` 498–560 (`listByWaterBody`)
   + 640–770 (`bodyInfoFor`, `toFeedCard`), `gpsActivities.ts` 62–238 (`resolveTrackToBodies`,
   `ingestTrack`), `putIns.ts` (all), `apps/web/src/components/WaterBodyDetail.tsx` (the drawer;
   mobile's mirrors it).
4. Memory rules that bite here: Convex optional-field indexes are not sparse (`eq()` only);
   push functions with `convex dev --once` before smoke-testing; keep imports extensionless;
   `waterBodies.centroid` is `pointOnFeature`, not a centroid; N6d's access load cost 105 GB — never
   scan the corpus for a small question.
5. The next decision number is **D175**.

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
| **wind rose** | **inherit the parent's rose, and say that is what it is**; compute the bay's **own `fetchProfileM`** from its own polygon | ⚠ **Inherited because our data has no finer answer, NOT because the wind is the same.** See §Wind in a cove — the honest statement is a limitation, and it must not be written down as a fact. Fetch is the one bay-specific signal we can compute for free, and it is real. |
| **max depth** (⚠ *max only* — mean was ruled out 2026-08-09, see §Kickoff pass) | **derive** by clipping the parent's soundings to the bay polygon, then **store** | ⚠ **Inheriting would be a safety-relevant lie.** Malletts Bay is not as deep as Champlain's broad lake, and a bay page reading "max depth 122 m" is worse than one reading nothing (D3). Expensive to recompute per read, so it is stored — which makes it a derived-and-cached value with an invalidation rule, see §The redraw problem. |
| **contours** | ⚠ *superseded (kickoff call 1): no crop, no re-tile — the parent's layer already draws under a focused bay; only `subAreaKey` is minted* | `clipDrawnToBody` already does exactly this for the 9 nested bodies `alsoCovers` found. |
| **drive-time** | from the bay's **own** put-ins where it has any, else ⚠ *the bay's own `representativePoint` — never the parent's bands (kickoff call 2)* | This is the point of the ask: the bay's parking is closer than the lake's nominal representative point, and a drive-time computed from the lake under-serves the bay. |

**The through-line worth stating once:** a sub-area's own *geometry* is the only new information it
brings. Everything that follows from geometry (fetch, depth-within-the-outline, contour crop, which
put-in is inside it) is derived; everything that does not (wind climate, elevation) is inherited;
and the one thing that is neither (a favourite) is stored.

---

## Wind in a cove — the inheritance is a limitation, not a finding

**Founder correction, 2026-08-07:** *"In a bay/cove, wind will almost certainly behave differently
than out in the middle of a large lake, because of the relative position of trees & terrain. But if
we don't have a way to get bay-location-specific data, then we only have the wind data we have!"*

**That is right, and the first draft of the table above had it backwards.** It said a bay and its
lake are "genuinely" the same cell, which reads as a claim about the wind. It is a claim about
**WTK's grid**. A cove ringed by 25 m pines with 300 m of fetch does not experience the open lake's
wind, and nothing in a 2 km reanalysis cell can see that.

**And the problem is much bigger than bays.** The corpus is 25,136 bodies with a **median of 12
acres** — a square of about 220 m a side. Almost every body in it is smaller than a *tenth* of one
WTK cell, so the same over-claim applies to the whole corpus, not to the ~120 sub-areas. The bay
question just made it visible.

**Nothing finer exists as a gridded product**, and that is worth recording so it is not re-searched:
WTK is **2 km** and is the finest public reanalysis for CONUS; HRRR is 3 km, NAM 3 km, ERA5 25 km.
There is no sub-kilometre wind climatology to buy or download.

So there are exactly three honest moves, and the first two are free:

1. **Say what it is.** The rose is the 2 km cell's, wherever it is shown — for a bay *and* for a
   12-acre pond. D3's rule against implying knowledge we do not have applies to a wind rose as much
   as to an ice condition, and this is the first place in the phase where the copy has to carry a
   caveat the data cannot remove.
2. **Fetch is genuinely local, and we already compute it.** `fetchProfileM` is 16 sectors measured
   off the body's own outline, so a cove's 300 m and the broad lake's 15 km are already distinguished
   per body and per sub-area, at zero cost. It is a real answer to *part* of the question — the part
   about how far the wind runs before it reaches you.
3. 📌 **A terrain-and-canopy shelter index is the part fetch cannot answer, and it is buildable.**
   Fetch measures open water; it says nothing about the 25 m pines on the shore. A per-sector
   topographic-and-canopy exposure index over a **30 m DEM** plus **NLCD tree-canopy cover** would,
   and both are free, public-domain and un-metered. **The DEM is the interesting part: D104 chose the
   EPQS point service over the 3DEP raster tiles specifically to avoid a ~4 GB download** — and this
   is the second use that would justify taking the raster after all. Nothing needs mirroring to R2;
   the index is computed once locally and only the 16 numbers are stored.
   **Not scoped here.** It belongs with the wind pass (N7 step 11), it should be priced against a
   measured sample rather than an estimate, and it is a *modelled* signal — so if it ships it is
   labelled as one, and it never turns into a safety claim (cf. D82, where bathymetry was ruled
   "context, not counsel").

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
6. **A tile stamp.** ⚠ *Kickoff call 1: mint the key, skip the tiles.* Contour tiles are stamped with `externalId`, and a sub-area has none. It needs
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

⚠ *Kickoff correction:* the one function (`rederiveSubArea`) can recompute everything **except
depth**, whose inputs live in the bathymetry archive on disk rather than in Convex. So the function
*clears* the depth on a geometry change and the admin card asks for a re-run of the export — nothing
beats stale (D3). See §The re-derivation in the kickoff pass.

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

⚠ *Kickoff refinement (call 4):* the signal is stored as `gpsActivities.leftSubArea` — sampled
points in the bay **and** on the parent outside every bay — not "starts inside"; a track's primary
bay is the majority of its samples. See §The two-bay skate.

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

[`next-gen-weather-shelter-index.md`](./next-gen-weather-shelter-index.md) ·
[`next-gen-weather-stations.md`](./next-gen-weather-stations.md) ·
[`next-gen-US-spellings.md`](./next-gen-US-spellings.md) ·
[`phase-N2-lake-editor-and-subareas.md`](./phase-N2-lake-editor-and-subareas.md) ·
[`phase-N6b-bathymetry-layer.md`](./phase-N6b-bathymetry-layer.md) ·
[`phase-N6d-lake-access-points.md`](./phase-N6d-lake-access-points.md) ·
[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) ·
[`phase-N7b-corpus-by-request.md`](./phase-N7b-corpus-by-request.md) ·
[`phase-N8-notification-pipeline.md`](./phase-N8-notification-pipeline.md) ·
[`01-decisions.md`](./01-decisions.md)
