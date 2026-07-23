# Phase 9 — Hazard decay calibration & behavior research

> **What this is.** The evidence-backed calibration promised in
> [`phase-9-hazards.md`](./phase-9-hazards.md) → "Research follow-up." A separate session
> (2026-07-21) mined two sources for **how each ice hazard behaves over time and weather**, then fed the
> results back into **D52** ([`01-decisions.md`](./01-decisions.md)) and the schema
> ([`06-data-model.md`](./06-data-model.md)). This doc is the durable record: the calibrated
> `HAZARD_DECAY` table, the per-type evidence, and the notes we want to keep for Phase 10.
>
> **Sources.**
> 1. **lakeice.info** (`lakeice.squarespace.com`) — Bob Dill et al.'s established Nordic-skating
>    ice-safety reference. Pages read in full: *pressure-ridges, ridge-formation, pressure-ridges-more,
>    stress-cracks, skating-hazards, feature-summary, ice-safety, ice-growth, hazard-warnings.*
>    Licensed CC BY-NC 3.0; quoted here as design input.
> 2. **Regional corpus** — `training_data/google_group/` (1,197 real VT/NH/ADK/ME posts, Jul 2025–Jun
>    2026), mined for per-type persistence/healing language. Private design input (L5a); only derived
>    tallies + anonymized fragments are recorded here, never republished verbatim.
>
> **Headline.** The Phase 9 architecture (per-type decay, three-tier healing verdict, `bodyFeatures`,
> geometry-per-type, client-side alerts) held up — the research **calibrates** it rather than
> redesigning it. Six concrete changes resulted, all applied 2026-07-21: (1) the calibrated table below,
> (2) an expanded type taxonomy, (3) `bufferMeters` on line/polygon hazards, (4) optional hazard photo,
> (5) the `ridge_crossing` passage marker, (6) two corrected Phase-10 weather signs + a
> "decay = confidence, not safety" invariant.

---

## 1. The calibrated `HAZARD_DECAY` table (the deliverable)

**Units: hours.** Admin-tunable integers (Phase 7), converted to ms only at comparison time via a
`hoursToMs` helper — so tuning is human-legible and `deriveHazardFreshness` stays a two-line compare.

```ts
// @skating/core/hazardDecay.ts — TUNABLE DEFAULTS (admin-editable, Phase 7 / D49).
// Durations in HOURS. fresh: elapsed < freshH · aging: freshH ≤ elapsed < agingH · stale: ≥ agingH.
export const HAZARD_DECAY: Record<HazardType, { tier: 'A'|'B'|'C'|'D'; freshH: number; agingH: number }> = {
  // Tier A — Volatile: refreeze/re-open within a day; cold snap or thaw flips them fast.
  open_water:     { tier: 'A', freshH: 24,  agingH: 72 },
  thin_ice:       { tier: 'A', freshH: 24,  agingH: 72 },
  overflow_slush: { tier: 'A', freshH: 24,  agingH: 72 },
  drain_hole:     { tier: 'A', freshH: 24,  agingH: 72 },
  wind_hole:      { tier: 'A', freshH: 24,  agingH: 72 },
  slush_hole:     { tier: 'A', freshH: 24,  agingH: 72 },
  // Tier A* — Very volatile: same-day information only.
  thawed_rotten:  { tier: 'A', freshH: 12,  agingH: 36 },  // ⚠ cold must NOT heal (see §5, sign-flip 1)
  ridge_crossing: { tier: 'A', freshH: 12,  agingH: 36 },  // passage marker, not a danger (see §4)
  // Tier B — Semi-persistent: re-skins/consolidates but the weak spot lingers days.
  wet_crack:      { tier: 'B', freshH: 72,  agingH: 168 },
  drilled_hole:   { tier: 'B', freshH: 72,  agingH: 168 },
  shell_area:     { tier: 'B', freshH: 72,  agingH: 168 },
  // Tier C — Structural: don't heal within a season; often grow. Warmth ESCALATES them (sign-flip 2).
  pressure_ridge: { tier: 'C', freshH: 168, agingH: 504 },
  ice_heave:      { tier: 'C', freshH: 168, agingH: 504 },
  // Tier D — Effectively permanent: bodyFeatures candidates (D53).
  spring_current: { tier: 'D', freshH: 336, agingH: 1080 },
  gas_hole:       { tier: 'D', freshH: 336, agingH: 1080 },
  reef_hole:      { tier: 'D', freshH: 336, agingH: 1080 },
}

const HOUR_MS = 3_600_000
export function hoursToMs(h: number) { return h * HOUR_MS }

export function deriveHazardFreshness(type: HazardType, lastConfirmedAt: number, now: number) {
  const { freshH, agingH } = HAZARD_DECAY[type]
  const elapsed = now - lastConfirmedAt
  if (elapsed < hoursToMs(freshH)) return 'fresh'
  if (elapsed < hoursToMs(agingH)) return 'aging'
  return 'stale'
}
```

