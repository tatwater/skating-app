# Phase 10 — Weather-since strips + weather-driven hazard decay

> **What this is.** The build plan for Phase 10, settled in a scoping pass on **2026-07-22**. It plugs
> Open-Meteo weather into two things we already shipped: the **aging-report strip** (D19) and the
> **per-type hazard decay** (D52). It also lights up three already-deferred tasks that were explicitly
> waiting on weather-since — report **conditions auto-fill**, the Phase-06 corroboration
> **contradiction signal**, and the Phase-06 **decay-based bounty-freshness score** — plus lands the
> founder-idea **auto-suggest skate times** (which turned out to already be built in Phase 09b).
> Decisions: **D19** (descriptive-not-predictive), **D52** (per-type decay + the corrected weather
> sign-flips), **D50** (trust/corroboration), **D3** (safety-first, non-authoritative) throughout. New
> decisions **D56** (weather-decay design) and **D57** (granular posting permissions — the moderation
> lever the contradiction signal feeds).
>
> **Status:** ✅ **Complete — merged to `main` via PR #23 (2026-07-23); on dev, prod cutover deferred.**
> New decisions **D56** (weather-driven decay) + **D57** (granular posting permissions). Shipped-vs-plan
> deltas + the post-merge review rounds are in *Built — shipped vs. plan* below.
>
> **Prod note.** Like everything since Phase 02b, Phase 10 lands on **dev**; prod cutover stays deferred
> (Convex prod uninitialized, blocked on Clerk PROD env). Not a Phase 10 blocker.

---

## Built — shipped vs. plan (2026-07-23)

**Status: fully built on branch `phase-10-weather` (13 commits, all suites green — core 627 / convex 375 /
web 144 / mobile 76). Lands on dev; prod cutover still deferred.** Deltas from the plan below, all agreed
mid-build:

- **Hazard weather window unified + bounded.** Both the decay cron *and* the hazard strip use
  `[max(lastConfirmedAt, now − 7d), now]` — "since last confirmed" **capped to a recent lookback**. This
  refines the plan's unbounded "since-lastConfirmedAt": it stops a month-old ridge's degree-hours from
  saturating the multiplier, and makes the decay + strip share **one** window/cache entry (the §3/§9
  consistency requirement, which unbounded windows made impossible).
- **Bounty freshness *does* consult weather (§7c).** `bounties.create` became an **action** (clients call
  `useAction`) so the gate fetches weather-since per recent report — a big freeze/thaw reopens a bounty.
  The mid-build "weather deferred" note is void; it shipped. Split: `bountyFreshnessInputs` (query) →
  action (weather) → `createChecked` (internal mutation, auth/minor/cap/insert).
- **Conditions auto-fill is object-level "user wins":** the scheduled action fills only when the report
  has **no** conditions at all (not field-by-field), clean given `source` is one enum for the object.
- **Contradiction escalation is consensus-based + order-independent** (revised in the 2026-07-23 review;
  §7b). `settleContradictions` escalates the weather-unexplained **un-corroborated minority** (a report
  disagreeing with a *more-corroborated* one, itself un-corroborated) — never the later poster, never the
  corroborated majority — via a private `reports.contradiction` flag that drives the author's non-scoring
  `contradictionCount` and **self-corrects** (a report that later earns corroboration clears + decrements).
  Crossing the threshold files a system `contentFlags` row (targetType `user`, reason `unsafe_false_report`,
  a corroborated opponent as `flaggerId`). The `/admin` queue + Resend alert are Phase 07.
- **Units follow Open-Meteo native** (`snowfallCm`, `snowDepthM`) not the plan's loose `snowfallMm`, to
  avoid a silent unit bug; imperial conversion at display.
- **Schema is all additive/optional** (fail-open defaults) — no migration needed after all, despite the
  green light to migrate: `weatherCache` (new table), `waterBodies.weatherSamplePoints[]`,
  `hazards.{decayMultiplier,snowHidden,weatherAdjustedAt}`, `reports.conflicting`,
  `profiles.{canPostReports,canPostHazards,contradictionCount}`.
- **Test infra:** `packages/convex/test.setup.ts` stubs a benign offline `fetch` by default so the weather
  actions `reports.create` now schedules never hit the network in unrelated tests.

Commit map: §1 reducer · §4 decay core · §2 fetch+cache · §5a read-path · §5b cron+sampling · §7a
conditions · §7b-1 D57 perms · §7b-2 contradiction · §7c bounty gate · §7c+ bounty weather action · §3
strip core · §3 strip UI.

---

## 0. Headline — what's already built vs. genuinely new

A scoping scan (2026-07-22) found that **half of the original Phase 10 bullet list is already on dev**:

| Piece | Status | Where |
|---|---|---|
| `summarizeWeatherSince` pure reducer (D19 strip math) | **BUILT + property-tested** | `packages/core/src/weather.ts`, `weather.test.ts` |
| Auto-suggest skate start/end times from on-ice dwell | **BUILT (Phase 09b), wired into the report form** | `apps/mobile/src/lib/dwell.ts`, `dwellTracker.ts`, `components/ReportForm.tsx` |
| Hazard decay (`deriveHazardFreshness` + `HAZARD_DECAY`) | **BUILT — but takes no weather input** | `packages/core/src/hazardDecay.ts`, call site `packages/convex/convex/hazards.ts` `toView()` |
| Reports carry `skateEndTime`/`skateStartTime` + body coord | BUILT | `packages/convex/convex/schema.ts` |
| `openmeteo` condition-source enum | present but **unused** | `packages/core/src/types.ts` `CONDITION_SOURCES`; `schema.ts` `reports.conditions.source` |
| Live Open-Meteo **fetch** (action + cache) | **MISSING** | pattern to copy: `packages/convex/convex/isochrones.ts` (ORS) |

