# N6a — Lake depth: the precedence ladder and the shallow signal

*The body-level depth attribute the D56 decay model was designed around and never got, plus the
consumer that makes it mean something. One ETL, one core change, one display surface.*

> **Status: ✅ BUILT 2026-07-30 · reviewed 2026-07-31** — every suite green (core 1,029 · convex 826 ·
> web 222 · mobile 79 · etl 33 · lake-depth 29 · admin-areas 14 · design 61). The review pass found one
> real defect and five smaller ones, and Greptile's pass on PR #33 found a seventh — all fixed on the
> branch. See *§What the review found in the build*, which is where the D68 amendment 2 (the three-state
> operator override) and the pair invariant are written up.
> **The ETL has not been run yet**: it needs three
> third-party downloads and a licence/column confirmation on the first pass (see *§Open questions*), so
> the code path is tested but no real depth is loaded. Not device-tested; prod deferred, as every phase
> since 2.5.
>
> ⛔ **Do not run the ETL until [N6c](./phase-N6c-expanded-lake-profiles.md) is complete** (founder call,
> 2026-07-31). N6c's elevation pass wants to ride this same run, and running without it costs a second
> full pass over 116,070 bodies. See *§Before the ETL runs — the ordering gate*.
>
> Split from the register's single **N6** entry at kickoff: the founder's ask for **real bathymetric
> contour lines inside the lake polygons** turned out to be both feasible and phase-sized, so it became
> [**N6b**](./phase-N6b-bathymetry-layer.md) and this doc keeps the scalar depth attribute + its decay
> consumer. New decisions **D68** (the precedence ladder) and **D69** (shallow amplifies thaw only).
>
> **Four of the register's premises about this work were false**, all checked against code — see
> *§What the kickoff found in the register*. The largest: the `isShallow` scalar this entry says it is
> "replacing" **has never existed**, so N6a is not sharpening a stand-in, it is building the signal for
> the first time. And **one of this plan's own claims was false**, caught by a property test in seconds —
> see *§What the build found in the plan*.

## Why this is its own pass

The register filed N6 as *"a one-time spatial join … Own data PR — no app changes."* That framing is
what hid the problem: a data PR with no app changes has, by construction, no consumer, and the reason
depth was wanted in the first place is D56's shallow-water decay signal. Stamping three columns nothing
reads would have reproduced exactly the failure this doc's §*What the kickoff found* documents — a
signal designed in a plan, described in prose as though wired, and never actually connected.

So N6a is deliberately **data + consumer + disclosure**, in one review surface:

- the **ETL** that resolves a depth for each body it can, and records *where the number came from*;
- the **core** change that turns depth into a decay input, one-sidedly (D69);
- the **display** that shows mean and max depth to skaters without a modelled guess wearing a survey's
  clothes.

What it is *not*: contours (N6b), and anything to do with the corpus below the data's reach — see
*§What this does not cover*, which is the honest half of this phase.

---

## What the kickoff found in the register

Same discipline N1/N2/N3 applied to their entries. Four corrections, each verified against a file.

**1. The `isShallow` scalar does not exist, and neither does any consumer of depth.**
`plans/phase-10-weather.md:408` says *"the decay model reads a simple `isShallow` scalar and doesn't care
where it came from"*, and the register's N6 entry says this backfill replaces *"the manual
`shallow_bay_early_thaw` `bodyFeature` stand-in"*. Neither is true. `grep isShallow` over `packages/`
and `apps/` returns nothing at all. `shallow_bay_early_thaw` appears in exactly two places — the enum
(`packages/convex/convex/lib/enums.ts:144`) and a dropdown label
(`apps/web/src/components/admin/HazardModeratorControls.tsx:29`) — so a moderator can set the feature and
it renders as a pin, but it changes no decay anywhere. `decayMultiplier(type, weather, opts)`
(`packages/core/src/hazardWeatherDecay.ts:207`) takes **no body-level input of any kind**.

This is the correction that reshaped the phase. The stand-in was never wired, so "replace the stand-in
with real data" was replacing something that wasn't load-bearing. **The signal is the deliverable; the
data is what makes it reach more than a handful of hand-flagged bodies.**

**2. "No app changes" isn't achievable, and the field shape in the entry is wrong.** Depth needs
`waterBodies` columns and an enum, which is a schema change however small. More substantively, the entry
proposes a single `depthSource` — but mean and max depth will routinely arrive from **different**
sources (LAGOS-US has 17,675 max depths and only 6,137 means), so one scalar cannot honestly describe
both. Provenance is **per measurement**. See D68.

**3. "Replacing the manual stand-in *for most bodies*" is off by an order of magnitude — and the
correction is better news than the claim.** HydroLAKES only includes lakes ≥ **10 ha**. Sampling 4,000
of the dev corpus's 116,070 bodies (`waterBodies`, `mcp__convex__runOneoffQuery`, 2026-07-29):

| band | count | share |
| --- | --- | --- |
| < 1 ha | 2,928 | 73% |
| 1–10 ha | 792 | 20% |
| **≥ 10 ha** (the HydroLAKES floor) | **280** | **7%** |

So ~8,100 bodies of 116,070, not "most". **But** cross-tabbed against `minVisibleZoom`, every one of the
234 sampled bodies that draws at **z ≤ 10** is ≥ 10 ha — **234 of 234** — as are all 16 bodies carrying a
`curatedBoost`. HydroLAKES' area floor and our D49 "prominent enough to draw at regional zoom" cutoff
coincide almost exactly. The data reaches 7% of the corpus and 100% of the part of it a skater browses
at regional zoom.

