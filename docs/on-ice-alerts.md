# On-ice alerting

How the app warns a skater about a reported hazard *while they're on the ice* — the Phase 9.5
"on-ice mode" (D54). This is the most safety-sensitive surface in the app, so almost every
constant here is set the way it is for a safety reason. Full build notes:
[`plans/phase-9.5-on-ice-alerts.md`](../plans/phase-9.5-on-ice-alerts.md).

> **Who this is for.** Anyone touching the alerting geometry, the background location watcher, or
> the "which lake am I on?" resolution. The numbers are **admin-tunable defaults** (Phase 7 /
> D49), but the *directions* (generous buffers, fail-loud, silence-is-not-safety) are load-bearing.

---

## The one invariant: silence is never an all-clear

**No alert means "nothing *reported* nearby," never "the ice is fine" (D3).** That's a far
weaker statement than the absence of an alarm *feels* like, and it's weaker still in v1 where the
watcher only runs while the app is foregrounded (or in a foreground service). Every surface built
on this says so out loud. If you take one thing from this doc: the alerting is a bonus signal on
top of the skater's own judgment, not a safety system they can lean on.

Two consequences in the code:

- **Fail loud, not silent.** One malformed cached hazard row is *skipped*, never allowed to throw
  and silence the alerts for every *other* hazard on the lake.