| Type | Tier | fresh | aging | stale |
|---|---|---|---|---|
| open_water / lead, thin_ice, overflow_slush, drain_hole, wind_hole, slush_hole | A | <24h | 24–72h | >72h |
| thawed_rotten, ridge_crossing | A* | <12h | 12–36h | >36h |
| wet_crack, drilled_hole, shell_area | B | <3d | 3–7d | >7d |
| pressure_ridge, ice_heave / buckling | C | <7d | 7–21d | >21d |
| spring_current, gas_hole, reef_hole | D | <14d | 14–45d | >45d |

---

## 2. Per-type evidence & behavior

**open_water / lead (Tier A) — bimodal.** Refreezes overnight in cold *and* re-opens fast in wind/thaw.
Corpus: "skimmed over last night," "did not freeze last night," "the water lead is opening wide again…
just like a few days ago." lakeice: a lead is "a wide crack that forms when one part of an ice sheet
separates from another… most likely when the ice is reasonably thin, warming, and pressure ridges are
forming." **Key:** a refrozen lead *is thin ice* — the pin must persist faded as "*was open — may be
thinly skinned*," never clear.

**thin_ice (Tier A).** lakeice: "thin new black ice can weaken substantially in less than an hour";
grows ~⅓" overnight under radiational cooling. The most weather-gated type (Phase 10). Corpus: constant
skim-over/re-open cycles.

**overflow_slush (Tier A).** Corpus: "froze into skateable gray ice just two days later," "19 degree
temps… allowed all of the deep slush to freeze solid." Genuinely volatile; heals in ~1–2 cold days.

**wet_crack (Tier B) + width.** lakeice distinguishes tight/dry cracks (normal, tripping only) from wet
cracks (1/8"–1"+) and **wide wet cracks / transverse cracks / leads** (several inches to 18"+, track
ridges). Contraction & tectonic cracks reopen nightly, close by day. Corpus confirms skaters call dry
cracks "normal." → only wet/working cracks are hazards; and a crack's **width drives its danger**, hence
`bufferMeters`.

**drilled_hole (Tier B) — man-made only.** Re-skins overnight, weak spot lingers days. The old enum
conflated this with natural holes that *don't* heal — now split out (`gas_hole`, `reef_hole` → Tier D /
bodyFeatures).

**shell_area (Tier B).** lakeice: dry shell (visible, moderate trip hazard) vs wet shell (hard to see,
significant) form *after a thaw* when a puddle drains/skins. Corpus: "large areas of shell ice and
styrofoam." Lingers days.