The register's phrasing was wrong in a way worth keeping visible, because *both* halves of the corrected
statement matter: coverage of the prominent bodies is essentially total, and coverage of ponds is
essentially nil. The second half is §*What this does not cover*.

**4. "Real data instead of a manual flag" overstates every global source.** HydroLAKES' `Depth_avg` is
`Vol_total / Lake_area` where `Vol_total` is itself geostatistically modelled for most lakes; GLOBathy's
`Dmax` is a random-forest estimate over shoreline length, area, volume, elevation and watershed area,
validated at 1,503 waterbodies **globally** (NSE 0.97, PBIAS −1.08%, NRMSE 0.17, ρ 0.94). Neither is
measured bathymetry. That is not a reason to skip them — a modelled depth beats no depth for a
volatility signal — but it *is* the reason provenance is a first-class field and the reason D3 applies to
the display. A number that came from a 90 m DEM must not render like a number that came from a
depth-sounder.

*A fifth, unrelated: `packages/convex/convex/schema.ts:352–355` is a dangling comment describing the
`isLarge` outlier flag, a field N1 deleted (the only surviving references are prose in
`waterBodies.ts:64` and `:1222`). Swept here since this phase edits the table anyway.*

---

## The data sources, as a ladder

Research at kickoff turned up a **better first source than the one the register names**, and it changes
the shape of the join: [LAGOS-US DEPTH](https://portal.edirepository.org/nis/mapbrowse?packageid=edi.1043.1)
is *observed* depth, compiled from ~65 agency / university / monitoring-program / academic sources, with
per-record source attribution and quality flags — 17,675 maximum depths and 6,137 mean depths for CONUS
lakes larger than **1 ha**. Measured, and a floor an order of magnitude below HydroLAKES'.

So no single source is "the" source. Four rungs, best-available wins, and the row records which rung it
landed on (**D68**):

| # | Source | Basis | Floor | Gives | License |
| --- | --- | --- | --- | --- | --- |
| 1 | State-agency bathymetry / operator override | **measured**, per-lake | — | mean + max | per state (see N6b) |
| 2 | **LAGOS-US DEPTH** v1.0 | **measured**, ~65 compiled sources | ~1 ha | max (17,675) · mean (6,137) | confirm at download |
| 3 | **HydroLAKES** v1.0 `Depth_avg` | `Vol_total / Lake_area`; `Vol_src` says whether the volume was *reported* or *modelled* | 10 ha | mean | CC-BY 4.0 |
| 4 | **GLOBathy** `Dmax` | random forest over P/A/V/Elev/WA | 10 ha (HydroLAKES-keyed) | max | CC0 1.0 |

Two details that fall out of the table and matter to the transform:

- **HydroLAKES' `Vol_src` is a free promotion.** `Vol_src = 1` (reported lake volume) or `2` (reported
  reservoir volume) means `Depth_avg` derives from a *measured* volume rather than the geostatistical
  model — so those rows are measured-ish and rank above `Vol_src = 3`. Cheap to honour, and it means we
  aren't throwing away real data by treating all of HydroLAKES as one rung.
- **GLOBathy is keyed on `Hylak_id`**, so it can only be joined *through* HydroLAKES. There is no path
  that takes GLOBathy without the HydroLAKES polygons (763 MB gdb / 820 MB shp), which is fine — one
  download, gitignored, clipped to our bbox with the `ogr2ogr` the ETL already requires.

**Rejected as a source: GLOBathy's 1.43M bathymetry rasters.** They are generated by rasterizing the
polygon, computing each cell's Euclidean distance to the shoreline, and converting distance to depth with
a linear equation. Depth is therefore a linear function of distance-from-shore, which means the rasters
carry no bathymetric information beyond `Dmax` plus an outline we already store. Harmless for a volume
estimate; disqualifying for anything drawn. See N6b, where this is the load-bearing negative finding.

---

## Decisions taken at kickoff

Written up in full in [`01-decisions.md`](./01-decisions.md); summarised here.

### D68 — Depth is a best-available number that carries its provenance

Four rungs, per-measurement provenance, and a `depthSource` that is a *pair* of enums rather than one.
The operator override is rung 1 and beats every ETL rung, so a re-import can never overwrite a
moderator's correction — and because `importCanonical` patches an explicit **field list**
(`waterBodies.ts:242`), depth survives a canonical re-import for free with no preservation work.

### D69 — Shallowness amplifies the thaw response only, and never the cold one

The founder call, and the reason it needed making: shallow water both **freezes** earlier and **goes
out** earlier, so the physics points both ways and a symmetric "shallow = more volatile" amplifier would
have made cold-side healing faster on exactly the ponds where a skater is least protected. The
conservative reading wins, and it has a clean implementation:
`weatherDecaySignal` (`hazardWeatherDecay.ts:152`) computes a `coldTerm` and a `thawTerm` per response
class. **Shallowness scales the `thawTerm` and never touches the `coldTerm`.**

That lands correctly in all four branches without a single sign change:

| response class | thaw term's role | shallow ⇒ |
| --- | --- | --- |
| `refreeze_healed` | subtracted (thaw keeps the lead open → persist) | persists harder |
| `structural` | added (a thaw can melt a ridge out → fade to prompt a recheck) | prompts the recheck sooner |
| `rotten` | subtracted (a thaw worsens rot → keep the warning up) | persists harder |
| `weather_insensitive` | none (m ≡ 1) | unchanged |

The invariant this buys is **directional per response class**: shallow `structural` ≥ deep, shallow
`refreeze_healed`/`rotten` ≤ deep, `weather_insensitive` identical, and with no thaw nothing changes for
any type. It can never flip a sign, so all three of D52 §5's locked sign-flips survive by construction,
and D56's never-hide bound continues to do its job unmodified.

