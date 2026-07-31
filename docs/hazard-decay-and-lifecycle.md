# Hazard decay & lifecycle

How a reported ice hazard ages, fades, gets confirmed or cleared, and how big it's drawn on
the map. This is the human-readable companion to the calibration research in
[`plans/research/hazard-decay-calibration-and-behavior.md`](../plans/research/hazard-decay-calibration-and-behavior.md) (Phase 9) and the
weather layering in [`plans/phase-10-weather.md`](../plans/phase-10-weather.md) (Phase 10).

> **Who this is for.** Anyone tuning hazard behavior, or trying to understand why a two-week-old
> pressure-ridge pin is still on the map while a day-old open-water pin has already faded. The
> numbers are **admin-tunable defaults** (Phase 7 / D49), calibrated from literature + a
> 1,197-post regional corpus — *signs locked, magnitudes not.*

---

## The one invariant everything else serves

**Decay is confidence, not safety (D3).** A hazard fading from `fresh` to `stale` means
"nobody has re-checked this recently," **never** "this is probably gone." This single rule
explains every design choice below — the opacity floor, the never-hide bound, the asymmetric
removal threshold, the "no numeric severity."

Three things follow immediately, and they're worth stating because each is the *opposite* of
what a naïve system would do:

- A stale hazard **fades but never disappears** and never drops below a legible floor.
- Weather can **age** a pin but can **never hide** one — only real elapsed time (plus a human
  "it's gone" verdict) retires a hazard.
- There is **no severity number and no confidence score**. "Confidence" *is* the freshness
  tier plus the confirmation vote counts. Severity is conveyed by hazard *type* + freshness +
  copy. If you go looking for a `severityLevel` or `confidence: 0.7`, it doesn't exist — on
  purpose.

---

## The mental model: two layers of decay

A hazard's freshness is computed at **read time** (never stored) from two layers:

```
   base per-type clock            weather multiplier            never-hide bound
  (how long this TYPE stays  ×  (what the weather has DONE  →   (weather can't push a pin
   trustworthy, D52)             since last confirmed, D56)      past `aging` into hidden)
```

Concretely: `effectiveAge = elapsed × multiplier`, then the same fresh/aging/stale thresholds
run on `effectiveAge` instead of raw `elapsed`. Layer 1 is Phase 9 and weather-free; Layer 2 is
Phase 10 and sits entirely on top. If weather data is missing, the multiplier is `1` and you're
back to pure base decay (fail-open).

---

## Layer 1 — base per-type decay (Phase 9, D52)

Every hazard type has its own clock, in **hours**, with two thresholds that split the timeline
into three buckets (`packages/core/src/hazardDecay.ts`):

```
fresh:  elapsed < freshH
aging:  freshH ≤ elapsed < agingH
stale:  elapsed ≥ agingH          (hidden behind "show older", never removed)
```

Types are grouped into tiers by *how fast the world changes them* — not by how dangerous they
are (danger is type + copy):

| Tier | Behavior | fresh / aging / stale | Types |
|---|---|---|---|
| **A** | Volatile — refreeze or re-open within a day | <24 h / 24–72 h / >72 h | open_water, thin_ice, overflow_slush, drain_hole, wind_hole, slush_hole |
| **A\*** | Very volatile — same-day info only | <12 h / 12–36 h / >36 h | thawed_rotten, ridge_crossing |
| **B** | Semi-persistent — re-skins but the weak spot lingers days | <3 d / 3–7 d / >7 d | wet_crack, drilled_hole, shell_area |
| **C** | Structural — don't heal in a season, often grow | <7 d / 7–21 d / >21 d | pressure_ridge, ice_heave |
| **D** | Effectively permanent — [body-feature](../plans/phase-9-hazards.md) candidates | <14 d / 14–45 d / >45 d | spring_current, gas_hole, reef_hole |

Two nuances baked into the tiers:

- **`thawed_rotten` sits at A\*, not A**, even though it's the #1 fatality cause — because a
  thawed sheet is *same-day* information. Its short clock plus the never-hide bound (below) keep
  it visible; it should never look reassuring.