- **The confirm gate is the confirmation mechanism.** An unconfirmed hazard can't shout a
  warning — it can only ask "can you see it?", and that ask *is* how the
  [lifecycle](./hazard-decay-and-lifecycle.md#lifecycle--confirmation--removal-d52) collects the
  confirmation it needs. A troll's fake pin never becomes a scary alarm for anyone but the people
  physically on that ice.

**Where the evaluation happens matters (D12).** The server never learns where anyone is. It syncs
hazard *data* to devices that care about a lake; each phone evaluates its *own* GPS against its
own cached hazards. Positions never leave the device, a troll's blast radius is naturally limited
to people on that same ice, and — because the hazards are already cached — **the alert fires with
no cell signal.**

---

## Two layers of alert

Both evaluate the skater's position against the *same* buffered hazard footprint the map draws
and the [decay model](./hazard-decay-and-lifecycle.md#how-a-hazard-is-drawn) uses, so "warned
about" can never drift from "drawn."

### Layer 1 — proximity (`packages/core/src/hazardProximity.ts`)

Answers **"what is near me right now"** — a radius around the skater's current point. Fires when
you pull the phone out of your pocket.

- **`DEFAULT_ALERT_BUFFER_M = 150`** — how close, in metres *beyond* the hazard's own footprint,
  triggers an alert. Generous on purpose: the footprint is already fuzzy, GPS on a cold phone is
  poor, and a skater with speed carries a long way.

### Layer 2 — directional projection (`packages/core/src/hazardProjection.ts`)

Answers **"what am I skating toward"** — it projects the skater's path forward from their **course
over ground** and speed and asks which hazards that path runs into in the next lead-time window.
Fires *while you skate*, as a background local notification, so you hear about the lead ahead
before you reach it.

| Constant | Value | Controls |
|---|---|---|
| `DEFAULT_LEAD_MIN_SEC` | 30 s | nearer than this is "you're basically on it" → Layer 1's job |
| `DEFAULT_LEAD_MAX_SEC` | 60 s | beyond a minute out, heading noise makes the projection a guess |
| `DEFAULT_MIN_SPEED_MPS` | 0.8 m/s (~2.9 km/h) | below walking pace, GPS course is junk → stay silent |
| `DEFAULT_SAMPLE_STEP_M` | 10 m | forward-path sampling granularity |
| `MAX_SAMPLES` | 2000 | backstop so a pathological lead time can't freeze the device |

**Course over ground, not a compass** (founder call, 2026-07-21). Nobody skates holding the phone
out; it's face-down in a pocket, tumbling, so a magnetometer heading is noise. GPS course is only
meaningful while actually moving — hence the speed floor and the "heading unknown → no alert"
rule. There's deliberately **no smoothing/EMA constant**: raw OS course + speed, or silence.

The projection *samples* the path forward in 10 m steps rather than doing analytic
segment-∩-polygon math — it keeps the module small and matches the footprint's honest fuzziness.
Its one limit (a footprint narrower than 10 m, dead ahead, can be stepped over) is backstopped by
Layer 1's radius, which still catches that hazard as the skater closes in.

### The confirm gate (shared by both layers)

Each alert is one of two kinds, decided by
[`isProvisional`](./hazard-decay-and-lifecycle.md#lifecycle--confirmation--removal-d52)
(`confirmCount < DEFAULT_CONFIRM_THRESHOLD`, which is `1`):

- **`warning`** — an independently confirmed hazard → the full "⚠ hazard ahead."
- **`confirm_request`** — not yet confirmed → the soft "can you see it?" prompt.

**`ridge_crossing` passage markers never alert** in either layer — firing "⚠ hazard ahead" at
someone approaching the *safest* point on a ridge would be actively counterproductive. They still
render on the map.

---

## Re-alert gating — the "approached" set

The subtle part, and the source of a real bug we fixed. Without a dedup set, skating laps on a
pond would re-fire the same alert every circuit and train the skater to ignore it. But a naïve
"suppress until distance > hysteresis" *also* fails: a Layer-2 directional alert fires 30–60 s
*ahead* (i.e. far away), so `distance > hysteresis` is trivially true on the very next fix, and it
re-fires forever.

The fix (`apps/mobile/src/lib/onIce.ts`) is a **two-transition "approached" set** — a hazard must
be *entered* before it can be *left*:

1. **Enter** → mark a hazard `approached` once the skater is within the alert buffer (its vicinity).
2. **Leave** → release it (re-arm) only once an *already-approached* hazard is past the hysteresis
   band.

- **`DEFAULT_HYSTERESIS_MULTIPLIER = 2`** → hysteresis distance = `alertBufferMeters × 2` = **300 m**.

A proximity hit is "approached" from the moment it fires (you're within the buffer); a directional
hit fires far ahead and becomes approached only once the skater closes in — which is exactly what
stops the directional re-fire. The suppressed set resets **per session**, not per app launch.

---

## Background & session tuning (mobile)

### Background location (`apps/mobile/src/lib/onIceTask.ts`)

| Setting | Value | Why |
|---|---|---|
| accuracy | `Location.Accuracy.Balanced` | cold-weather battery matters more than sub-metre precision for a fuzzy alert |
| `distanceInterval` | 20 m | emit a fix every 20 m of travel |
| foreground service | on | the "On-ice mode is on" persistent notification (Android) / iOS blue pill |

### "Which lake am I on?" resolution

Every fix has to resolve to a water body without hammering the query layer:

- **`RESOLVE_GRID_DEG = 0.003`** (~330 m) — the grid a live coord is snapped to before keying the
  lake-resolve query, so the every-20 m fixes collapse into one stable lookup key. Chosen coarser
  than the auto-select buffer below.
- **`AUTOSELECT_BUFFER_M = 300`** (server-side, `waterBodies.ts`) — the coord→lake resolution
  buffer. ~300 m covers a lakeside parking lot, so opening the app *from the car* still resolves
  the right lake. This is what powers "back to the lake you're on."

### Dwell / auto-suggested skate window (`apps/mobile/src/lib/dwell.ts`)

On-ice mode also quietly tracks how long you're on each body, to pre-fill the skate window on the
report form later:

- **`DEFAULT_DWELL_GRACE_MS = 2 min`** — how long you must be continuously off a body before its
  dwell is closed. Absorbs the brief off-body fixes a shoreline-clipping lap produces, so one
  skate stays one interval.
- The suggested window is `earliest-in / latest-out` across today's dwells on that body.

### Notifications (`apps/mobile/src/lib/onIceMode.ts`)

**There is no time-based cooldown constant** — don't go looking for one. De-duplication is purely
*structural*: the per-session `alerted` / `approached` sets are the only throttle. A hazard fires
once per session (or once per genuine re-approach). Notifications fire immediately
(`trigger: null`).

---

## What's deliberately absent

- **No time-based notification throttle** — structural dedup only (see above).
- **No heading smoothing** — raw GPS course over ground, or silence below the speed floor.
- **No server-side position tracking** — all evaluation is on-device (D12).
- **No hard safety guarantee** — silence is not an all-clear (the invariant at the top).
