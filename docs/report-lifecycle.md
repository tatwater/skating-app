# Report lifecycle

What happens to a skate report over time. The short version, and the thing that surprises
people: **a report never decays.** It doesn't lose trustworthiness on a timer, it's never
hidden, and it's never archived. This doc explains what *does* change as a report ages — and
why "report decay" is the wrong mental model, even though [hazards](./hazard-decay-and-lifecycle.md)
next door genuinely do decay.

> **Who this is for.** Anyone reasoning about report freshness, the feed, or the weather-since
> strip. If you came here looking for a report confidence-decay curve, read the next paragraph —
> there isn't one, by design.

---

## The mental model: reports are permanent facts, not perishable claims

A report is a timestamped observation: "I skated *here*, I left the ice *then*, and here's what
I saw." That fact doesn't get *less true* as time passes — a two-week-old report is exactly as
accurate a record of that day as it was the day it was posted. So reports are:

- **Always public** — there is no visibility field (D13).
- **Never hidden or archived** by age, score, or anything else (contrast a hazard, which fades
  and can be archived).
- **Sorted, not decayed** — everything orders by `skateEndTime`, "when the skater left the ice,"
  the freshest read of the ice.

What *does* change with age is **how the report is framed**: which section of the feed it lands
in, and whether it shows a weather-since strip. Neither is a decay of the report itself — both
are just "how old is this, and what's happened since." That's the whole lifecycle.

Why the distinction matters: a hazard's decay expresses *waning confidence that the danger is
still there*. A report makes no such forward claim — it never says "the ice is still good," only
"the ice was like this then." So there's nothing to lose confidence in, and hiding an old report
would just destroy a historical record. The [weather-since strip](#age-framing-2--the-weather-since-strip)
is how we let a *reader* judge whether an old observation is still relevant, without the app
pretending to know.

---

## Age framing #1 — feed bucketing

The feed groups reports into widening age buckets by `now − skateEndTime`
(`packages/core/src/feed.ts`, `feedSectionForTime`), rendered as scroll-divider headers:

| Bucket | Age | Header |
|---|---|---|
| today | < 1 day | "Today" |
| yesterday | < 2 days | "Yesterday" |
| this-week | < 7 days | "Earlier this week" |
| this-month | < 30 days | "Earlier this month" |
| older | ≥ 30 days | "Older than a month" |

This is a **step function on age** — same *shape* as hazard freshness tiers, but the opposite
*consequence*: it **reorders**, it never fades or hides. A clock-skew "future" report falls
harmlessly into `today`.

Alongside it, the feed offers a **recency filter** (`recencyHours`: last 24 h / 48 h / 7 d /
off) — a *hard cutoff* the viewer opts into, not a decay weight — and ranks within a body using
`QUALITY_RANK = { poor: 0, fair: 1, good: 2, great: 3 }`.

---

## Age framing #2 — the weather-since strip

The one genuinely age-dependent piece of UI. A report can carry a
[weather-since strip](./weather-since.md) — a plain-text line describing what the weather has
done *since the skate* — so a reader can judge whether a day-old observation still holds. Its
visibility is a three-state gate on the report's age (`reportStripState` in `weatherStrip.ts`):

| Report age | State | What shows |
|---|---|---|
| `< 6 h` (`minAgeHours`) | `hidden` | nothing — a fresh report has no meaningful weather-since yet |
| 6 h … 14 d | `strip` | the weather-since line, window = since the skate |
| `> 14 d` (`maxAgeDays`) | `aged` | a plain "reported N ago" age line instead |

So the strip *appears* as a report ages past a few hours and *retires* once the report is old
enough to be stale on its own terms — but note the report itself is still fully visible at every
stage. The strip is descriptive only; it never asserts the ice is safe (D3). See
[weather-since](./weather-since.md) for the copy format and the shared reducer.

---

## Conditions auto-fill (Phase 10 §7a)

A report's observed `conditions` (air temp, wind, sky, precip) can be **pre-filled** from
Open-Meteo at the skate time and location (`packages/core/src/weatherConditions.ts`), so a
reporter who skipped the weather fields still gets them. Two rules keep this honest:

- **It's observed weather, never a safety claim** (D3). Auto-filled values are stamped
  `source: 'openmeteo'` so the provenance is always visible.
- **The user always wins — at the object level.** The autofill runs *only* when the reporter
  supplied no conditions object at all; if they entered even one field, their whole
  `source: 'user'` object is kept untouched (it's an object-level "fill if empty," not a
  field-by-field merge).

The mapping is what you'd expect: wind degrees → 8-point compass, cloud cover → sky (≤25 clear,
≤75 partly cloudy, else overcast; precipitating overrides to "precip"), and the rain/snow split
→ precip type (both ⇒ sleet).

---

## Validation & normalization (the create contract)

The rules that gate a report at creation live in one place (`packages/core/src/report.ts`),
validated client-side and re-enforced server-side (D37). The lifecycle-relevant ones:

- **`skateEndTime` is required and can't be in the future** beyond
  `SKATE_TIME_FUTURE_TOLERANCE_MS = 1 h` (absorbs clock skew; rejects implausible futures). It's
  the primary sort key everywhere.
- **`skateStartTime` is optional**; when present it must precede the end. Duration is *derived*
  (`end − start`), never stored.
- **Nothing about ice quality is required** (D3) — a "don't skate here" report carrying only
  `notes` is valid. What's required is just the anchor: a water body and when the skater left.
- Minors can't create reports at all (that gate lives in the create mutation, D41).

---

## Where reports touch the rest of the system

A report is an input to two other lifecycles, documented elsewhere:

- **It suppresses bounties.** A recent report on a body means "fresh eyes have been here
  lately," which holds off new [bounties](./bounty-decay-and-lifecycle.md) — for a window that's
  *longer* when the report is corroborated / from a trusted author, and collapses to zero when
  the weather says the ice likely changed.
- **It earns reputation.** Submitting, adding a photo or a measured reading, getting thumbed
  helpful, or being independently corroborated all bump the author's boost-only
  [trust](./user-reputation.md) — and two same-body reports that *disagree* (with no weather to
  explain it) feed the contradiction signal.

---

## What's deliberately absent

- **No report decay curve.** No half-life, no confidence erosion, no age-based opacity — a
  report's map pin looks the same on day 1 and day 30.
- **No hiding or archiving by age or score.** Old and low-rated reports stay fully visible;
  quality signals only *reorder* and *route to moderators*, never hide (safety content isn't
  gated by score — D3).
- **No stored duration.** It's always `end − start`, derived on read.