- **`ridge_crossing` is a "passage" marker, not a danger.** It reuses the hazard *machinery*
  (geometry, decay tiers, the confirm loop) but marks *where you can get across* a ridge. It's
  A\* because a crossable spot at dawn can be a mess by mid-morning. It's the one type that
  never triggers an [on-ice alert](./on-ice-alerts.md) — and, since N5a/D64, the one type whose
  **lifecycle is inverted at every point**. See
  [Passage markers decay the other way](#passage-markers-decay-the-other-way-n5ad64) below; the
  short version is that everything on this page about absence of evidence keeping a pin alive is
  reversed for this one type, deliberately.

Tuning is deliberately human-legible: the table is integer hours, converted to milliseconds
only at compare time (`hoursToMs`), so an admin edits `72`, not `259200000`.

---

## Layer 2 — weather-driven decay (Phase 10, D56)

Base decay assumes "average" weather. Layer 2 modulates how fast confidence erodes based on
what the weather has *actually done* since the hazard was last confirmed, read from the shared
[weather-since integrals](./weather-since.md#model-internal-integrals-only-the-decay-model-reads-these)
(`packages/core/src/hazardWeatherDecay.ts`). The output is a single **multiplier**:

- `multiplier > 1` → **lose confidence faster** (fade toward aging/stale sooner — "conditions
  changed a lot, go re-check").
- `multiplier < 1` → **stay confident longer** (persist — "weather preserved this").
- `multiplier = 1` → no weather effect / missing data (fail-open).

Hazard types map to a **weather-response class** (a separate axis from the A–D tiers):

| Response class | Cold does… | Thaw does… | Types |
|---|---|---|---|
| `refreeze_healed` | fade faster (cold likely refroze it) | persist (thaw keeps it open) | open_water, thin_ice, overflow_slush, drain_hole, wind_hole, slush_hole, wet_crack, drilled_hole, shell_area |
| `structural` | just persist (floored at ×1, never a discount) | **escalate** (a ridge can melt to open water in a warm spell → fade to prompt recheck) | pressure_ridge, ice_heave, ridge_crossing |
| `rotten` | age *mildly*, needs a lot of cold | worsen the rot → **persist the warning** | thawed_rotten |
| `weather_insensitive` | ≈×1 regardless | ≈×1 regardless | spring_current, gas_hole, reef_hole |

### The three sign-flips (locked in D52 §5)

These are the counter-intuitive rules a "colder → safer" model gets dangerously wrong. They're
locked; only the magnitudes are tunable:

1. **Cold must NOT heal `thawed_rotten`.** A thawed sheet grows a deceptive hard skin overnight
   and collapses midday (implicated in the 2013 fatalities). Its cold term can never pull the
   multiplier below 1 — only a human clears it.
2. **Thaw *escalates* ridges.** `structural` types get a thaw multiplier ≥ 1: a warm spell makes
   the old pin *less* reliable, so it fades to prompt a recheck — the opposite of "structural =
   weather-insensitive."
3. **Snow lowers confidence but never accelerates decay.** Snowfall only *dampens* cold's
   acceleration (snow insulates → refreeze less certain) and sets a `snowHidden` flag
   ("possibly snow-hidden"). It can never push the multiplier above 1.

### The never-hide bound

The safety-critical clamp: **weather-acceleration may age a pin (fresh → aging) but can never
push it past `aging` into hidden/`stale`.** Only real elapsed time (plus a human `fully_healed`)
retires a pin. Weather-*deceleration* (persisting a pin fresher) is always allowed — it only
makes a hazard *more* visible, never less. Enforced in `freshnessWithMultiplier`.

### Weather-decay constants

Response strengths (`K`), scales, and clamps — all defaults in `hazardWeatherDecay.ts`:

| Constant | Value | Controls |
|---|---|---|
| `fdhScaleHours` | 120 | freezing-degree-hours for a "full" cold signal (~5 freezing-degree-days) |
| `tdhScaleHours` | 90 | thaw-degree-hours for a "full" thaw signal (smaller — thaw ~30 % faster) |
| `refreezeColdK` / `refreezeThawK` | 1.0 / 0.5 | cold-acceleration / thaw-persistence for volatile types |
| `structuralThawK` | 0.75 | thaw-escalation for ridges |
| `rottenColdK` / `rottenColdScaleMult` / `rottenThawK` | 0.25 / 3 / 0.5 | rotten's mild cold aging (needs 3× the cold), thaw-persistence |
| `snowDampFullCm` / `snowDampMin` | 10 / 0.3 | snow that fully damps cold's signal; floor on that damping |
| `snowHideCm` | 1 | snowfall at/above which a hazard flags "possibly snow-hidden" |
| `multiplierFloor` / `multiplierCap` | 0.5 / 2.0 | clamp on the multiplier for volatile/structural types |
| `rottenMultiplierCap` | 1.5 | milder cap for rotten — only extended cold ages it |

### How it's applied (the cron)

The multiplier is **precomputed** by a background job and stored on the hazard row, so the live
query stays cheap and time-independent (`packages/convex/convex/hazardWeather.ts`):

- The `refresh hazard weather` cron ticks **hourly**, but each hazard is re-fetched at most
  every **3 h** (`WEATHER_REFRESH_MIN_INTERVAL_HOURS`) → an effective ~3 h cadence you can
  retune without a redeploy.
- It sweeps only bodies with ≥1 active hazard, sampling weather at the **body centroid** (with a
  `weatherSamplePoints[]` escape hatch for giant multi-cell lakes), over the shared **7-day**
  lookback.
- It stores a **multiplier (a number), never a frozen freshness bucket** — the online read path
  recomputes the live bucket from the always-current `elapsed`, so a pin keeps aging between
  cron runs.
- Fail-open: a failed fetch keeps the last-good multiplier and doesn't stamp `weatherAdjustedAt`,
  so it retries next tick.
- A **confirmation that resets the decay clock invalidates the stored multiplier.** It was computed
  over the *old* "since last confirmed" window, so applying it to the new epoch would show the
  wrong bucket until the next cron run. So `confirm` clears `decayMultiplier` / `snowHidden` /
  `weatherAdjustedAt` whenever it advances `lastConfirmedAt` — the read path falls back to plain
  base decay (a just-confirmed pin reads `fresh` regardless, never *less* visible), and dropping
  `weatherAdjustedAt` lets the cron recompute against the new window on its very next tick.

---

## Lifecycle — confirmation & removal (D52)

Freshness is the passive clock; **confirmations** are how the community actively moves a hazard.
The vote is **three-tier**, because "gone" is not one thing (a refrozen lead *is* thin ice; a
healed ridge *is* a line of refrozen blocks you can still catch an edge on):

| Verdict | Effect |
|---|---|
| `still_there` | resets the decay clock, counts toward confirmation |
| `healing_unsafe` | **keeps** the pin (now annotated), counts toward *nothing* — "it changed and it's still dangerous" |
| `fully_healed` | moves a hazard toward removal |
| `never_existed` *(N5a/D65)* | pools with `fully_healed` toward the same archive, **and files a moderation flag** |

**`never_existed` is not a fourth degree of gone.** The three above are claims about the *ice*;
this one is a claim about the *report* — a mis-tapped location, a shadow read as a lead, or a
troll. Without it the only way to clear a bogus pin was to record that it "healed", which writes
a false entry into the ice record and, once N5a's cross-season recurrence work reads it, becomes
evidence that a hazard formed somewhere it never did.

Two consequences fall out, and they point in different directions:

- **It pools toward the archive**, rather than needing two of its own kind. The two verdicts
  disagree about history and agree about the present, and the map shows the present — requiring
  two of a kind would leave a genuinely-clear hazard standing because its witnesses explained it
  differently.
- **It files a flag that `fully_healed` doesn't** (`unsafe_false_report`, never hiding anything by
  itself). "There was never anything here" is a claim about a person's report, and two of them is
  a pattern a moderator should see rather than an archive that happens quietly. The flag counts
  `never_existed` **alone**: two people who disagree about whether a hazard ever existed are not
  that pattern. It's also state-shaped, not an occurrence — the same two people changing their
  minds back and forth must not inflate the count a moderator reads.

Two thresholds gate the transitions (`packages/core/src/hazardLifecycle.ts`):

- `DEFAULT_CONFIRM_THRESHOLD = 1` — independent `still_there` votes to promote a hazard from
  **provisional** to **confirmed**.
- `DEFAULT_REMOVAL_THRESHOLD = 2` — independent `fully_healed` votes to **archive** it.

**The asymmetry is the safety margin.** Being wrong about "present" costs a detour; being wrong
about "gone" can kill someone — so it takes *more* evidence to remove than to confirm.

Three rules keep votes honest:

- **One skater = one current opinion.** Counts are *derived* from the whole vote set (each
  user's latest vote, author excluded), not incremented per row — so one person can't vote
  `fully_healed` twice and clear a hazard alone. This also makes offline-queue replays
  idempotent.
- **The author's own votes** refresh the decay clock (they were genuinely there and looked) but
  count toward neither threshold — vouching for yourself isn't independent evidence.
- **Removal archives, never deletes**, and archival is a ratchet: once cleared, one person
  changing their mind can't silently resurrect it — that path is a fresh re-report.

Provisional vs. confirmed also drives [on-ice alerting](./on-ice-alerts.md): a provisional
hazard can't shout a warning, only ask "can you see it?" — and that ask *is* how it collects the
confirmation it needs.

### Who confirmed it (N5a/D65)

A confirmation from someone whose history you can look at carries weight a bare count doesn't —
that's the whole argument behind [boost-only trust](./user-reputation.md). But a confirmation is
a **sharper disclosure than a report**: it says a named person stood at a *point* at a *time*,
where a report is lake-level.

So the name follows the consent the skater already gave. A `public` profile is **named**; a
private one is **counted and not named**, so the count is always the honest number even when the
list is shorter than it. Minors are forced private (D41), so they are never named by
construction. A blocked author's name isn't specially suppressed: blocks hide profiles and
comments, never safety content (D3).

The hazard's **author** is excluded from the named list even when they voted `still_there` —
their vote refreshes the clock but counts toward no threshold, so naming them would print more
names than the count they sit under, and print the reporter as their own corroborator.

### Passage markers decay the other way (N5a/D64)

Everything above assumes **absence of evidence keeps a pin alive**: a hazard fades to a visible
floor and never disappears, because assuming a danger is still there is the recoverable mistake.

For a `ridge_crossing` that same rule points the wrong way. A passage marker says *you can go
this way*. One placed in November still reading "reported crossable" in March, with nobody having
looked since, walks a skater onto ice no one has checked. Getting a crossing wrong in the
*remove* direction costs a longer walk; getting it wrong in the *keep* direction can cost a life.
The bias has to fall toward the recoverable one — which is the opposite bias from every other pin
in the app.

So the lifecycle inverts at every point:

| | Hazard | Suggested crossing |
|---|---|---|
| Absence of evidence | **keeps it alive** | **kills it** |
| Positive votes | optional; refresh the clock | **required to survive**, and more of them |
| One negative vote | counts quietly toward the 2-vote archive | **shows as `disputed`**; two still needed to close |
| Past its window | fades to a visible floor, never disappears | **expires — stops rendering** |

Three constants and one state carry it:

- **`PASSAGE_EXPIRY_H = 72`** — its own window, deliberately *not* the A\* `agingH: 36`. Reusing
  the freshness tier would make "faded" and "gone" the same instant, so a crossing marked on
  Saturday morning would vanish by Monday evening whether or not anyone had been near the lake.
  Longer than `agingH` so the marker fades first and expires later.
- **`PASSAGE_CONFIRM_THRESHOLD = 2`** — double every hazard's one, which is literally what "more
  corroboration" means for the pin that says you can go this way.
- **`isPassageExpired`** is **the one place in the app where a pin leaves the map on time alone**,
  and it's dropped server-side in `hazards.listForBody` rather than in a client, so the map, the
  list and the on-ice proximity evaluator — which all read that one query — cannot disagree about
  it. An expired marker still resolves by permalink, saying it aged out rather than 404-ing; the
  confirm buttons stay offered under that note, because a skater who just got across is exactly
  the evidence that revives it.
- **`disputed`** is a third healing state, derived from `goneCount >= 1 && goneCount <
  removalThreshold`. Before it, one skater saying "you can't cross here" changed nothing on
  screen for the next. **Passage markers only**: on a hazard the same disclosure would invite
  skaters to discount a live warning, which is the unsafe direction. It outranks `healing_unsafe`
  when both apply — "the ridge is closed here" is the stronger claim.

The copy follows: **"suggested crossing", never "safe crossing"**, and every surface repeats that
judging the crossing in the moment is the skater's call, not ours.

### Seasons hide, they never remove (N5a/D63)

A hazard now also leaves the default view at the **season boundary** (July 1). That is a third
axis, and it must not be confused with either of the two above:

- **"Show older"** answers *has anyone verified this lately?* — within one season.
- **The season selector** answers *what did this lake look like last winter?*
- **Archival** is the community deciding it's gone.

A hazard's season is its **`firstReportedAt`**, deliberately the *opposite* field from the
`lastConfirmedAt` everything else on this page reads. Freshness and the redaction sweep ask "is
anyone still maintaining this?", a clock other people move; a season asks "when was this first
seen?", which has to be a clock **nobody can move** — otherwise one skater confirming a March
ridge in November carries it across the boundary with no operator in the loop.

**The safety cover for that reset is promotion, not the reset being harmless.** Hiding last
winter's hazards means the first skater in November sees a clean map where there was a ridge, so
`hazards.listPromotionCandidates` ranks last season's by likelihood of recurrence for a
pre-first-ice operator pass, and anything that forms every winter becomes a persistent
[body feature](../plans/phase-9-hazards.md) that no reset touches. The ranking is a queue for a
human decision, never a prediction that a hazard will recur (D3).

---

## How a hazard is drawn

### Fill opacity by freshness (`packages/core/src/hazardLayer.ts`)

The visual half of "decay is confidence, not safety." The floor is deliberately high enough to
stay legible on a bright screen outdoors:

| Freshness | Fill opacity |
|---|---|
| fresh | 0.45 |
| aging | 0.30 |
| stale | 0.18 (fades, **never** to zero) |

Provisional (unconfirmed) hazards render softer still: `PROVISIONAL_OPACITY_SCALE = 0.6`
multiplied onto the freshness opacity — and "provisional" means *two* unmet confirmations on a
passage marker against one on a hazard (D64). Passage markers, disputed crossings and healing
pins each get distinct colors so a `ridge_crossing` never reads as a danger halo.

The floor above is the *hazard* rule. A passage marker past `PASSAGE_EXPIRY_H` doesn't reach the
floor — it stops rendering entirely (D64), the one exception on this page.

### Geometry defaults (`packages/core/src/hazardGeometry.ts`)

Each type starts at a sensible size so on-ice authoring is one-tap, with the danger direction of
error baked in (**under-drawing a hazard is the dangerous mistake**):

- **`HAZARD_DEFAULT_RADIUS_M`** (point + radius): 5 m (drilled_hole) → 60 m (**thawed_rotten**,
  the largest on purpose — it's a condition of the sheet and the #1 fatality cause). Open water
  40 m, thin_ice 50 m, springs 30 m, small holes 10–15 m.
- **`HAZARD_DEFAULT_BUFFER_M`** (linear half-width): wet_crack 4 m (a hairline crack is mostly
  positional uncertainty) → pressure_ridge 15 m (loose plates several metres each side plus a
  deep central puddle). Drawing both as the same zero-width line would be a lie in opposite
  directions.
- **Authoring ladders** the UI snaps to: `HAZARD_RADIUS_STEPS_M = [5, 10, 25, 50, 100, 200, 400]`
  and `HAZARD_BUFFER_STEPS_M = [2, 4, 8, 15, 25, 40, 60]`.
- **Bounds:** `HAZARD_MAX_SIZE_M = 5000`, `HAZARD_MAX_VERTICES = 500`, `MIN_FOOTPRINT_M = 1`.

The footprint these produce is the *same* geometry the map draws, the
[proximity alert](./on-ice-alerts.md) measures against, and the directional projection walks
into — so "warned about" can never drift from "drawn."

---

## What's deliberately absent

Stated so nobody hunts for a constant that doesn't exist:

- **No numeric severity levels.** Severity = type + freshness tier + copy.
- **No numeric confidence score.** "Confidence" = freshness tier + confirm/removal vote counts.
- **No exponential / half-life decay math.** Every decay is a threshold step function (base
  tiers) times a bounded linear multiplier (weather). The "half-life" you might expect isn't
  there — the step-plus-multiplier model is intentional and keeps tuning legible.
- **No auto-hide from flags.** Moderation is a separate axis from lifecycle; a moderator hiding
  a troll pin must never read as the community clearing a real hazard (see
  [reputation](./user-reputation.md)).

## A near-neighbour that must NOT reuse this model (D73)

N6d adds **access alerts** — "the gate is locked", "the road isn't plowed" — and they borrow this page's
*machinery* (the confirm/deny loop, `pointEvents`, the "never existed" retraction) while deliberately
rejecting its *physics*.

**A locked gate does not thaw.** Layer 2 exists because weather acts on ice; nothing in a thaw acts on a
padlock. Applying `decayMultiplier` to an access alert would let a warm week silently expire a road
closure — and that failure is nearly invisible in review, because it looks exactly like an alert decaying
normally. So access alerts use a plain TTL extended by confirmation, with **no weather term at all**.

Recorded here rather than only in the N6d doc because the mistake is the kind you make by being helpful:
the two features look alike, the constants are right there, and reusing them reads as consistency.

## Where the type taxonomy comes from

The 16 canonical hazard type keys aren't invented vocabulary. They track the standard classification of
freshwater ice — **Michel, B. & Ramseier, R.O. (1971), *Classification of River and Lake Ice*, Canadian
Geotechnical Journal** — which is why the categories carve at joints skaters recognize even though no
skater wrote them. The wider reading list behind our decay and freeze-timing copy is in
[`plans/phase-N6c-expanded-lake-profiles.md`](../plans/phase-N6c-expanded-lake-profiles.md) → Appendix A.