*This doc first claimed the stronger form — "always moves the multiplier further from 1" — and the
property test refuted it during the build. In mixed weather where cold wins narrowly, a deep body reads
just above 1 and a shallow one just below; the crossing is the correct answer rather than a bug, since the
same period nets "refreezing" for a deep lake and "thawing" for a shallow one. See the correction appended
to D69.*

**Shallowness is a boolean, not a curve.** It has to be, because the manual
`shallow_bay_early_thaw` `bodyFeature` carries no number and must OR into the same input — a body is
shallow if its depth says so **or** a local flagged it. Threshold: **mean depth ≤ 3 m**, or **max depth
≤ 7 m** when mean is missing (the common case, since LAGOS-US has ~3× more maxima than means; ~0.4 is the
usual mean/max ratio). Both are `@skating/core` constants in the "signs locked, numbers tunable" family,
surfaced read-only on the Phase 7b tuning page like every other one.

---

## Schema

Four optional fields on `waterBodies`, migration-free:

```ts
meanDepthM: v.optional(v.number()),
maxDepthM: v.optional(v.number()),
meanDepthSource: v.optional(literals(DEPTH_SOURCES)),
maxDepthSource: v.optional(literals(DEPTH_SOURCES)),
```

`DEPTH_SOURCES` (backend enum, `lib/enums.ts`): `operator` · `state_agency` · `lagos_us` ·
`hydrolakes_reported` · `hydrolakes_modeled` · `globathy` · `osm_tag`. The split HydroLAKES values are
what make `Vol_src` legible downstream, and `osm_tag` exists for the register's opportunistic-ETL bullet
(`depth`/`maxdepth` tags, near-zero coverage on inland lakes, carried when present).

No index. Depth is read with a body already in hand — the decay cron has the row, the drawer has the
row, the editor has the row — so there is no query that selects *by* depth. (If a "shallow bodies"
operator list ever wants one, it is the `by_curated_boost` pattern and can be added then.)

---

## Work breakdown

**A — Core: the classifier + the one-sided amplifier.** `isShallowDepth({ meanDepthM, maxDepthM })` with
the two thresholds as exported constants; `WeatherDecayOptions.shallowThawK` (default 1.5, tunable);
`weatherDecaySignal` / `decayMultiplier` / `weatherAdjustedFreshness` take an optional `isShallow`.
Property tests for the D69 invariant above, plus re-running the three existing sign-flip properties with
`isShallow: true` so the locks are proven under the new input rather than assumed. Default `false`
everywhere ⇒ every existing call site is unchanged and fail-open.

**B — Convex: the fields, the override, and the cron thread.** The schema fields + enum; an
`isShallowBody` helper that ORs the depth classifier with an active `shallow_bay_early_thaw` row from
`bodyFeatures.by_water_body_active`; `listActiveHazardsForWeather`'s job shape gains `isShallow` (**the
body row is already loaded there** for `weatherSamplePoints`, so this is free) and `hazardWeather.ts:214`
passes it to `decayMultiplier`. A moderator `setDepth` mutation writing rung 1 + a `moderationActions`
audit row, mirroring `setCuratedBoost` (`waterBodies.ts:828`). Because the multiplier is precomputed and
stored on the hazard row, **the mobile on-ice alert inherits the shallow signal with no client work** —
the same property that made D56's offline story work.

**C — ETL: `scripts/lake-depth`.** A third sibling to `scripts/etl` and `scripts/admin-areas`, same
four-stage shape (fetch → convert → tested TS transform → chunked idempotent load), same `--prod` guard,
same README discipline. The join is a spatial match of source lake → our body, reusing the geodesic
helpers and the `@skating/core` matching shape `dedup.ts` already established rather than inventing a
second notion of "these are the same lake"; the transform resolves the ladder per body and emits
NDJSON of `{ externalId, meanDepthM?, maxDepthM?, meanDepthSource?, maxDepthSource? }`. Loader
`importDepths` upserts by `by_external_id` and **refuses to overwrite an `operator` rung**.

**D — Clients: source-aware display.** Mean + max on the lake drawer / detail sheet on both clients,
metric-or-imperial per D25, with framing driven by the source enum: a measured depth reads plainly and
names its source, a modelled one reads as an estimate. The `~` and the word *estimated* are the whole
mechanism — cheap, and it keeps a DEM-derived guess from looking like a survey. Plus the depth fields in
the N2 per-lake editor (`/admin/water/$id`), which is where rung 1 gets entered.

---

## What this does not cover

The honest half, stated plainly because the register's version of this entry did not.

**The shallow signal matters most for exactly the bodies no global source reaches.** Small ponds go out
first — that is the whole physical intuition behind the signal — and 73% of our corpus is under 1 ha,
below even LAGOS-US' floor. So N6a does **not** retire the manual `shallow_bay_early_thaw` flag; it
finally *wires* it, and then extends its reach to the prominent bodies where "it's big, so it's deep" is
a bad inference. Shelburne Pond is the case in one line: 194 ha, in our corpus, curated-boosted, and
about 1.5 m mean depth.

Locals will remain the best source for ponds indefinitely. The `bodyFeature` path is therefore permanent
infrastructure, not a stand-in — which is a straight reversal of what the register said about it.

**Deferred out of this phase:**

- **Bathymetric contour lines** → [N6b](./phase-N6b-bathymetry-layer.md), including the Maine
  point-interpolation note and the four states' sources.
- **State-agency bathymetry as an ETL rung.** Rung 1 exists and the operator can type a number into it,
  but bulk-loading NH GRANIT / VT ANR / MassGIS / NYSDEC *depths* is deferred to N6b, where those
  datasets are being fetched anyway for their contours. Doing it twice would be the mistake.
