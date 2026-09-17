# Next-gen — Weather stations: learning how a bay's weather really differs from its lake's

> **Scoped 2026-09-16 (A09 kickoff), post-alpha, unbuilt.** Second doc in the backlog series.
> Grew out of a founder question at the A09 kickoff and is kept out of the A09 doc on purpose — it is
> a research program, not a gap to close.
>
> **Depends on:** A09 Workstream 7 (every bay's weather archived every day of the season — the
> model-side record this study reads). **Feeds:** [`weather-shelter-index.md`](./weather-shelter-index.md)
> (its validation data). **Blocks nothing.**

---

## The founder's question, and the honest answer

> *"Can we get more accurate weather from Open-Meteo in a bay vs the whole lake? … If we find a good
> way to store the entire live season's official weather history from Open-Meteo as we go, we could
> do some post-season analysis that could give us indication of how each bay's wind/weather data
> differs from the parent lake, and use the difference trend to make better predictions in future
> seasons based on the parent's historical data?"* — 2026-09-16

Three parts, three different answers.

**1. Is a bay's Open-Meteo weather finer than its lake's? Forecast yes, marginally; history mostly
no.** Since A06h (D152) every bay is already sampled at its **own** point — Champlain's ten bays sit
in ten distinct 5.6 × 4 km browse cells, none of which is the lake's. Open-Meteo's US forecast is
HRRR at ~3 km, so two bays 5+ km apart can genuinely get different forecasts, and the app already
shows them. The **archive** behind past-weather is ERA5 (25 km) / ERA5-Land (10 km); the forecast
endpoint's `past_days` window (≤ 92 days) is HRRR-resolution and is what the season record is built
from inside the season. So within a season the record is ~3 km; across seasons it is coarser.

**2. Is the history being kept? Yes — retention was never the gap, coverage was.** `weatherDays` is
an archive, never pruned (D153), with daily wind fields (`maxWindKph`, `windRunKm`,
`windSectorHours`, `freezingHoursMeanWindKph`…), and `weatherHours` holds the hourly series for
browse cells. The gap was that **browse-tier rows are fetched lazily** — only for bays someone
opened. A09's Workstream 7 closes it: one Tier A fetch per live bay per day, all season, ~128
calls/day.

**3. Can model-at-bay minus model-at-lake teach us a per-bay correction? No — and this is the part
worth writing down so it is not re-researched.** Comparing the model's answer at the bay to its
answer at mid-lake can only reveal what the model *resolves*: elevation bands, broad lake-effect,
the gradient across a 3 km grid. It cannot see the 25 m pines or the ridge, because nothing in the
model does. A "difference trend" learned this way would be a trend in the model's own interpolation
— stable, reproducible, and about the wrong thing. **Learning a real per-bay correction requires an
observation the model did not produce.** That is what this doc scopes.

---

## The observation sources — all free, none currently read

| source | what it is | where near us | access |
| --- | --- | --- | --- |
| **NWS / ASOS + AWOS** | the official airport stations; hourly wind speed/dir, temp, precip | BTV (Burlington, on Champlain's shore), MPV, RUT, LEB, CON, ASH, PSM, PWM, AUG, BGR, GFL, SLK, MSS, ALB… ~40 in five states | `api.weather.gov/stations/{id}/observations` — free, no key, the same API A06c's NWS alerts already read |
| **Synoptic / MesoWest** | the aggregator: NWS + state DOT RWIS road stations + many mesonets; the densest public network there is | hundreds in five states, incl. road-weather stations on causeways and lakeshore highways | Synoptic Data API — free tier for research/non-commercial, key required, rate-limited |
| **Tempest (WeatherFlow)** and **Weather Underground PWS** | personal weather stations, often literally on a dock | dozens on the big lakes; coverage is where people live, which is where they skate | Tempest: public station API, no key for public stations; WU: key, generous free tier |
| **CoCoRaHS** | citizen daily precip/snow depth | dense in VT/NH/ME | daily CSV export |
| **Lake buoys** | UVM's Lake Champlain buoys, NDBC | summer-only; pulled each fall | irrelevant for ice, recorded so nobody looks twice |
| **Our own reports** | `reports.conditions.windSpeedKph` / `windDir` when a skater **typed** them (`source: 'user'`, not the Open-Meteo autofill) | wherever people skate — the only observation *on the ice* | already in Convex |

The first two rows are the study; the third is the bay-scale signal; the last is the ground truth
nobody else has.

---

## The study — a station-bias model, run post-season

1. **Register stations** near bodies we care about: every ASOS/AWOS in region, every Synoptic
   station within ~10 km of a body with ≥ N reports or a sub-area, every public Tempest within ~2 km
   of a shoreline. One row per station with its coordinate, network, elevation, and the body/bay it
   is nearest.
2. **Ingest observations through the season**, hourly, into a `weatherObservations` table keyed
   `(stationId, hourMs)`. A separate table from `weatherHours` because these are *measurements* and
   those are *model output*, and the two must never be summed. Same never-pruned posture as
   `weatherDays` (D153).
3. **After the season**, for each station: the model's value at the station's browse cell for the
   same hour (already archived) minus the observation, **by wind sector and by hour-of-day**. That
   is a per-station bias surface — the one measured quantity that says how wrong the 3 km cell is at
   that spot, and in which directions.
4. **Attribute the bias.** Regress the per-sector bias against the station's own terrain and canopy
   exposure (the shelter index, computed at the station exactly as at a fetch origin). If shelter
   explains the bias, the index's two curves get fitted rather than assumed — the validation the
   shelter doc asks for. If it does not, that is worth knowing before the index ships.
5. **Only then** a per-bay correction: a bay inherits the fitted bias of the nearest station with
   a similar exposure profile, labeled as an estimate with the station named. Never a silent
   adjustment of the number the skater sees; a second line, *"the BTV station typically reads 20%
   lower from the NW than the model here."*

**Nothing in steps 1–4 touches a skater-facing surface.** It is an analysis notebook over two
tables, and the deliverable of the first winter is a doc with the fitted numbers in it.

---

## What A09 already does for this

- Workstream 7: every bay's Tier A day + hours archived daily, all season, so step 3 has its
  model side for every bay and not just the opened ones.
- `reports.conditions.source` already distinguishes typed from autofilled, so the on-ice ground
  truth is filterable today.

## Not decided

- Synoptic's free tier terms for an AGPL app that is not a university — read before registering.
- Whether the station registry is a table or a checked-in JSON (it changes yearly; a table with an
  import run is the repo's usual answer).
- How many winters before a per-bay correction is honest. One is a start; the doc's own rule is
  that a number needs a sample size beside it.

## Related

[`phases/A09-subareas-as-places.md`](../phases/A09-subareas-as-places.md) (Workstream 7) ·
[`weather-shelter-index.md`](./weather-shelter-index.md) ·
[`phases/A06h-weather-detail.md`](../phases/A06h-weather-detail.md) (D152, D153, D161) ·
[`phases/A06c-expanded-body-profiles.md`](../phases/A06c-expanded-body-profiles.md) (the NWS client)