So the roadmap's Phase 10 bullet is stale in two places: **auto-suggest-times is done (mark it so)** and the
weather-since **reducer already exists** (Phase 10 only adds the fetch + the display wiring, not the math).

### The four deliverables

1. **Open-Meteo fetch + cache** — the one new piece of infra everything else rides on. A Convex action
   hitting the Open-Meteo **forecast API with `past_days`** (free, no key — *not* the delayed historical
   archive; see §2), cached per `(samplePoint, window)`.
2. **Weather-since strip** on aging **report** views *and* **hazard** views (web + mobile). Reducer built;
   this is fetch + wire + copy. **Plain-text, verdict-free**, forecast-`past_days` window, fetched on
   drawer-open, with **Open-Meteo attribution** (see §3).
3. **Weather-driven hazard decay** — a new pure `decayMultiplier(type, weatherSince)` in `@skating/core`
   + `effectiveAge = elapsed × multiplier`, property-tested against the three sign-flips (§4), threaded
   through the single `hazards.ts` `toView()` call site and **precomputed server-side for the offline
   on-ice alert** (§5, §6).
4. **Conditions auto-fill + the corroboration contradiction signal + decay-based bounty freshness** —
   populate the stubbed `openmeteo` condition source on report create (weather *at* the skate time);
   finish the Phase-06 `runCorroboration` stub so a weather-unexplained contradiction escalates for
   moderation **without** punishing honest "the ice changed" reports (§7, D57); and upgrade the Phase-06
   bounty-freshness gate to the weather-aware decay score (§7).

---

## 1. Weather variables — the expanded set (supersedes the original 5)

The original strip (peak temp · hours near/above freezing · hours of sun · precip · max wind) is a fine
*descriptive* strip but misses most of what the **decay model** needs. The 2026-07-21 research pass
(`research/hazard-decay-calibration-and-behavior.md` §5, lakeice.info + regional corpus) points to a richer set. Two kinds:
**derived integrals** the model consumes, and **raw variables we were flattening away**.

### The biggest miss — degree-*hours*, not hour-*counts*

The quantitative backbone is **~1″ of ice per 15 freezing-degree-days** (Ashton 1989) and **thaw runs
~30% faster than growth**. But `summarizeWeatherSince` only *counts* hours — 12h at −1°C and 12h at
−20°C read identically today, though the second grows ~5× the ice. So the model needs magnitude
integrals:

- **`freezingDegreeHours`** = Σ over freezing hours of `(0 − tempC)`. Accelerates refreeze-healed types
  (`open_water`, `thin_ice`, `drilled_hole`, `overflow_slush`, the volatile holes) toward stale.
- **`thawDegreeHours`** = Σ over thawing hours of `(tempC − 0)`, the ~30%-faster counterpart.
  *Decelerates* those same types **and escalates** the structural types (ridges melting out — sign-flip
  2) and `thawed_rotten` (sign-flip 1).

Both derive from the `temperatureC` we already fetch — we simply weren't integrating it. This pair is the
heart of `decayMultiplier(type, weatherSince)`.

### Raw variables we were losing