- **A depth-derived freeze-up prior** ("this pond usually takes first ice"). Depth plus degree-days is
  the classic Ashton-style estimate, and it is a **prediction**, which D3 says is not ours to make until
  there is a corpus to validate against. Related to, and gated by, the same three-seasons corpus gate as
  hazard-recurrence promotion.
- **A continuous depth curve** in place of the boolean. Wants the D-magnitude refit's corpus, and the
  boolean is what the `bodyFeature` can express.

---

## What the first real run found — 2026-08-02

*The gate lifted, the archive was built, and the ETL ran for the first time. Four corrections, three of
them to things that had been written down confidently and never executed.*

**1. The load batch was sized against the wrong limit.** `MAX_BATCH_COUNT = 25` carried a comment
saying bytes "never bind here" because the input records are tiny — a point and two numbers. True, and
beside the point: **what the mutation reads is the corpus, not the input.** Convex caps a transaction
at **16 MB of reads** as well as 4,096 reads, a body averages 1.8 KB, and the N1 cell index files large
bodies at coarse rungs — so a lookup anywhere near Champlain or Ontario drags a ~300 KB polygon in.
Twenty-five of those blew the byte cap at batch 8 of 1,611. Now 8, tunable with `--batch=N`. This is
the same class of finding as N1's original geospatial blowout, arrived at from the opposite direction.

**2. The loader rethrew on the first failed batch**, so one dense neighbourhood killed a run with
1,603 loadable batches behind it. The water ETL and admin-areas loaders had already learned this
today; this one hadn't been updated to match. Isolated failures are now recorded and skipped, five
consecutive aborts, and skipped batches are itemized **by lake key** — a batch index is meaningless
once the scratch file is gone, and the named lakes are exactly what a `--batch=1` retry needs.

**3. GLOBathy is not "the basic-parameters CSV".** The zip holds 17 files: fifteen 100K-lake splits,
a README, and `GLOBathy_basic_parameters(ALL_LAKES).csv` with all 1,427,688 rows. Globbing `*.csv`
double-counts every lake.

**4. The `Dmax` column, and what it actually is.** The parser's candidate list led with `Dmax_use`;
the published column is `Dmax_use_m`, so it refused the file — the fail-loud design working as
designed. Checking *why* was the valuable part: measured over a 200k-row sample, `Dmax_use_m` equals
`Dmax_est_PAVEW_m` (the shoreline/area/volume/elevation/watershed fit) for **99.5%** of lakes and
carries a round, plainly *reported* figure for the rest. So it is the model **with known depths
substituted in** — better than either pure column, and not simply "the random-forest column" as the
docstring claimed. One consequence, left alone deliberately: for that 0.5% a `globathy` rung is a
reported depth wearing a modelled label, so D68 under-rates it. The substitutions are the world's
largest lakes, our region has almost none, and correcting it would mean carrying a second column to
re-rank the ladder's floor.

**5. `SHALLOW_MAX_DEPTH_M = 7` is right — the settlement plan ran, and the guess held.**

This doc set 7 m provisionally and said so loudly: *"explicitly not because 7 is right"*, the middle of
an honest 5–9 m band, with a named way to settle it — fit the max cutoff that best reproduces the
`mean ≤ 3 m` classification against LAGOS-US' lakes carrying **both** a measured mean and max. That set
now exists: **3,139 lakes in our five states**, 6,137 nationwide.

| cutoff | accuracy (our 5 states) | over-classified (FP) | **missed (FN)** |
| ---: | ---: | ---: | ---: |
| 5 m | 83.8% | 19 | 489 |
| 6 m | 87.0% | 62 | 346 |
| **7 m** | **88.1%** ← best | 177 | 196 |
| 8 m | 87.2% | 297 | 106 |
| 9 m | 85.4% | 383 | 75 |

**7.0 m maximises accuracy on our region, and independently on the national set (87.5%).** Two
different populations, same answer, arrived at without reference to the reasoning that produced it.

**But accuracy is the wrong objective here, and the doc already says why.** Under D69 the errors are
asymmetric: a false positive makes a thaw warning linger (bounded by the never-hide rule), a false
negative loses the signal on a lake that deserved it. At 7 m the two are nearly balanced — 177 against
196 — which is *not* the "lean generous" this doc argues for. **8 m cuts misses from 196 to 106 for
0.9 points of accuracy.** That is the real trade, and it is a founder call rather than an arithmetic
one: the table above is what the settlement plan promised, not a recommendation to move the constant.

Caveat worth keeping with the number: LAGOS-US lakes are > 1 ha, and 73% of our corpus is below every
global source's area floor. This calibrates the rung that reaches the lakes we have data for; the
`shallow_early_thaw` `bodyFeature` remains the only signal for the rest, as designed.

**6. The match rate was measured against a denominator three quarters of which was never eligible.**
LAGOS-US is nationwide; we cover five states. 12,928 of its 17,675 rows can never match, and each one
still cost a spatial query. Fixed with a `--states=` filter on the transform, reading LAGOS' own
`lake_states` column — which makes the rate a rate *and* cuts roughly a third off the load's wall
clock. Dropped rows report as `outOfRegion`, named apart from `skipped`: a scope boundary is not a
failure.

**7. The zero-buffer join lost 40% of the prominent bodies, and now has a corroborated fallback.**
`matchDepthSource` (`@skating/core`) keeps containment as the primary path and, when it finds
nothing, looks within **500 m** — accepting only on independent corroboration: areas agreeing within
**1.25×**, or names agreeing (≥ 0.8, the same `nameSimilarity` D36 uses) with areas inside the
containment gate. The invariant, asserted as a property test: **the fallback is never looser than the
primary.** Strong geometry can afford a loose attribute check; weak geometry cannot.

