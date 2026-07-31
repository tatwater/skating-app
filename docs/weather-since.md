# Weather-since: the shared "what has the weather done" layer

Phase 10 added one small reducer that a surprising amount of the app leans on. This doc
explains it once, so the docs that consume it — [hazard decay](./hazard-decay-and-lifecycle.md),
[report lifecycle](./report-lifecycle.md), [bounty decay](./bounty-decay-and-lifecycle.md),
and the [reputation](./user-reputation.md) contradiction signal — can just say "see
weather-since" instead of re-deriving the physics.

> **Who this is for.** Anyone touching weather-driven behavior, or an admin about to
> retune a degree-hour threshold and wondering what it feeds. The magic numbers here are
> *literature/anecdote defaults* — the **signs are locked, the magnitudes are not** (calibrate
> once real data exists). Nothing in this layer ever asserts the ice is safe (**D3**); it
> only describes what the weather *did*.

---

## The mental model (read this first)

There is **one reducer, `summarizeWeatherSince`** (`packages/core/src/weather.ts`), and it has
**two consumers that share a single fetch**:

1. **The descriptive strip** — a plain-text line a human reads ("peak 41°F · low 22°F · 3
   nights below freezing · 6h sun · 0.5″ rain"). Uses only the *human subset* of the summary.
2. **The decay model** — [hazard weather-decay](./hazard-decay-and-lifecycle.md) reads the
   *model-internal integrals* (`freezingDegreeHours`, `thawDegreeHours`, freeze-runs, cycles)
   and turns them into a confidence multiplier. A human never sees these numbers.

The input is **Open-Meteo hourly data**, passed through in Open-Meteo's native units so the
fetch layer doesn't have to convert: temperature °C, rain **mm**, snowfall **cm**, snow depth
m, wind kph, shortwave radiation W/m². (Conversion to the imperial the UI shows happens later,
in the strip formatter.)

The window is always `[start → now]`, but *what* `start` is depends on the consumer — since the
skate for a report, or `max(lastConfirmedAt, now − 7d)` for a hazard. That difference is the
only per-consumer knob; the reducer itself is window-agnostic.

---

## What the reducer produces

`summarizeWeatherSince(hourly, options)` → a `WeatherSinceSummary`. Two halves:

### Descriptive (the strip shows these)

| Field | Meaning |
|---|---|
| `peakTempC` / `minTempC` | Window high / low. `null` with no data. The low answers "did it freeze?" |
| `hoursNearFreezing` | Hours within the freezing band (default **−2 … +2 °C**) — the volatile zone. |
| `hoursAboveFreezing` | Hours `> 0 °C`. |
| `nightsBelowFreezing` | Distinct local **nights** whose low dropped below 0 °C — the bimodal "did it refreeze each night?" driver for open water / thin ice. `null` if any hour lacks a timestamp (we won't half-count nights). |
| `hoursOfSun` | From `sunshine_duration` when present, else an hour counts as sun when cloud cover ≤ **20 %**. |
| `totalPrecipMm` / `rainMm` / `snowfallCm` | Lumped precip, plus the rain/snow **split** (they have opposite decay meanings — rain warms/erodes, snow insulates/hides). |
| `maxSnowDepthM` | Peak snow depth. |
| `maxWindKph` / `maxWindGustKph` / `windRunKm` | Sustained max, gust peak, and wind-run (Σ hourly speed × 1 h). |

### Model-internal integrals (only the decay model reads these)

| Field | Definition | Why it exists |
|---|---|---|
| `freezingDegreeHours` (FDH) | Σ over freezing hours of `(0 − tempC)` | The ice-**growth** backbone: ~1″ of ice per **15 freezing-degree-days** (Ashton 1989). A magnitude, not a count. |
| `thawDegreeHours` (TDH) | Σ over thawing hours of `(tempC − 0)` | The ice-**loss** counterpart. Thaw runs **~30 % faster** than growth, which is why the thaw scale is smaller than the freeze scale downstream. |
| `insolationWhM2` | Σ hourly shortwave radiation (≈ Wh/m²) | Accumulated sun. Subsumes the "late-season sun weakens ice even when cold" season/solar term. |
| `longestFreezeRunHours` | Longest consecutive below-0 run | A *sustained* freeze — the gate for whether rotten ice could plausibly re-skin. |
| `freezeThawCycles` | Count of below-0→above-0 onsets | Drives candling / shell-ice formation. |

**A subtlety worth knowing: the "night" is noon-shifted.** `nightsBelowFreezing` buckets each
hour into a night that runs noon→noon (`nightIndex` subtracts 12 h before the day division), so
a single cold night — evening through the pre-dawn minimum — lands in *one* bucket instead of
splitting at midnight and counting as two. This only works when every hour carries a local
`startMs`; if any is missing, the field is `null` rather than a lie.

---

## `weatherExplainsIceChange` — the shared honesty gate

The one piece of *judgment* in this layer, used to keep the app from punishing honesty:

```
weatherExplainsIceChange(summary, { freezingDegreeHours = 48, thawDegreeHours = 36 })
  → summary.freezingDegreeHours >= 48  ||  summary.thawDegreeHours >= 36
```

It answers: **did enough freeze or thaw happen in this window to plausibly change the ice?**
Two consumers ask it, with *deliberately different* thresholds:

- The [contradiction signal](./user-reputation.md#the-contradiction-signal-d56-7) uses the
  **defaults (48 FDH / 36 TDH ≈ two degree-days)**. Its question is lenient: "could weather
  explain two reports disagreeing?" — one cold night is a plausible explanation, so an honest
  "the ice changed" report is never counted as a contradiction.
- The [bounty reopen gate](./bounty-decay-and-lifecycle.md#weather-can-reopen-a-bounty-early)
  passes **much higher thresholds (180 FDH / 120 TDH)**. Its question is stricter: "should a
  big change reopen a well-corroborated report's bounty *early*?" — one ordinary sub-freezing
  night must **not**, or the trust weighting would collapse for most of the season.

**Fail-open is the rule everywhere.** An empty summary (`hours === 0`, e.g. a failed fetch)
returns `false` / a neutral multiplier — "can't tell" never fabricates a change and never
penalizes anyone.

---

## The strip: display gates + copy

`packages/core/src/weatherStrip.ts` turns the descriptive half into the line the UI shows.
**Verdict-free, plain text, imperial** (founder call, 2026-07-22): it states what the weather
*did* — no "safe/unsafe," no arrows, no color-coded verdict. The degree-hour integrals stay
model-internal and never appear.

`formatWeatherSinceStrip(summary)` → e.g.
`peak 41°F · low 22°F · 3 nights below freezing · 6h sun · 0.5″ rain · gusts to 30 mph`, or
`null` when there's nothing worth saying. Small mention-floors keep rounding noise out:

| Constant | Value | Effect |
|---|---|---|
| `PRECIP_MENTION_MM` / `PRECIP_MENTION_CM` | 0.2 | Below this, precip isn't mentioned. |
| `GUST_MENTION_MPH` | 15 | Wind/gusts only called out once brisk enough to matter to a skater. |

### Two windows, two rules

Both surfaces feed off the same reducer; they differ only in what window they ask for.

- **Report strip** (`reportStripState`) — window = **since the skate**. See
  [report lifecycle](./report-lifecycle.md#age-framing-2--the-weather-since-strip): hidden when the report is
  `< 6 h` old (nothing has happened yet), a strip in between, and collapsed to a plain age line
  past `~14 d` (stale on its own terms).
- **Hazard strip** (`hazardStripWindowStartMs`) — window = `max(lastConfirmedAt, now − 7 d)`.
  "Since first reported" is meaningless for a season-long ridge, so it's a rolling recent
  window. `HAZARD_WEATHER_LOOKBACK_DAYS = 7` is **single-sourced here** and imported by the
  decay cron, so the strip a human reads and the decay the model applies can never look back
  over different weather.

---

## Constants at a glance

All defaults, all admin-tunable in Phase 7 (D49):

| Constant | Value | File | Controls |
|---|---|---|---|
| freezing band | −2 … +2 °C | `weather.ts` | the "near freezing" volatile band |
| sunny cloud max | 20 % | `weather.ts` | cloud-cover fallback for a "sun" hour |
| `weatherExplainsIceChange` FDH/TDH | 48 / 36 | `weather.ts` | default "did the ice change?" thresholds |
| `HAZARD_WEATHER_LOOKBACK_DAYS` | 7 days | `weatherStrip.ts` | hazard strip + decay-cron window |
| report strip min / max age | 6 h / 14 d | `weatherStrip.ts` | when a report shows a strip vs. an age line |
| `PRECIP_MENTION_*` | 0.2 mm / cm | `weatherStrip.ts` | precip mention floor |
| `GUST_MENTION_MPH` | 15 | `weatherStrip.ts` | wind mention floor |

---

## What this layer never does

- **It never asserts safety.** Every output is descriptive (D3). "3 nights below freezing"
  is a fact about air temperature, not a claim about ice.
- **It never fabricates on missing data.** No timestamps → `nightsBelowFreezing: null`. No
  fetch → empty summary → fail-open at every consumer.
- **It doesn't decide anything by itself.** The reducer produces numbers; the *judgment*
  (multiplier, contradiction, reopen) lives in the consumer docs linked above.

## One provider, and a second one that never touches this layer (D74)

Every number on this page comes from **Open-Meteo**, and that is a decision rather than a default.
N6c adds **NWS (`api.weather.gov`)** for official winter-storm, ice-storm and wind-chill **alerts** — and
those alerts are deliberately walled off from everything described above.

**They are never blended.** Two providers disagreeing produces a worse number, not a better one, and
averaging them would quietly break the property this whole layer depends on: that any window can be
re-fetched and re-derived to the same result. A decay multiplier you cannot reproduce is one you cannot
debug, and cannot refit when the corpus finally justifies refitting it.

So the boundary is sharp, and worth stating in the same breath as the reducer: **Open-Meteo computes;
NWS informs.** An NWS alert renders as a labelled, attributed strip beside this one. It never enters
`weatherDecaySignal`, never moves a multiplier, and never gates the honesty check.