- **`minTempC` (overnight low) — "did it freeze last night?"** We had `peakTempC` (the warm extreme) but
  not the cold extreme. The bimodal `open_water`/`thin_ice` behavior ("skimmed over last night" vs "did
  not freeze last night") is entirely about the *nightly minimum*.
- **Rain vs snow, split — opposite signs.** Today it's one `totalPrecipMm`. Rain-on-ice **degrades**
  (latent heat + liquid water → overflow, drain holes, rotting); **snow insulates** (slows refreeze) and
  **hides** hazards (sign-flip 3: lowers confidence, never heals). Lumping them cancels the signal. Add
  `rainMm` and `snowfallMm`/`snowDepthM` separately.
- **Solar radiation (insolation), not sun-hours.** ~600 W/m² early March vs ~70 W/m² late November at
  45°N — an **8× swing** for the *same* sun-hour count. Accumulated **shortwave radiation**
  (`shortwaveRadiation`) bakes in the seasonal intensity automatically — this **subsumes the separate
  "season/solar-term multiplier"** the research doc proposed; we get it from the data instead of modeling
  a date/latitude term.
- **Clear-night radiational cooling.** Thin ice "grows ~⅓″ overnight under radiational cooling" even at
  near-0°C air temp on a clear night (the Ajne/Swedish method). Night-time low `cloudCoverPct` is a real
  *growth* accelerant that daytime sun-hours miss.
- **Wind in context, not just the peak.** `maxWindKph` is coarse. Wind *during a thaw* fills a sheet with
  **wind holes**; wind *during freezing* speeds thin-ice growth (convective cooling). Average / wind-run,
  and ideally wind co-incident with above-freezing temps, is more informative than a lone gust. Add
  `windGustKph` to the raw fetch; derive wind-run in the reducer.
- **Sustained-hard-freeze run + freeze/thaw cycle count.** Sign-flip 1 is explicit: `thawed_rotten` heals
  *only* under "a sustained hard freeze of the whole sheet — not one cold night." So the model wants
  `longestFreezeRunHours` (the longest consecutive-freezing run), not just total FDH. Repeated 0°C
  crossings (`freezeThawCycles`) drive candling/shell formation. Both derive from the hourly temp series.

### Deliberately out of scope
Dew point / humidity / sublimation and freezing-rain glaze layers are real physics but below the
resolution our data + calibration can honestly use, and they'd add copy we can't keep non-authoritative.
Researched, logged, not built.

### Code shape

- **`HourlyWeather`** (input) gains raw fields: `snowfallMm`, `rainMm` (or a rain/snow split),
  `shortwaveRadiation`, `windGustKph`. (`cloudCoverPct` already optional.)
- **`WeatherSinceSummary`** (output) gains derived fields for the model: `minTempC`, `freezingDegreeHours`,
  `thawDegreeHours`, `insolation`, `rainMm`, `snowfallMm`, `longestFreezeRunHours`, `freezeThawCycles`,
  `windRunKmh` (or avg). The existing descriptive fields stay for the strip.
- One fetch feeds both: the **strip** shows the human subset (§3); the **decay model** consumes the
  integrals (§4).

---

## 2. Open-Meteo fetch + cache

- **Provider:** Open-Meteo **forecast API with `past_days`** — free, no key. **Not the historical
  archive:** the archive is ERA5-backed and lags **~5 days**, but our entire use case is *recent* weather
  (a report from yesterday, conditions at a skate a few hours ago, a hazard's last few days). The forecast
  endpoint's `past_days` covers **up to 92 days** back from a reanalysis+forecast blend, right up to `now`.
  Hourly vars: `temperature_2m`, `precipitation`, `rain`, `snowfall`, `snow_depth`, `wind_speed_10m`,
  `wind_gusts_10m`, `cloud_cover`, `sunshine_duration`, `shortwave_radiation`.
- **One endpoint, no archive anywhere.** The longest window any consumer needs is the decay model's
  since-`lastConfirmedAt` span, bounded by the longest `agingH` (Tier D = 1080h ≈ **45 days**) — well
  inside `past_days`' 92. So `past_days` covers **both** consumers (strip *and* decay) across their entire
  meaningful range; the archive is never worth a second integration. Anything older than the window is past
  useful — the strip collapses to a plain age line (§3), it doesn't reach back.
- **Where:** a Convex **action** (Node runtime), same shape as `isochrones.ts`. Never client-side.
- **Cache table `weatherCache`:** keyed by `(samplePointKey, windowStart, hourBucket(now))` so concurrent
  viewers of the same body/window share a fetch, and windows **extend append-friendly** (bucket the `now`
  end to the hour).
- **Two triggers, one cache.** (a) The **strip** fetches **on drawer-open** — the client calls the action,
  which checks `weatherCache`, fetches on miss, writes through, returns. This is why the strip works even
  on the hazard-free bodies the decay cron never sweeps (queries can't fetch — so a read-only strip would
  silently never fill on those bodies). (b) The **decay cron** (§6) warms the same cache for hazard-bearing
  bodies as a side effect of its precompute. Neither depends on the other; the cache just lets them share
  fetches.
- **Sampling — centroid by default, grid-aware for the giants (see §5 sampling).**

---

## 3. The weather-since strip (D19) — plain-text, verdict-free

Two surfaces, two window rules, **one reducer + one fetch path** (§2).

- **Report strip.** Surfaces: the report **drawer/sheet** + the **per-body report detail** list. **Not**
  feed cards (too dense). Window = **since `skateEndTime`**, but rendered only while that span is *useful*:
  shown once it's more than ~6–12h old (a fresh report has ~no weather-since) and **capped at ~14 days
  (tunable)** — beyond the cap the report is stale on its own terms, so the strip **collapses to a plain
  age line** ("Reported 3 months ago") rather than dumping a season of weather. This cap is why we never
  need the archive (§2): the useful window is always well inside `past_days`.
- **Hazard strip (founder call 2026-07-22).** Hazards persist — a pressure ridge can last a whole season —
  so "since first reported" is meaningless. Instead the hazard strip shows a **rolling recent window
  (last ~5–7 days, tunable)**, framed as *recent weather here* / *since last confirmed*, for as long as the
  hazard is active. Always recent, always relevant, never a season-long dump. It reads the **recent
  sub-slice of the same fetch** the decay model already pulls over since-`lastConfirmedAt` — one fetch, one
  reducer, two windows (mirrors §1's "one fetch feeds both"). **Consistency:** because they share the
  fetch, the strip and the decay must agree — if a thaw just aged a ridge (§4), the strip must show that
  thaw. Assert it with a test (§9).
- **Copy — plain text like the example, no quantitative jargon, no color-coded verdict** (founder call
  2026-07-22). The degree-hour integrals stay **model-internal**; the strip reads like:
  > *Since this report: peak 41°F · low 22°F · 3 nights below freezing · 6h strong sun · ½″ rain · gusts
  > to 30mph*
- **Imperial display** (°F, inches, mph) per D25; metric internal.
- **Open-Meteo attribution (legal checklist L13).** A small "Weather: Open-Meteo" credit accompanies the
  strip wherever it appears — the same build-time-acceptance class as "Powered by Strava" / "© OpenStreetMap
  contributors." (PRIVACY.md/TERMS.md already disclose Open-Meteo as a provider; this is the in-UI credit.)
- **D3:** descriptive only — never asserts anything about current ice. No "safe/unsafe," no arrow.

---

## 4. Weather-driven hazard decay (extends D52 → D56)

`effectiveAge = elapsed × decayMultiplier(type, weatherSince)`, then feed `effectiveAge` where
`deriveHazardFreshness` currently uses raw `elapsed`. Pure logic in `@skating/core`, property-tested.

**The three sign-flips a naïve "colder → safer" multiplier gets dangerously wrong (locked in D52 §5):**
1. **`thawed_rotten` must NOT heal on cold.** Cold-weather multiplier **≥ 1 (never < 1)** — a thawed
   sheet grows a deceptive overnight skin and collapses midday. Only a *sustained* hard freeze
   (`longestFreezeRunHours`) even approaches healing, and even then the model can't assert it — a human
   clears it.
2. **Ridges escalate in thaws.** `pressure_ridge`/`ice_heave` get a **thaw multiplier ≥ 1** (warmth makes
   them *worse*). `spring_current`/`gas_hole`/`reef_hole` stay ≈ ×1 (genuinely weather-insensitive).
3. **Snow lowers confidence, never heals.** Snowfall-since **reduces** confidence and flags "possibly
   snow-hidden," and must **never** accelerate decay.

**The never-hide invariant (founder call 2026-07-22, answer to Q2 — reinforces D3/D52).** Weather can
**age** a hazard (nudge fresh→aging) but must **never fully hide** one. Concretely: the escalation
direction (thaw → *more* prominent) is fully honored, but the **cold-acceleration direction is bounded so
weather alone can never push a hazard past `aging` into the hidden/`stale` bucket** — only elapsed time +
a human `fully_healed` confirmation can fully retire a pin. A refrozen lead is still thin ice; the model
must not make a real hazard disappear on a forecast's say-so.

**Fail-open (matches the Phase 06 guardrail).** Missing/failed weather ⇒ `multiplier = 1` (fall back to
plain `elapsed`). Weather trouble can never make a hazard *less* visible.

**Admin-tunable, Phase 07.** The multiplier constants ship as tuned `@skating/core` defaults and get
lifted behind `/admin` in Phase 07, same pattern as the D52 `HAZARD_DECAY` tiers (D49). *(Shipped
read-only — D49 amendment; the "refresh now" button §5 asks for was not built: the skater path can't
show weather more than an hour old by the cache key, and the cron's lag can only slow decay.)*

**Magnitude calibration.** Signs are locked; magnitudes are literature/anecdote defaults (Ashton's 15
FDD/inch, thaw ~30% faster) and are **explicitly tunable** — refit against real in-app hazard rows once
they exist (research §8).

---

## 5. Sampling — centroid default, grid-aware for the giants

Weather doesn't vary at town resolution; below Open-Meteo's grid (~2–11 km high-res, ~9–25 km ERA5) a
per-town pull buys no signal. **Town/county boundaries are the wrong abstraction — do not use them.**

- **v1: centroid for everything.** Almost every body is smaller than one grid cell, so one pull per body
  is genuinely *correct*, not just convenient.
- **Escape hatch for the few multi-cell giants** (Champlain ~200 km is real multi-cell; Winnipesaukee
  ~30 km is borderline): an optional **`weatherSamplePoints[]`** on the water body, defaulting to
  `[centroid]`. Populate a few points spaced at grid resolution for flagged large bodies.
- **Assignment:** a hazard or report picks its **nearest sample point** by plain distance (`@skating/core`
  geometry helpers). For a complex hazard shape, use its geometry's representative point to pick the
  nearest sample. Admins set sample points for large bodies in the Phase 07 surface.

So 99% of bodies stay on the trivial single-pull path with a clean, non-over-engineered exception for the
handful that genuinely cross cells.

---

## 6. Cron architecture — only the decay needs one

The **strip fetches on drawer-open** (§2), so it needs no cron. Only **hazard decay** needs a precompute,
because it must be ready for the **offline on-ice alert** (a phone on the ice can't fetch Open-Meteo) and
must affect the **map without a viewer present**.

- **Sweep only bodies with ≥1 active (non-archived) hazard** — *not* all 116k water bodies. Cost ∝
  hazard-carrying bodies (tens, maybe low hundreds at peak season per the corpus), not corpus size.
- **Batch:** Open-Meteo takes comma-separated multi-point requests, so many bodies fold into one HTTP
  call.
- **Write-through — store the *time-independent* piece, not a pre-baked bucket.** Persist the
  `decayMultiplier` (and the accumulated FDH/TDH-since-`lastConfirmedAt` it came from) + `weatherAdjustedAt`
  on the hazard row — **not** a frozen `fresh/aging/stale` label, which would drift as `elapsed` keeps
  growing between ticks. The **online** `toView()` (a query, can't fetch) reads that stored multiplier and
  recomputes the live bucket: `effectiveAge = (now − lastConfirmedAt) × multiplier` → `deriveHazardFreshness`.
  The **offline** on-ice payload ships a snapshot bucket stamped at sync time (the best available without a
  network). The same pull warms `weatherCache` for the strip.
- **Admin-adjustable cadence, the Convex-idiomatic way.** Convex crons have fixed code-defined intervals
  (you can't change one from the DB without a redeploy). So run the cron at a **fixed short base tick
  (hourly)** but have it read an admin config (`weatherRefreshMinIntervalHours`) and **skip any hazard
  whose `weatherAdjustedAt` is newer than that threshold**, plus a manual "refresh now" admin button.
  That gives an admin-tunable *effective* cadence with no redeploy — same lever pattern as the D52
  tiers. Default effective cadence ~3h (Tier-A hazards flip in ~a day; 3h is ample and cheap).
- **Fail-open** as in §4: a lagged/failed cron leaves `multiplier = 1`.

---

## 7. Three deferred tasks the fetch unblocks

All three were explicitly waiting on the weather fetch. **Two of them run inside the `reports.create`
mutation, which can't do an outbound fetch** (only actions can) — so, following the `isochrones.ts`
precedent (an action scheduled from a mutation, writing results back via an internal mutation), `create`
**schedules a post-insert internalAction** that fetches weather and then patches the report / runs the
scoring. Both are therefore **eventually-consistent**: the report inserts immediately, the weather-derived
bits land a beat later.

- **Report conditions auto-fill (`openmeteo` source).** The scheduled action pulls the weather **at the
  skate time** (not "since") for the body's sample point and patches `reports.conditions` (`airTempC`,
  `windSpeedKph`, `windDir`, `sky`, `precip`) with `source: 'openmeteo'` — the enum is already in
  `CONDITION_SOURCES` + the schema, just unpopulated. **User-entered values always win**: a late-arriving
  auto-fill must never clobber a `source: 'user'` field (the UI should expect a brief empty→filled beat).
  **D3:** this is *observed weather*, never a safety assertion, and must read as such.
- **Corroboration contradiction *signal* → conflicting-reports disclosure + moderation escalation
  (finishes the Phase-06 `runCorroboration` stub; D50 stays boost-only; new D57).** `runCorroboration`
  today awards a boost only when `reportsAgree(report, prior)`. Its inverse is the seam: when a later
  report on the same body/window **disagrees** AND the weather-since between the two **doesn't explain the
  change**, we do **three** things — none of which subtracts trust (honest "the ice changed" reports must
  never be punished — D3/D50):
  1. **Withhold** the corroboration boost (no award — *not* a negative event).
  2. **Disclose** the conflict to skaters: both reports carry a soft **"conflicting reports"** indicator so
     the human judges the disagreement, rather than us secretly deciding who's wrong (the most D3-honest
     move).
  3. **Escalate on pattern, via humans — the un-corroborated minority, not the later poster (consensus-based,
     order-independent; settled in the 2026-07-23 review).** A report is a *contradiction* only when a report
     it disagrees with (weather-unexplained) has **strictly more corroboration** while it itself has **none**
     — so a lone false read, *whenever it was posted*, accrues the author's **private, non-scoring
     contradiction counter**, and the corroborated majority never does. (An earlier draft blamed whoever
     posted *later*, which escalated honest correctors of a false first report — see the review.) It's
     recomputed from current corroboration on each settle, so a report that *later* earns corroboration
     **clears** its flag and decrements the author (self-correcting). Once the counter crosses the threshold,
     auto-file a flag into the `/admin` queue (`contentFlags` / the safety-priority path that already triggers
     Resend operator alerts — D37/D38), with a corroborated opponent as `flaggerId`. A moderator then acts
     through the **D57 posting-permission lever** — restrict `canPostReports` / `canPostHazards` (finer and
     *appealable*, not a blunt whole-app ban).

  The deterrent against bad actors is **restriction/ban risk + the low default weight of an un-corroborated
  report**, not micro-penalties (which are both too weak for a real bad actor and too harsh for an honest
  mistake). Safety-adjacent, so it lands with tests and the boost-only invariant intact.
- **Decay-based bounty-freshness score (finishes the Phase-06 bounty-gate upgrade; reuses §4's decay
  shape).** Phase 06 blocks a new bounty when a *visible report exists within `FRESH_REPORT_HOURS` = 48h* —
  a hard cutoff. Phase 10 replaces it with a **freshness score = recency × peer thumbs × author trust ×
  weather-since**, so a well-corroborated report suppresses bounties longer than a lone stale one, and
  **warming weather reopens bounties sooner**. This is the founder's decay idea; it needs weather-since to
  be honest and reuses the same `decayMultiplier`/`effectiveAge` machinery §4 builds (it touches bounty
  *creation*-gating, not hazards). Boost-only trust and the never-hide invariant are untouched.

---

## 8. Auto-suggest skate times — already done (Phase 09b)

The founder idea "prefill the report form's skate window from the on-ice dwell interval" was **already
built in Phase 09b** (`apps/mobile/src/lib/dwell.ts` `suggestedSkateWindow` + `dwellTracker.ts`, wired
into `ReportForm.tsx` earliest-in/latest-out across today's dwells, grace-debounced). **No Phase 10 work
— mark the roadmap bullet done.** Left here so the roadmap history is coherent.

---

## 9. Testing (Cross-cutting: tests land with the feature, D40)

- **`@skating/core`:** property tests (`fast-check`, the `weather.test.ts` idiom — recompute each
  aggregate independently so a stub can't pass) for the new integrals and `decayMultiplier`. **Explicitly
  assert the three sign-flips and the never-hide bound** — these are safety invariants, not nice-to-haves.
  Also assert the **strip and the decay agree on the same fetch** (a thaw that ages a ridge must show in
  its strip — §3).
- **`packages/convex`:** `convex-test` for the fetch/cache action (mocked HTTP), the decay cron
  write-through (**stores the multiplier, not a frozen bucket** — §6), conditions auto-fill (**a late
  auto-fill never clobbers a `source: 'user'` field**), the corroboration contradiction path (**never
  subtracts trust**; escalates to a `/admin` flag only on *repeated never-corroborated* contradictions),
  the **`canPostReports`/`canPostHazards` create-gate** (D57), and the **decay-based bounty-freshness** gate
  (warming weather reopens a bounty). Give the heavier property/convex-test cases an explicit longer timeout
  (CI ~8×+ slower than local — the 5s default flakes).
- **Web + mobile:** strip rendering (verdict-free copy + Open-Meteo attribution), imperial units, the
  >6–12h gate, the report **age-line fallback** past the ~14-day cap, and the hazard **rolling-recent**
  window.

---

## 10. Schema — all additive, no migration (parity with Phase 09a)

Every field Phase 10 adds is **optional ⇒ migration-free**, matching Phase 09a's "no migrations" posture:

- **New table `weatherCache`** (§2) — additive.
- **`waterBodies.weatherSamplePoints[]`** (§5) — optional; absent ⇒ `[centroid]`.
- **`hazards.decayMultiplier` / `weatherAdjustedAt`** (§6) — optional; absent ⇒ `multiplier = 1` (fail-open).
- **`profiles.canPostReports` / `canPostHazards`** (D57, §7) — optional booleans; absent ⇒ full adult
  posting rights. Plus a private, non-scoring **`contradictionCount`** — optional; absent ⇒ 0.
- **`reports.conditions`** already exists (the `openmeteo` source is just unpopulated) — no change.
- The expanded `HourlyWeather` / `WeatherSinceSummary` fields (§1) are pure `@skating/core` types — **no DB
  migration at all**.

No backfill needed anywhere.

---

## Later / deferred

- ~~**Water body depth / bathymetry data source (the shallow-water decay signal).**~~ **→ scoped as
  [A06a](./A06a-body-depth.md) + [A06b](./A06b-bathymetry-layer.md) (2026-07-29).** Kept in full
  below because two of its claims are load-bearing and **wrong**, and someone reading this entry would act
  on them: (a) *"v1 ships the signal without the data, manually"* — **it didn't.** The `bodyFeature` was
  added to the enum and the admin dropdown and wired to no decay at all, so there is no `isShallow` scalar
  and nothing reads shallowness anywhere. A06a builds the signal for the first time. (b) *"the decay model
  reads a simple `isShallow` scalar and doesn't care where it came from"* describes an intention, not code.
  Also superseded: **LAGOS-US DEPTH** (observed depths, water bodies > 1 ha) is a better first source than either
  named here, and the manual flag is **permanent** rather than a stand-in — 73% of the corpus sits below
  every global source's area floor, and small ponds are where the shallow signal matters most.
- **Water body depth / bathymetry data source (the shallow-water decay signal).** The research (§5, §8) wants a
  body-level **shallow/pond** signal — shallow water melts from the bottom first and goes out early — but
  we have **no depth data source today**. What we learned scoping this (2026-07-22):
  - **OSM won't give it to us.** `depth`/`maxdepth` tags exist but coverage on inland water bodies is near-zero
    (they're mostly nautical). Our existing OSM ETL can't backfill depth.
  - **v1 ships the signal *without* the data, manually.** Model "shallow" as a **`shallow_bay_early_thaw`
    `bodyFeature`** (the Phase 09a mechanism + Phase 07 admin surface) that mods/locals set on known-shallow
    bodies — locals know exactly which ponds go out first, and it covers the highest-value bodies with
    zero new data source. The decay model reads a simple `isShallow` scalar and doesn't care where it came
    from.
  - **Backfill (a separate data PR, not blocking the decay math): HydroLAKES + GLOBathy.** GLOBathy is a
    modeled global body-bathymetry dataset (~1.4M water bodies) giving mean/max depth, joinable to our OSM bodies
    by spatial match. A one-time backfill stamps `meanDepthM`/`maxDepthM`/`depthSource` on water bodies.
    Our five states (VT, NH, NY, ME, MA) *also* publish good state-agency bathymetry (NH Fish & Game and
    VT DEC especially) to refine specific water bodies later.
  - **ETL update (opportunistic, future imports):** carry OSM depth tags where present (rare) and fall
    back to the GLOBathy match on import.
  - **Do this when** the decay model is proven and we want to sharpen it — the manual bodyFeature is the
    Phase 10 deliverable; the depth data is a follow-on.
- **Ridge-crossing "switch sides" hinting** — the richer v2 of the `ridge_crossing` passage marker
  (suggest crossing spots where overlap switches). Deferred from Phase 09a (research §8). *(Replaced
  by A05a's crossing-lifecycle inversion, D64.)*
- **Shore-band "snap to shoreline" affordance** — "thin ice along the shore" / "ice edge" hazards are
  linear-along-shore; a one-tap snap-to-shoreline was logged in the hazard research (§4) as a Phase-10
  idea, but it's a geometry/UX feature, not a weather one. Log; build with a later hazard-authoring pass.
  *(Built in A05b, D67.)*
- **Decay-magnitude refit from a real in-app corpus** — once real hazard rows exist, refit the
  `HAZARD_DECAY` constants *and* the `decayMultiplier` magnitudes against observed confirm/re-report
  intervals (research §8). The signs are locked; the numbers are tunable defaults.

### Deferred fast-follows (from the pre-PR code review, 2026-07-23)

Accepted as postponable at alpha scale; logged here so they're not lost. (The review's substantive fixes
— cron fail-fast on a failed fetch, empty-200 no-cache-retry, stable strip window/`near`, active-only
strip, single-sourced 7-day lookback, and the bounty-suppressor-selection fix — landed on the branch.)

- ~~**`.collect()` read-cap hardening across the weather gates.**~~ **✅ DONE in A01 (2026-07-26)**, folded
  into the `listInViewport` hardening as this entry asked. `hazardWeather.listActiveHazardsForWeather`,
  `bounties.recentReports` and the contradiction cluster load are all capped-and-logged now (via
  `lib/scan.takeCapped`). Two corrections worth carrying: **`contradictions.findContradictingPriors`
  never existed** — the real function is `contradictionCluster`, and it hid a *second* unbounded read
  this entry didn't see (a `pointEvents` scan per clustered report, an N+1 multiplying the first) — and
  `bountyFreshnessInputs` isn't itself a scan; it reads through `recentReports`, which is where the cap
  went. See [`phases/A01-read-path-durability.md`](./A01-read-path-durability.md).
- **`weatherCache` TTL / prune.** ~~No pruner today~~ *(A03: `pruneWeatherCache`, a 6 h cron with 24 h
  retention, and `pruneForecastCache`)*; a new row per `(samplePoint, windowStart, hourBucket)`
  accumulates as the `now`-bucket advances. It's a *disk-growth* concern, not staleness (served summaries
  are ≤1 hour old by the bucket key).
- **Sample-point admin surface (Phase 07).** `waterBodies.weatherSamplePoints[]` is wired end-to-end
  (cron + strip now resolve the **same** nearest point via `lib/sampling`, so they can't diverge), but
  nothing populates it. The Phase-07 admin UI should let a mod place/preview/bundle sample points on a
  flagged giant (Champlain, Winnipesaukee) on a map, spaced at grid resolution. *(A02 shipped the editor
  — `suggestSamplePoints` + `setWeatherSamplePoints` on `/admin/water/$id`; still unpopulated. Champlain
  is answered by sub-areas (A06h §8); Memphremagog and Connecticut River Reservoir are owed a grid —
  register.)*
- **Contradiction re-flag bundling.** The auto-flag dedups only on an *open* flag, so a user parked above
  threshold files a fresh `/admin` row on each further contradiction after a mod resolves the prior one.
  Bundle repeated auto-flags into one queue entry in the Phase-07 moderation surface *(built in A02:
  `lib/autoFlag.ts`, `occurrences` / `supersedesFlagId`, a 30 d cooldown)*. (The escalation
  *targeting* was fixed in the review — §7b now escalates the un-corroborated minority, order-independent,
  and self-corrects — so this is purely the mod-queue UX, not a correctness item.)


---

## Relocated from the roadmap (2026-09-16)

*The roadmap entry for Phase 10 as it stood before the 2026-09-16 rewrite, kept verbatim so nothing it said is lost. The roadmap now carries a one-paragraph summary; this is the long form.*

### Phase 10 — Weather-since strips + weather-driven hazard decay ✅ Complete (dev; prod deferred) (2026-07-23)
> **Detailed build plan:** [`phases/10-weather.md`](./10-weather.md) (scoping settled 2026-07-22;
> new decision **D56**). **Scoping scan found half of this phase already on dev:** the D19 **weather-since
> reducer** (`summarizeWeatherSince`) is built + property-tested in `@skating/core`, and **auto-suggest
> skate times is done (Phase 09b)** — see the struck bullet below. The genuinely new work is **four
> deliverables:** (1) a live **Open-Meteo fetch + `weatherCache`** (the one new piece of infra — a Convex
> action like `isochrones.ts`, on the **forecast API with `past_days`** — *not* the ~5-day-lagged
> archive — fetched **on drawer-open**), (2) wiring the **weather-since strip** onto aging report **and
> hazard** views (plain-text, verdict-free, Open-Meteo-attributed), (3) **weather-driven hazard decay**
> (`decayMultiplier(type, weatherSince)` + `effectiveAge`, threaded through `hazards.ts` and **precomputed
> server-side for the offline on-ice alert**), and (4) **report conditions auto-fill** (`openmeteo`
> source, already stubbed) **+ the Phase-06 corroboration contradiction *signal*** (withhold-boost +
> conflicting-reports disclosure + escalate-to-moderation via the new **D57** posting-permission lever —
> never a trust subtraction) **+ the Phase-06 decay-based bounty-freshness score** — the deferred tasks
> that were explicitly waiting on weather-since. Lands on **dev**; prod deferred.
- Open-Meteo "what the weather has done since this report" factual strip (D19). **Plain-text,
  verdict-free** (e.g. "since this report: peak 41°F · low 22°F · 3 nights below freezing · 6h strong sun
  · ½″ rain"); the quantitative degree-hour integrals stay model-internal. The pure reducer
  (`summarizeWeatherSince`) is already built — Phase 10 adds the fetch + display wiring, not the math.
- **Expanded weather-variable set (scoping pass 2026-07-22).** The original five (peak temp · hours
  near/above freezing · sun · precip · wind) miss what the *decay model* needs: **freezing- & thaw-degree-
  *hours*** (magnitude, not hour-counts — the ~1″/15-FDD backbone), **overnight low** ("did it freeze last
  night"), **rain vs snow split** (opposite signs — snow insulates + hides, never heals), **solar
  radiation** (insolation subsumes the season/solar-term multiplier — 8× seasonal swing), **clear-night
  radiational cooling**, **wind-in-context**, and **sustained-freeze-run / freeze-thaw-cycle** counts. Full
  variable table in the phase doc / hazard-research §5.
- **Weather-driven dynamic hazard decay (extends D52, planned here 2026-07-18; signs corrected by the
  2026-07-21 research pass).** Reuse the same Open-Meteo "weather-since" pull to modulate hazard
  freshness instead of relying on elapsed time alone: `effectiveAge = elapsed × decayMultiplier(type,
  weatherSince)`. Per-type sensitivity — **refreeze-healed types** (`open_water`, `thin_ice`,
  `drilled_hole`, `overflow_slush`, the holes) **accelerate** toward stale with accumulated
  freezing-degree-days (~1″ of new ice per ~15 FDD is the quantitative backbone) and **decelerate**
  under warm/sun/rain (a thaw can even **re-escalate** a fading `thin_ice`/`overflow_slush` hazard —
  warmth never heals these). **Corrected finding:** the structural types (`pressure_ridge`,
  `ice_heave`) are **not** weather-insensitive — a ridge can melt out to open water in a two-day windy
  warm spell, so they get a **thaw multiplier floored at ≥1** (thaw escalates, never heals), and
  `spring_current` stays effectively permanent. **The `thawed_rotten` rule (research §5 — do not let it
  live only in the research doc, it's a corrected safety finding): its decay must NOT accelerate on
  cold.** A thaw-rotted sheet grows a deceptive skin overnight and collapses midday — the
  "overnight-ice trap," implicated in the 2013 fatalities where victims went out on morning-hardened
  ice and stayed as it weakened. So `thawed_rotten` carries a very-short base decay (12h/36h) and a
  **cold-weather multiplier floored at ≥1 (never <1)**; only a sustained hard freeze of the whole
  sheet — not one cold night — heals it. **Same D3 caveat as D52:** accelerated decay ≠ "safe" — a
  refrozen lead is thin ice, so the copy must never imply skateability. Pure logic in `@skating/core`
  (property-tested, D40); admin-tunable alongside the D52 decay tiers (Phase 07). **Never-hide invariant
  (founder call 2026-07-22, D56):** weather can **age** a hazard (fresh→aging) but the cold-acceleration
  direction is **bounded so weather alone can never push a hazard past `aging` into hidden/`stale`** —
  only elapsed time + a human `fully_healed` confirmation fully retires a pin. **Fail-open** (missing
  weather ⇒ multiplier=1; weather trouble never makes a hazard less visible). **Sampling:** body
  **centroid by default** (nearly every body < one Open-Meteo grid cell — *not* town/county, wrong
  abstraction); an optional `weatherSamplePoints[]` escape hatch covers the few multi-cell giants
  (Champlain/Winnipesaukee), nearest-point assignment. **Cron:** the decay precompute sweeps **only bodies
  with ≥1 active hazard** (not all 116k) at a fixed hourly tick, skipping hazards refreshed within an
  admin-tunable `weatherRefreshMinIntervalHours` (Convex crons can't retune interval at runtime), and
  **stores the `decayMultiplier` (time-independent), not a frozen freshness bucket** (which would drift
  between ticks — online `toView()` recomputes the live bucket). The **strip fetches on drawer-open** (no
  cron — a query can't fetch, so a read-only strip would never fill on hazard-free bodies), sharing the
  same `weatherCache`.
- **Three deferred tasks the fetch unblocks (added to scope 2026-07-22).** (a) **Conditions auto-fill:**
  populate the stubbed `openmeteo` source (weather *at* the skate time) on report create — user-entered
  values always win; runs as a **scheduled post-insert action** (a mutation can't fetch), so it's
  eventually-consistent. (b) **Corroboration contradiction *signal* (D56/D57):** finish the Phase-06
  `runCorroboration` stub — a later disagreeing report counts as a contradiction **only when the
  weather-since doesn't explain the change**, and even then it **never subtracts trust** (D50 stays
  boost-only): it withholds the boost, shows a "conflicting reports" indicator, and — *on a repeated,
  never-corroborated pattern* — auto-files an `/admin` flag so a human can restrict the offender's
  `canPostReports`/`canPostHazards` right (D57, finer + appealable vs a whole-app ban). Honest "the ice
  changed" reports stay unpenalized (D3/D50). (c) **Decay-based bounty-freshness (Phase-06 upgrade):**
  replace the hard `FRESH_REPORT_HOURS = 48h` bounty gate with a **freshness score = recency × thumbs ×
  trust × weather-since** (reuses §4's decay shape) so warming weather reopens bounties sooner. All land
  with tests + the boost-only invariant intact.
- **~~Auto-suggest skate start/end times from the on-ice dwell~~ ✅ Done (Phase 09b, 2026-07-22).** Built
  ahead of schedule: `apps/mobile/src/lib/dwell.ts` (`suggestedSkateWindow`) + `dwellTracker.ts`, wired
  into `ReportForm.tsx` (earliest-in/latest-out across today's dwells, grace-debounced). **No Phase 10
  work.** *(Original note, kept for history:* the on-ice GPS watcher knows when a device entered/left a
  water body footprint; that interval is a strong prior for the report form's skate window. Needs enter/leave
  bookkeeping (debounced against brief GPS excursions) + a form pre-fill, and overlaps the D24
  activity-detection path — so it lands with the report-form / activity work, not the hazard feature.)*
- **Deferred to this phase's Later/deferred (see the phase doc):** the **body-depth / shallow-water decay
  signal** ships v1 as a manual `shallow_early_thaw` `bodyFeature` (no depth data source exists in
  OSM); the real fix is a **HydroLAKES + GLOBathy** backfill of `meanDepthM`/`maxDepthM`, a separate data
  PR. Full write-up (sources, state bathymetry, ETL update) in `phases/10-weather.md` → Later/deferred.
  **→ scoped as [A06a](./A06a-body-depth.md) (2026-07-29).** Correction worth carrying: *"the decay
  model reads a simple `isShallow` scalar"* was never true — the v1-without-the-data half of this bullet
  **did not ship**. The `bodyFeature` renders and is wired to nothing, so A06a builds the signal rather
  than sharpening it, and the manual flag turns out to be permanent (73% of the corpus is below every
  global source's area floor).
- **Done:** aging reports **and hazards** show a plain-text, Open-Meteo-attributed weather-since strip
  (peak/overnight-low temp · nights below freezing · sun · rain-vs-snow · wind); hazard decay reflects
  what the weather actually did (never hiding a hazard); report conditions auto-fill from Open-Meteo;
  corroboration distinguishes a weather-explained change from a real contradiction and escalates a
  repeated bad-actor pattern to the D57 posting-permission lever (never subtracting trust); and bounty
  freshness is weather-aware.