Misses now split into `no_body_nearby` (the corpus has nothing here — 4 of 10 sampled misses) and
`proximity_unconfirmed` (something was there and we declined it). Only the second is worth a human's
attention, so they no longer share a counter. Proximity matches are counted apart as
`matchedByProximity`, because it is a weaker claim than containment and should never be invisible.

*An existing test asserted the old rule* — a point 330 m off shore with identical area, refused. That
test was the decision that cost the 40%. Replaced with three: same-area nearby now matches,
**different-area nearby is still refused** (3× area, which the containment gate would have allowed),
and nothing-within-500 m still counts as unmatched.

**What the transform emitted**, as a baseline for the next run: 40,260 records from 22,585 HydroLAKES
+ 1,427,688 GLOBathy + 17,675 LAGOS-US — 40,260 with a max, 28,722 with a mean. Only **279 of the
HydroLAKES means are `hydrolakes_reported`**; splitting that rung out was nearly free and is nearly
empty. Lake Ontario spot-checked at 84.8 m mean / 244 m max against published ~86 / 244.

## What the build found in the plan

**This doc's stated D69 invariant was too strong, and a property test refuted it in about two seconds.**
The plan said shallowness "always moves the multiplier further from 1 in whatever direction the type
already went." False in **mixed** weather: with cold and thaw both present and cold winning narrowly, a
deep body reads just above 1 while a shallow one reads just below — closer to 1, and on the other side of
it. The crossing is **correct** rather than a bug, because the same period genuinely nets "refreezing" for
a deep lake and "thawing" for a shallow one, which is the entire content of D69. What holds absolutely is
directional per response class: shallow `structural` ≥ deep, shallow `refreeze_healed`/`rotten` ≤ deep,
`weather_insensitive` identical, and with no thaw nothing changes for any type. Corrected in D69, in the
module doc, and above. Worth recording because a test asserting the plan's version would have been a test
asserting a misunderstanding — and it would have passed, since a single-signal fixture never reaches the
mixed case.

**A second thing the tests documented rather than fixed:** at a large thaw the existing `multiplierFloor`
is already reached, so the amplifier has nowhere left to go. D69 works strictly inside the D56 clamps and
does not widen them, which confines its effect to the mid-range where confidence is genuinely in question.
That is the intended behavior, so it is pinned by a test rather than tuned away.

**The plan under-specified the ETL's join, and the honest shape is different from the other two ETLs.**
"A one-time spatial join" reads as something the transform does. It can't: every source is keyed to its
own lake ids (`Hylak_id`, `lagoslakeid`) and none knows anything about OSM, so there is no join key, and
matching locally would mean exporting all 116,070 bodies **with their polygons** first. The join therefore
runs **server-side** (`waterBodies.matchAndImportDepths`), where ~8k source lakes cost ~8k small indexed
lookups against the N1 cell index. A side benefit worth having: it reuses `listedBodiesNearCoord`, so the
depth join and the app's own "you're at Lake X" resolution agree by construction about which body a point
is on.

**One guard the plan didn't ask for and the work demanded.** A geometric join has exactly one failure mode
that produces a *wrong* answer instead of no answer: a big lake's representative point landing inside the
small pond next door, stamping 40 m of depth onto it and quietly telling the decay model that pond is deep.
So the match carries an **area gate** — reject if the two areas disagree by more than 4×, and name the body
it declined. Deliberately loose, because the three sources each draw a shoreline from a different water
mask at a different date: a false reject costs one lake its depth, a false accept corrupts a safety input.

## Verified against dev

Deployed to dev (`agile-bee-397`) 2026-07-30 and exercised there, on the N3/N4 principle that running the
job is what finds the bug tests don't.

- `listActiveHazardsForWeather` now returns `isShallow` per job against the real 116,070-body corpus —
  `false` for dev's one live hazard, which is right: its body has no depth on record and no
  `shallow_bay_early_thaw` feature. The extra indexed feature read is per *distinct body*, not per hazard,
  and the query returned well inside budget.
- `refreshHazardWeather` ran clean end to end with the new body context threaded through.
- Depth reads 0 on every sampled body, as expected — **the ETL has not been run**, only tested.

**One observation from the live data worth keeping.** Dev's single `open_water` hazard sits at
`decayMultiplier: 0.5` — the `multiplierFloor` — because it is July and the thaw signal saturates. So the
D69 amplifier would change nothing for it, which is the clamp behavior a test already pins. The practical
consequence: **the shallow signal is invisible in high summer and does its work in the shoulder season and
in mid-winter thaws**, which is exactly the window where a skater is deciding whether to trust a fading
pin. Worth knowing before anyone looks for its effect in the wrong month and concludes it isn't wired.

## What the review found in the build

A full read of the branch against this doc, 2026-07-31, before the PR. Six changes; the first is the one
that mattered.

**1. The operator editor laundered modelled depths into rung 1, and the mutation let it.** `setDepth`
took a plain number per field and stamped `operator` on everything it received, while the editor
pre-filled both fields from whatever the row held. So a moderator who opened a lake carrying a
HydroLAKES mean and typed the max they *did* know silently relabelled a 90 m-DEM estimate as a survey
reading: the public caption lost its `~`, and `winsLadder` then locked the value against every future
import. **Provenance you can launder by accident is not provenance** — and this was D68's own display
rule being broken by the one screen built to serve it.

The fix is a three-state contract per measurement, because "the moderator left this box alone" and "the
moderator wants this gone" are different instructions and the first cut could not tell them apart:

| sent | meaning |
| --- | --- |
| absent | leave the value **and its rung** exactly as they are |
| a number | the moderator's own reading, stored at rung `operator` |
| `null` | an explicit **rejection**: the number goes, the `operator` rung stays as a tombstone |

The editable boxes now hold `operator` values only; an imported value renders as text with its source and
two explicit actions (**Reject**, and **Restore** via the new `clearDepthOverride`). And the card
re-syncs when the row changes underneath it, which it previously never did — a `useState` initializer
runs once, so an ETL run mid-session left you editing a number that was no longer there.

**2. The tombstone is new, and it inverts a stated invariant on purpose.** *Never provenance without a
number* was protecting the caption, not the row: `describeLakeDepth` renders nothing without a number, so
an operator rung with no value is invisible to skaters and legible to the ladder. That is exactly the
split we want, because "a human read HydroLAKES' 14 m and says it's wrong" is a durable claim about the
lake and has to outlive the next run or it isn't worth making. The loader now reports those separately
(`operatorHeld`) instead of folding them into "already had a better source", so the person running the
ETL sees the collision and can release it deliberately.

**3. The ETL write path had no sanity check on the number.** `setDepth` has refused implausible depths
since day one; `applyDepthLadder` — the path that writes ~8k rows nobody reads first — validated only
provenance. The transform's `-9999` filter is one third-party column rename away from missing a `-999`.
Same positivity and `MAX_PLAUSIBLE_DEPTH_M` guard now runs at the write boundary, counted and named.

**4. LAGOS-US rows are merged per lake, and the merge rules are asymmetric.** The transform emitted one
record per CSV row; several rows for one lake all land on the same body at the same rung, and `winsLadder`
accepts an equal rank — so the stored value was whichever row the file listed last. Arbitrary, and
invisible. Now: **a max takes the deepest reading** (an extremum is the union of what surveys found), a
**mean takes the median** (a mean has no combining rule; the median resists one bad record and is always
a number somebody reported — never an average nobody did).

The tempting shortcut was rejected on the record: since D69 makes a false "shallow" the *cheap* error, one
could take the shallowest reading everywhere. But this number is **displayed**, and biasing a published
depth toward shallow is the D3 violation the provenance work exists to prevent. The measurement stays
honest; the conservatism stays in the threshold, where `SHALLOW_MAX_DEPTH_M`'s generous 7 m already puts
it. What is *never* silently merged is a disagreement that **crosses a threshold** — some records saying
shallow and others not — which is counted, named, and left for review, because there the merge decided a
safety classification rather than a display detail.

**5. `resolveDepth` was a true orphan and is deleted.** Written when the plan had the transform resolving
the ladder locally; the join moved server-side mid-build and `applyDepthLadder` is the surviving
implementation. Keeping it would have been the second copy of the ladder that function's own docstring
says it exists to prevent. `importDepths`, the other unused export, is **not** an orphan — see 6.

**6. The OSM depth-tag rung existed in the enum with no producer.** The register asserted it was folded
into N6a; nothing carried it, so `osm_tag` was decoration. Built now in the **water** ETL, which is the
only pass that sees an OSM feature: `--depths` writes a second NDJSON stream, `load-depths` sends it to
`importDepths` (which keys on `source` + `externalId` — exactly what it was built for, and now has a
caller). The parse is deliberately strict, and one mapping is safety-relevant: **a bare `depth` tag
becomes a `max`, never a mean.** OSM documents `depth` loosely enough that mappers use it for all three,
and the mean is the field that *wins* the shallow classification — read as a max it enters through the
generous 7 m fallback instead, which is the direction that keeps a shallow lake shallow. Only the
explicit `depth:mean` is trusted as a mean.

