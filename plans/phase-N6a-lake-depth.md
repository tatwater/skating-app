# N6a — Lake depth: the precedence ladder and the shallow signal

*The body-level depth attribute the D56 decay model was designed around and never got, plus the
consumer that makes it mean something. One ETL, one core change, one display surface.*

> **Status: ✅ BUILT 2026-07-30** — every suite green (core 1,024 · convex 810 · web 222 · mobile 79 ·
> etl 22 · lake-depth 20 · admin-areas 14 · design 61). **The ETL has not been run yet**: it needs three
> third-party downloads and a licence/column confirmation on the first pass (see *§Open questions*), so
> the code path is tested but no real depth is loaded. Not device-tested; prod deferred, as every phase
> since 2.5.
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

## Open questions

1. **LAGOS-US DEPTH's licence and its coverage in our five states** — both need confirming at download
   from the EDI package's Intellectual Rights statement and by counting matches per state. **This is what
   blocks the first real run**, along with confirming the CSV column names: the transform matches headers
   case-insensitively against a candidate list and raises a *named error listing the headers it did find*
   rather than reading zero depths and reporting success, so guessing is safe but unverified. New England is
   LAGOS' home region (LAGOS-NE preceded LAGOS-US), so coverage should be comparatively good here, but
   "should be" is not a number. If the licence turns out to require attribution, it joins the
   Open-Meteo / OSM attribution set, which is a solved pattern.
2. **Whether `maxDepthM` alone should set `isShallow`** when a body has a max but no mean. The plan says
   yes at ≤ 7 m via the ~0.4 ratio, which is the common case rather than the edge case — worth a look at
   the real distribution once loaded, since a deep hole in an otherwise shallow pond is precisely the
   shape that ratio mishandles.
3. **Whether the operator override should accept a source note** (which agency, which survey year) rather
   than just `state_agency`. Leaning yes if it is one text field.