**pressure_ridge / ice_heave (Tier C) — the richest case.** lakeice:
- Two types: **overlapped** (abrupt, loud, one side rides over the other; plates 1–15ft each side) and
  **folded** (buckle down/up, deep puddle in the middle, "harder to see… especially common places for
  vehicles to go through"). Folded ridges "often come apart within a few hours" → loose-plate ridge.
- **Recur in the same place annually** ("tendency to start at points of land means ridges often occur at
  roughly the same place every year") → strong `bodyFeatures` / `recurring_pressure_ridge` candidate.
- **A ridge is not simply persistent — it evolves and can escalate.** In a thaw a ridge can **melt into
  a stretch of open water in a 2-day windy warm period.** When it heals it usually becomes **ice sharks**
  (a line of refrozen blocks on sound ice — still a trip/sail/snowmobile hazard), i.e. `healing_unsafe`,
  not `fully_healed`. A folded double-ended ridge stayed active **the entire season** (Shelburne Pond,
  VT, 2012). Corpus: "most had healed," "the pressure ridge… has healed," but also "five or six parallel
  lines opened up, several feet apart, with water spurting over them."

**spring / inlet_outlet_current, gas_hole, reef_hole (Tier D → bodyFeatures).** Permanent sources.
lakeice: current holes under bridges/constrictions, gas holes over deltas (persistent marsh gas,
"deroof and become holes up to several feet"), reef holes over shallows. Corpus: "current had fully
opened up sections," "never completely." These should mostly live as `bodyFeatures`, not decaying pins.

**thawed_rotten (new, Tier A*) — the #1 killer.** lakeice: "About half the 2013 North American ice
season fatalities involved thaw conditions. The three skating fatalities all were in thaw conditions."
Thaw stages: puddle → dry surface → weakening → **rotten** ("punch through several inches with your test
pole in one stab"). See §5 sign-flip 1 for why cold must not heal it.

**Holes taxonomy (new).** lakeice glossary distinguishes: new-ice hole, **gas hole**, **drain hole**
("from water draining through an ice sheet, most common in ice <few inches after a wet thaw"), **reef
hole**, **current hole**, **wind hole** ("warm windy conditions, especially at points"), weed hole,
mush/slush hole. Corpus corroborates: "massive drain holes have opened up," "refrozen drain holes,"
"~100 healed wind holes… beautiful black ice," "a wind hole in the southern part of the lake."

---

## 3. Corpus persistence signal (message-level co-occurrence)

Heuristic tally of hazard mentions co-occurring with healing/persistence language (n=1,197):

| Type | msgs | refroze/healed | still-present | grew/worse | time-referenced |
|---|---|---|---|---|---|
| open_water / lead | 147 | 19 | 14 | 15 | 73 |
| pressure_ridge | 86 | 13 | 0 | 10 | 47 |
| thin_ice | 58 | 22 | 5 | 5 | 36 |
| spring / current | 69 | 8 | 2 | 3 | 30 |
| overflow_slush | 48 | 8 | 2 | 5 | 31 |
| shell_area | 41 | 2 | 2 | 4 | 16 |
| drilled_hole | 25 | 3 | 3 | 4 | 13 |
| wet_crack | 14 | 3 | 1 | 4 | 10 |

Reading: `thin_ice` and `open_water` dominate the *refroze/healed* column (volatile, Tier A). Ridges
show a strong *grew/worse* signal and near-zero simple "still there," consistent with "evolving,
escalating structure" rather than "static persistent." Confirms the tier shape. (Script:
`/tmp/hazard_persistence.py`-style pass over `messages.jsonl`; re-runnable from the corpus tooling.)

---

## 4. Geometry & the `ridge_crossing` passage marker

- **`bufferMeters` on line/polygon** (applied to schema). A folded ridge (loose plates 1–15ft each side,
  deep central puddle) needs a far wider uncertainty band than a hairline tectonic crack. Zero-width
  polylines can't render honest imprecision (D3) or size the proximity-alert buffer. Type-aware default
  (ridge » wet_crack), user-adjustable. Feeds `hazardProximity` directly.
- **Type-aware default `radiusMeters`** for point+radius: an open-water blob, a drilled hole, and a
  spring want very different starting circles. On-ice ergonomics win.
- **`ridge_crossing` — a "passage" marker, not a danger (v1, per founder call 2026-07-21).** The
  actionable info about a ridge is *where you can get across* ("best prospects are where the overlap
  switches sides" — lakeice). Modeled as a `hazards.type` so it reuses geometry + decay + the confirm
  loop, but: point+radius geometry, **Tier A\*** (most volatile — "reasonable to cross in the morning
  may be a mess a couple hours later"), rendered as a positive-but-cautious passage marker (not a danger
  halo), and the three verdicts relabeled by the copy helpers: `still_there` → "still crossable,"
  `healing_unsafe` → "crossing looks dicey now," `fully_healed` → "ridge closed / healed." Copy **never
  asserts safety** (D3): "reported crossable [time] — verify yourself; ridges change hour to hour."
- **Shore band (deferred to Phase 10):** "thin ice along the shore" and "ice edge" hazards are
  linear-along-shore; a "snap to shoreline" affordance would make them one-tap. Log, don't build in v1.

---

## 5. Weather & time behavior — for Phase 10 (with the corrected signs)

Quantitative backbone (lakeice *ice-growth* page):
- **Growth:** ~**1" of ice per 15 freezing-degree-days** (Ashton 1989); thin-ice growth adds wind +
  radiational cooling (Ajne/Swedish method). This is the basis for accelerating refreeze-healed types.
- **Thaw is asymmetric:** thawing runs **~30% faster than growth**, measured in thaw-degree-days;
  "15 thaw-degree-days with some wind can fill an ice sheet with wind holes and hide previous hazards."

**Three counter-intuitive sign-flips a naïve "colder → safer" multiplier gets dangerously wrong:**
1. **Thawed/rotten ice must NOT heal on cold.** A thawed sheet grows a deceptive hard skin overnight and
   collapses midday (the "overnight-ice trap"; implicated in the 2013 fatalities — victims went out on
   morning-hardened ice and stayed as it weakened). `thawed_rotten` cold multiplier **≥1**; only a human
   clears it.
2. **Ridges escalate in thaws.** Contrary to "structural = weather-insensitive (×1)," a ridge can melt
   to open water in a 2-day windy warm spell. `pressure_ridge`/`ice_heave` get a **thaw multiplier ≥1**.
   Springs/current/gas_hole remain ≈×1 (genuinely weather-insensitive).
3. **Snow lowers confidence, never heals.** Snow insulates (slows refreeze), hides folded ridges/gas
   holes ("some snow drifts may be snow caps on gas holes"), and enables under-ice erosion.
   Snowfall-since-report **reduces** confidence + flags "possibly snow-hidden," never accelerates decay.

Also for Phase 10:
- **Season/solar term.** Late-season sun weakens ice even when cold: ~600 W/m² early March vs ~70 late
  November at 45°N. Same air temp, very different risk. **Captured as accumulated shortwave radiation
  (insolation)** rather than a separate date/latitude multiplier — the radiation value bakes in the
  seasonal intensity automatically (Phase-10 scoping, 2026-07-22).
- **Depth / shallow.** Shallow ponds & bays melt from the bottom and go out first — a body-level
  shallow/pond signal sharpens decay (see `shallow_bay_early_thaw` bodyFeature). **No depth data source
  exists in OSM;** v1 ships this as a manual bodyFeature, with a HydroLAKES + GLOBathy backfill deferred
  (see `phase-10-weather.md` → Later/deferred).

**The Phase-10 variable set (expanded 2026-07-22 scoping — supersedes the original strip's five vars).**
The original `WeatherSinceSummary` (peak temp · hours near/above freezing · sun-hours · precip · max wind)
is a fine *descriptive* strip but misses what the *decay model* needs. Two kinds of addition:
- **Derived integrals (model-internal, the biggest miss):** `freezingDegreeHours` = Σ(0−tempC) over
  freezing hours and `thawDegreeHours` = Σ(tempC−0) over thawing hours — *magnitude*, not hour-counts
  (12h at −1°C vs −20°C grow ~5× different ice). These drive `decayMultiplier`. Plus
  `longestFreezeRunHours` (a *sustained* freeze, not one cold night — the `thawed_rotten` gate, sign-flip
  1) and `freezeThawCycles` (0°C-crossing count → candling/shell).
- **Raw variables we were flattening away:** **`minTempC`** (overnight low — "did it freeze last night,"
  the bimodal open_water/thin_ice driver we lacked, having only peak); **rain vs snow split** (opposite
  signs — rain degrades, snow insulates+hides, sign-flip 3 — never lump as one `precip`); **shortwave
  radiation** (insolation, the season/solar term above); **clear-night `cloudCoverPct`** (radiational
  cooling → thin-ice growth even near 0°C); and **`windGustKph`/wind-run** in context (wind during thaw =
  wind holes; during freeze = faster growth). Open-Meteo raw fields to fetch:
  `temperature_2m, precipitation, rain, snowfall, snow_depth, wind_speed_10m, wind_gusts_10m, cloud_cover,
  sunshine_duration, shortwave_radiation`. **Out of scope:** dew point / humidity / freezing-rain glaze
  (below our usable resolution). Full build plan: `phase-10-weather.md`.

---

## 6. Structural observations (worth remembering)

- **Confirmation is sparse; decay does most of the retiring.** The *entire* 4-state active community is
  ~1,197 posts/season, so a specific hazard rarely gets 2 independent `fully_healed` votes within its
  life. That's fine — it means **getting the decay constants right matters more than the confirm loop**,
  and it strengthens the value of the persistent `healing_unsafe` pin. Revisit `removalThreshold = 2`
  once reputation (D50) lets one trusted local carry more weight (Phase 6).
- **Reporting is lopsided.** `open_water` (218 occ) + `pressure_ridge` (116) + `thin_ice` (49) ≈ 80% of
  hazard mentions → surface those three as one-tap presets; tuck the rest behind "more" (UX).
- **Photos are load-bearing.** ~40% of corpus posts carry photos; ice hazards are hard to describe
  ("folded ridges hard to see" is a recurring death cause). Hence the optional `photoId` on hazards.

---

## 7. Copy vocabulary harvested (for the D3 copy helpers)

lakeice's precise terms make honest, non-authoritative copy easy to write in one place: *overnight ice*
(hardens surface, weakens midday), *splash-out ice* (former open water at edges/refrozen holes), *ice
sharks* (refrozen ridge blocks), *meringue ice* (weak, over gas holes / wide wet cracks / folded
ridges), *ice edge* (older ice meets open/thin new ice), *rotten candled ice*, *loose-plate ridge*.
Use these for freshness/verdict labels so "healed" **never** reads as "safe."

---

## 8. Open follow-ups (not blocking Phase 9)

- **Ridge-crossing "switch sides" hinting** — the richer v2 of the passage marker (suggest crossing
  spots where overlap switches). Deferred.
- **Weather-since decay multipliers** — Phase 10 (signs above locked in; magnitudes still to fit).
- **Body-level depth/shallow attribute** — needs a data source (bathymetry / OSM depth tags); Phase 10.
- **Decay-magnitude fitting from a future in-app corpus** — once real hazard rows exist, refit the
  `HAZARD_DECAY` constants against observed confirm/re-report intervals (the numbers here are
  literature+community-anecdote defaults, explicitly tunable).