**7. Greptile (PR #33) found the sibling of 3: the guard was on the value, not on the pair.** The ladder
resolves each measurement independently, which is D68 working as intended — mean and max routinely come
from different rungs. But *independently resolved* is not *jointly valid*: two sources that matched
slightly different lakes, or two models that disagree, can each win their own slot and leave `mean 30 m`
beside `max 6 m`. `setDepth` had refused a transposed pair from day one; the automated path had no such
check, so an inverted pair could be persisted, displayed as `mean 98 ft · max 20 ft`, **and** used to
classify the body — the contradicted mean being the half that wins the classification.

A mean cannot exceed a max in one basin, so the pair is not a disagreement to average out: one of the two
numbers describes something else. The ladder therefore settles it the way it settles everything —
**the better-ranked measurement wins.** When the loser is an incumbent it is *retracted* rather than left
in place, because leaving it keeps the impossible pair live; clearing its rung means a later run refills
it once the sources agree, and `winsLadder` guarantees the loser is never an operator's number. **On a
tie the mean goes**, which is the conservative half rather than an arbitrary one: dropping it routes the
body through the generous `SHALLOW_MAX_DEPTH_M` fallback, the direction that keeps a shallow lake
classified shallow when we are least sure (D69's asymmetry). Counted and named per lake, since a cluster
of inversions in one area is a *join* problem wearing a depth problem's clothes.

*Deferred out of the review, folded into N6c:* the per-lake **record timeline** (`moderation.listActions`
already answers the query — this is a UI component) and **per-run ETL summaries** stored rather than
printed to a terminal that scrolls. `setDepth` and `clearDepthOverride` already write `prev` into their
audit metadata, so the timeline will have before/after from the day it renders.

## Before the ETL runs — the ordering gate

> ⛔ **Founder call, 2026-07-31: hold the run until N6c is complete.**

The loader is written, tested and deployed, and the instinct is to go get the data. Don't yet.

**The reason is one column.** N6c's Workstream A1 adds `elevationM` from the Open-Meteo Elevation API —
a per-centroid lookup against a free, keyless endpoint, batched ~100 coordinates at a time. Folded into
this run it is a few minutes of extra wall clock on a pass we are making anyway. Run separately it is a
**second full pass over 116,070 bodies**, for a field that could have been free.

**The rule as the founder stated it is deliberately conservative:** wait for *N6c complete*, not merely
*N6c A1 built*. That is the right conservatism, because A1 is not the only N6c item that wants a pass
over the corpus, and discovering the second one after the first run is exactly the failure this gate
exists to prevent. The current inventory of what wants to ride a pass:

| N6c item | Which pass | Why it rides |
|---|---|---|
| **A1 elevation** | **this one** — the depth run | Per-centroid third-party lookup; identical shape to the depth join, and it writes to the same rows. |
| **A3 shoreline length** | the **canonical water re-import** (`scripts/etl`), not this one | It must be measured on the *pre-simplification* geometry, which only the water ETL holds (see N6c A3). |
| **A2 long axis / A4 fetch profile** | the canonical water re-import | Pure geometry, computed in `transform.ts` alongside `surfaceAreaSqM`. |
| **A5 `regionStats`** | after both | Deciles are computed *from* the loaded values, so it is a consequence of the runs, not a rider on one. |

So there are **two** passes in flight, not one, and they carry different cargo. This gate covers the
depth pass; the geometry stats ride the other and are not blocked by it.

> **✅ GATE CLEARED 2026-08-02.** N6c-1 is built: `elevationM` / `elevationSource` are on the schema,
> and `scripts/lake-depth`'s `load-elevation` writes them in the same pass as the depth join. The
> founder's conservative phrasing (*"until N6c is complete"*) was honoured by building all of N6c-1
> before the run rather than only A1 — and it earned its keep, because **A4b (the winter wind rose)
> and `interiorPoint` both turned out to want a pass too**, neither of which existed when the gate
> was written. The inventory table below was right that A1 would not be the only rider; it was
> incomplete about which.
>
> **The run order that replaced it** — see N6c's *§What the N6c-1 build found*: canonical re-import
> → **this depth + elevation run** → `regionStats:recompute` → `wind-climate load` → *(N6c-2's data)*
> → `backfillCells`. That last step is **one pass at the very end of N6c as a whole** (founder call,
> 2026-08-02), not once per sub-phase: it walks all 116,070 bodies and rebuilds every N1 cell row, and
> running it twice is exactly the duplicated work D2 was folded into N6c to avoid. It is also not
> optional — `importCanonical` resets `displayScore` to area + boost, so the D2 re-score has to come
> after everything it reads.

**When the gate lifts:** the moment N6c's A1 loader can write `elevationM` in the same invocation. At
that point the licence/column confirmation in *§Open questions* is the only thing left in the way, and
that one resolves by doing rather than by deciding.

**If N6c slips and the season doesn't wait**, the escape hatch is explicit and costed: run the depth
pass alone and accept a second pass for elevation. That is a real option, not a failure — it just should
be chosen out loud rather than arrived at by someone running the script because it was sitting there.

---

## Open questions

1. ~~**LAGOS-US DEPTH's licence**~~ → **ANSWERED 2026-08-02: CC BY 4.0.** Read off the package page by
   the founder, since the EDI portal turned out to require a login and a CAPTCHA — PASTA's public API
   refuses `listDataEntities` and the metadata endpoint for `edi.1043.1`, so no script could have
   fetched it. The full Intellectual Rights statement is archived in
   `scripts/lake-depth/.raw/lagos-us-depth/manifest.json`.

   **What the answer costs us, which is the part that was never really about the licence field.** CC BY
   is not "free to use" — it is an **attribution obligation**, and so is HydroLAKES' CC-BY 4.0. Two of
   the three sources require credit wherever their data is displayed, and `DEPTH_SOURCE_LABELS`
   does not discharge that: those are *caption labels* (`'LAGOS-US DEPTH'`), not attributions. This is
   exactly the distinction `CONTOUR_SOURCE_TERMS` was built for in N6b — *"the tile carries a short
   agency label; the licence requires particular words"* — and depth needed the same registry.

   ✅ **Built and closed the same day: `DEPTH_SOURCE_TERMS` in `@skating/core`.** Both required
   citations are recorded verbatim — HydroLAKES' from hydrosheds.org, LAGOS-US' from the EDI
   package's own recommended form (Stachelek et al. 2021, DOI `10.6073/pasta/64ddc4d0…`). GLOBathy is
   CC0 and records `requiresAttribution: false` explicitly, because *"nothing owed"* and *"nobody
   checked"* look identical in a blank entry. `attributionGaps()` returns `[]` and a test asserts it,
   so a future rung cannot ship a licensed depth without wording — the failure mode being silent
   (nothing misbehaves, the number just appears) is exactly why it is a computed gate rather than a
   remembered rule. `requiredDepthCredits(sources)` resolves the wording for the display layer,
   deliberately separate from the four-word caption: CC BY permits attribution *"in any manner
   reasonable to the medium"*, and a fifteen-author citation inside a map drawer's depth line would
   make the common case unreadable to serve a requirement a sources line already meets.

   **Still outstanding:** wiring `requiredDepthCredits` into the web and mobile drawers. Not yet
   urgent — no depth is loaded — but it is the last thing between the ETL running and the values
   being displayable.

   Three further obligations fall out of the statement's own wording, none of them onerous:
   - *"required to cite it appropriately in any publication"* — our display caption is the citation
     surface, so it must name the creators, not just the dataset.
   - *"data are updated periodically and it is the responsibility of the Data User to check for new
     versions"* — a standing obligation, which is what `.raw/` + a re-check makes cheap rather than
     forgotten. `scripts/bathymetry`'s `verify` is the pattern.
   - *"All data are made available 'as is'"* + no liability for misinterpretation — sits comfortably
     with D3 and D68, which already frame a modelled depth as an estimate rather than a survey.

   ✅ **The coverage half is answered too, 2026-08-02, by counting the archived file: 4,747 lakes
   across our five states** — VT 282 · NH 780 · ME 1,717 · MA 319 · NY 1,649. All 4,747 carry a max
   depth; 3,139 carry a mean. That is **27% of a national dataset sitting in five states**, which
   confirms the guess that New England is LAGOS' home region. Nationwide totals (17,675 max, 6,137
   mean) match this doc's figures exactly.

   ⚠ **And one of this doc's premises was wrong.** The file is **one row per lake**, not per
   observation: 17,675 rows, 17,675 distinct `lagoslakeid`, **zero to merge**. §5b of the runbook and
   `mergeLagosRows` were both built expecting many rows per lake, since the module is *compiled* from
   ~65 sources. The merge survives as a no-op that is now a **version check** rather than dead code —
   it prints what it merged either way, so a future revision that does ship per-observation rows is
   handled silently and visibly at once.

   The remaining unknown is not coverage but **match rate**: how many of those 4,747 resolve to a body
   in our corpus. That genuinely does resolve by running.

   *Original framing, kept because it was right about the method:* both halves resolve at download and
   neither has a decision inside it. The licence is whatever the EDI package's Intellectual Rights statement
   says, and coverage is a number we count. What the founder's answer *does* settle is that **nobody is
   waiting on anyone**: the first run is the check, and the transform is already built to fail loudly
   (a named error listing the headers it actually found) rather than read zero depths and report success.
   Recorded below as originally written, because the shape of what we're checking still needs to be to
   hand when someone runs it.

   **Original:** both need confirming at download
   from the EDI package's Intellectual Rights statement and by counting matches per state. **This is what
   blocks the first real run**, along with confirming the CSV column names: the transform matches headers
   case-insensitively against a candidate list and raises a *named error listing the headers it did find*
   rather than reading zero depths and reporting success, so guessing is safe but unverified. New England is
   LAGOS' home region (LAGOS-NE preceded LAGOS-US), so coverage should be comparatively good here, but
   "should be" is not a number. If the licence turns out to require attribution, it joins the
   Open-Meteo / OSM attribution set, which is a solved pattern.
2. ~~**Whether `maxDepthM` alone should set `isShallow`**~~ → **settled as provisional, with a named
   settlement plan (founder call, 2026-07-30).** Yes at ≤ 7 m, and **explicitly not because 7 is right**.

   The derivation is `SHALLOW_MEAN_DEPTH_M / 0.4`, using a typical basin mean:max ratio — but Hutchinson's
   volume development runs ~0.33 (a cone) to ~0.6 (a flat basin), so the honest range is **5–9 m** and 7 is
   its middle. The ratio also varies *with the thing being classified*: flat shallow ponds sit at the high
   end, so a genuinely shallow pond often has a max nearer 5–6 m, which makes 7 m over-inclusive.

   **The asymmetry is what decides it.** Under D69 shallowness only amplifies the *thaw* term, so a false
   positive makes a `refreeze_healed`/`rotten` warning linger and prompts a ridge recheck sooner — bounded
   by the never-hide rule and the map's opacity floor. A false negative loses the signal outright. Cheap
   error, expensive error ⇒ lean generous, which turns the over-inclusiveness objection into the argument
   *for* 7 m. (Founder confirmed the cheap-false-positive premise, which is the load-bearing half: it rests
   on `structural`'s faster fade being acceptable on a shallow lake.)

   The false negative keeps its named shape: a broad shallow sheet with one deep hole — mean 2 m, max 9 m —
   reads as not shallow, and that is the class where a sheet goes out earliest. Mitigated, not solved, by
   two existing rules: a mean **always wins** when present, and the `shallow_bay_early_thaw` flag overrides
   the number entirely.

   **Settlement: LAGOS-US DEPTH carries ~6,137 lakes with both a mean and a max — a labelled validation
   set.** `mean ≤ 3 m` is ground truth, `max ≤ X` is the prediction. **Step 6 of the ETL runbook** sweeps X
   over 4–10 m against our region's own matched lakes, minimizing false negatives first, and tests
   *relative depth* (max as a fraction of basin width, from the area every source carries) on the same set
   to see whether it separates "broad shallow sheet" from "small deep hole" well enough to earn a two-input
   rule. That check lives in the runbook rather than here **on purpose** — Phase 7b built the
   `photo_orphans` metric *and* an index to decide whether a cron was worth writing and nobody pointed at
   either for months. An evidence gate nobody points at is not a gate.

   *`SHALLOW_MEAN_DEPTH_M = 3` stays at the limnological convention* (founder call, same conversation): it
   is the one number here with outside support, and since the max cutoff is derived *from* it, moving it by
   taste would move both. Real data changes it or nothing does.
3. ~~**Whether the operator override should accept a source note**~~ → **yes, shipped 2026-07-30** as the
   **D68 amendment**. One public text field that *replaces* the `operator` rung's own label in the caption
   skaters read — "NH Fish & Game bathymetry, 1998" instead of "entered by a moderator", which was
   attribution in name only. Optional (a moderator who simply knows the pond has nothing to cite, and
   forcing it yields "local knowledge" typed by rote); cleared when no depth remains; attached only to the
   `operator` rung, so a leftover note never reads as a citation for a model's number; and carried into the
   `moderationActions` reason, since the log is where you ask on what basis a claim was made.
