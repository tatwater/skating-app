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
- **Never archived, and never hidden by age, score or anything else *within a season*** — the
  one exception is the seasonal boundary, which is a change of *default view* rather than of
  the report, and which is described [below](#age-framing-3--the-season-boundary-n5ad63). Contrast a
  hazard, which genuinely fades and can be archived.
- **Sorted, not decayed** — everything orders by `skateEndTime`, "when the skater left the ice,"
  the freshest read of the ice.

What *does* change with age is **how the report is framed**: which section of the feed it lands
in, whether it shows a weather-since strip, and — once it's a season old — whether it's in the
default view or behind the season selector. None of the three is a decay of the report itself.
That's the whole lifecycle.

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

## Age framing #3 — the season boundary (N5a/D63)

The one place a report *does* leave a default view. **A season runs July 1 → June 30**, labelled
by the two calendar years it spans (`'24/'25`), and the lake's report list and the global feed
both show **this** season only.

This is still framing, not decay, and the distinction is worth being precise about because it's
the one that looks like an exception:

- **It hides, it never removes.** A past-season report resolves by permalink exactly as it always
  did — someone may hold a link, a bookmark or an old notification, and a 404 on a URL that used
  to work is a worse lie than an old report clearly marked old. It renders with a *"from the
  '24/'25 season"* line so it can't be mistaken for Tuesday's.
- **It's reversible and labelled**, by a per-lake season selector. Browsing a past season is a
  curiosity ("what was this bay like in December?"), not a safety surface, so the control lives on
  one lake and nowhere near the map's default state — and it governs the *whole* lake view (list,
  hazard pins, aggregate tracks), because two seasons on one screen is exactly the confusion this
  exists to end.
- **It applies to everyone equally, forever.** Contrast [account deletion](./account-deletion.md),
  which erases and redacts: *aging never removes anything.*

**The season is derived, never stored** — `seasonOf(skateEndTime)`, with no column, no backfill
and no cron to advance anything. The reset isn't an event; it's the derived value changing and
the queries following. Because `skateEndTime` is already the range field of the indexes these
reads use, a season bound makes them **cheaper**.

Three reads are deliberately **exempt**, each for its own reason:

- **A profile's own report list** — a person's contribution history is not a claim about the state
  of the ice.
- **Put-in markers**, which derive from reports — where you can get on the ice doesn't change
  because the calendar did, and access is the corpus's single most-discussed concern.
- **The global feed's fallback.** Scoping the feed strictly would blank the home screen on July 1
  and leave it blank until first ice — five months, not a day — so when this season has nothing
  the feed serves the newest season that does, **under a divider that says so**. Labelled is what
  keeps it honest; silently mixing two winters is the thing D63 forbids.

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
- **It sets the opacity of its recorded path.** If the skate was recorded in the app, the GPS
  track draws on the lake's community map — and it fades as the report ages.

---

## The one number that *is* a freshness curve (and why it isn't report decay)

Phase 8 added `packages/core/src/reportFreshness.ts`: a 0–1 value that blends recency off
`skateEndTime` with net helpful thumbs and corroboration count. Read that and the "reports don't
decay" claim above can look false. It isn't, and the distinction is the whole design:

**Freshness never touches the report.** It is not displayed on a report, doesn't reorder the feed,
doesn't gate visibility, and doesn't weight trust. It has exactly two consumers:

1. **Path opacity on the aggregate tracks layer.** A GPS path is the report's *extent* — it has no
   independent claim to make, so it has no independent freshness. Both the report's own age and its
   path's opacity read the **identical** number, which is precisely why they can't drift into saying
   different things about the same skate. Opacity is floored (`pathOpacity`), so an old path fades
   but **never vanishes** — an empty-looking lake would read as "all clear," which this app never
   asserts (D3).
2. **The shared primitives bounties use.** Bounties keep their own policy (a *window in hours*, not
   this curve) but call the same recency/thumbs helpers instead of a private copy of the math.

So: the *path* fades, the *report* doesn't. A faded line means "this is old," never "this is wrong,"
and the report behind it is as readable on day 30 as on day 1. Adding a visible freshness meter to a
report was considered and rejected at Phase 8 kickoff — it's the closest thing in the app to an
authoritative safety verdict. Details: `plans/01-decisions.md` → **D59**, and the aggregate layer's
privacy gates in **D58**.

---

## What's deliberately absent

- **No report decay curve.** No half-life, no confidence erosion, no age-based opacity — a
  report's map pin looks the same on day 1 and day 30. *(The Phase-8 `reportFreshness` curve is
  internal and fades only the recorded GPS **path**, never the report — see the section above.)*
- **No hiding or archiving by age or score.** Old and low-rated reports stay fully visible;
  quality signals only *reorder* and *route to moderators*, never hide (safety content isn't
  gated by score — D3).
- **No stored duration.** It's always `end − start`, derived on read.
