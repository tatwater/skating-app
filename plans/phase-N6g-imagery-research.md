# Phase N6g — What nine seasons of imagery might know: two research lanes

*Both lanes read [N6e](./phase-N6e-satellite-imagery.md)'s archive and neither can start before it
exists. One would be the most-wanted feature in the product. The other would shrink the corpus. Both
are the kind of thing that is easy to ship and hard to ship **correctly**, which is why they are here
rather than in a workstream.*

> **Status:** 📋 Scoped 2026-08-21, unbuilt, **no scheduled start.** Split out of N6e at the founder's
> ask — *"let's park black ice from SAR into a new N6g research doc! Let's also put the never-freezing
> body elimination idea into N6g as well."*
>
> **Hard prerequisite:** N6e **PR 2** — the granule pipeline, the nine-season archive (2017-18 →
> 2025-26), and the phenology series derived dark. Neither lane has an input before that lands.
>
> ⚠ **Updated 2026-08-25 by the first correctly-measured radar cut.** Lane 1 gains a **gate zero**
> before its validation gate — on `VH`, the median lake now sits **1.24 dB** above the instrument's
> own noise floor and 38% sit below it, which constrains *per-pixel* claims (where the black ice is)
> while leaving *per-body* ones (whether a lake darkened) intact. Lane 2's area floor becomes
> measurable rather than assumed. **Both lanes must read frames cut after this date** — earlier ones
> measured a 60 m ring of shoreline as though it were lake.
>
> **Decisions carried in:** **D3** (never a safety verdict), **D150** (classification is an
> observation, never counsel), **D151** (a phenology date is a bracket, and the subject of the
> sentence is us), **D49** (display prominence), **D148**/**D149** (the archive and its gate).

---

## Lane 1 — Black ice from SAR + freeze rate

**The most-wanted thing a skater could be told, and the most dangerous thing to get wrong.**

> **Founder, 2026-08-21:** *"is it possible for us to know, based on how quickly ice arrived on a body,
> plus how easy it is for standard SAR to see ice vs water compared to what the bands show for ice vs
> water, to predict where black ice is?! That would be a very cool feature, since everyone wants to
> skate black ice."*

### Why it is physically plausible

The mechanism is real and it is the same one that makes SAR *ambiguous* elsewhere — used deliberately
rather than suffered:

- **Smooth ice is specular.** Radar hitting a flat surface reflects away from the sensor, so smooth
  new ice returns **dark** in Sentinel-1 backscatter. Rough, deformed, snow-covered or ridged ice
  scatters back and returns **bright**.
- **Calm open water is also dark**, which is exactly the confusion N6e §C1 warns about — and it is
  resolvable, because **Sentinel-2 can tell ice from water** where SAR cannot. So the signature is a
  *conjunction*: **low SAR backscatter AND optical classification of ice, not water.**
- **Freeze rate is a genuine covariate.** Ice that formed fast over still water in a cold snap is the
  ice that ends up smooth; a slow freeze under wind produces the rough surface people call "crusty."
  N6e's phenology series measures exactly that — how many days between "open" and "frozen."

Which means the ingredients all exist in the archive, and none of them requires a new sensor.

### Why it is nonetheless the riskiest thing in the roadmap

- **Resolution.** 10–20 m pixels over a lake whose interesting features are metres across.
- **Latency.** Black ice is a *condition of a few days* and often of a few hours. A pass is up to six
  days old, and a six-day-old smoothness observation is not a claim about today.
- **The incentive structure is the actual hazard.** Everyone wants black ice. **A false positive is
  therefore the most costly error this product can make** — it would send someone to a lake *because*
  we implied the good stuff was there, which is the precise mechanism D3 exists to prevent. The
  asymmetry is not "sometimes wrong in both directions"; it is "wrong in the direction people act on."

### ⚠ Gate zero, measured 2026-08-25: is there dynamic range to work in at all?

**Before the validation gate below, there is a prior question nobody had asked, and the first real
radar cut answers it uncomfortably.** With the shoreline correctly removed and thermal noise
subtracted, `VH` over actual lake surfaces sits at a median of **−24.28 dB** — and the instrument's
own noise floor on that pass is **−25.19 dB**.

| margin over each body's own NESZ | bodies |
| --- | --- |
| **below the floor** | 991 (**38%**) |
| within 1 dB | 1,233 (48%) |
| within 3 dB | 1,607 (**62%**) |
| within 6 dB | 2,032 (79%) |

Median margin **+1.24 dB**, across 2,576 bodies on one February ascending pass.

**This was invisible until three separate errors were fixed, all leaning the same way.** The old
figures read ~−20.6 dB against a floor *assumed* to be −27, which looked like six decibels of room.
The bright shoreline was inflating the whole-body mean by **3.67 dB**, unremoved thermal noise by
another **~0.8**, and the assumed floor was ~2 dB below the measured one. Remove all three and most
lakes are sitting on the floor.

#### ✅ The floor itself is right, and being under it is not the problem

Checked, because "38% below the floor" reads like over-subtraction:

- **It is not.** Only **2 nulls in 2,578**; the margin distribution runs to **p90 +8.8 dB** across a
  45 dB spread. Over-subtraction collapses a distribution; this one is broad.
- **The size trend is flat to inverted** — 34% below floor for bodies under 50 interior pixels against
  **51% for bodies over 1,000**. An estimation artefact would punish small lakes hardest; this does the
  opposite, which is the signature of a real property of large open surfaces.
- **NESZ is ESA's own annotation**, consistent with the IW specification (≤ −22 dB) and with published
  calm-water `VH` values of −25 to −30 dB. Lakes are genuinely that dark.
- **Subtraction recovers sub-floor targets in expectation**, and averaging makes it precise: median
  1σ per body is **0.50 dB**, 75% of bodies better than 1 dB.

#### ⚠ So the constraint is per-PIXEL, which is exactly what this lane wanted

| the claim | reliability at or below the floor |
| --- | --- |
| *"this lake averaged −24.3 dB"* | fine — ~0.5 dB, because thousands of pixels average |
| *"**this pixel** is specular"* | **~3–4 dB 1σ** — noise |

A per-body mean survives the floor; a per-pixel classification does not, because a single look carries
~4.4 equivalent looks of speckle and no averaging to lean on. **Lane 1's founding ask is "predict
*where* black ice is", and *where* is a per-pixel question.** A "fraction of the lake below −22 dB"
statistic computed against a 3–4 dB per-pixel error, on lakes whose median sits 1 dB above the floor,
is measuring the instrument.

**What this does not kill.** Change detection over time on a *whole lake* is unaffected — that is a
per-body mean, and it is precise. So the archive still supports *"this lake darkened by 2 dB between
these two dates"*; what it does not support is *"this corner of it is glassy"*.

Two things could yet reopen the spatial question, and both are testable from the archive rather than by
argument: **`VV` sits well above the floor** (whole-body median near −17 dB), so a conjunction leaning
on `VV` has room `VH` does not; and **S1C's floor is 2.80 dB quieter than S1A's**, so S1C passes have
margin where S1A passes have none — which makes N6e's open question 7 a *measurability* question and
not only a cadence one.

#### The archive now carries what this gate needs

None of the above was checkable before 2026-08-25 and all of it is now, per body per pass:
`neszDb` (that body's own floor, in its own units), `interiorVhDb`/`interiorVvDb` (measured with the
bank removed), `interiorPixels` (what the precision rests on), `interiorBelowNoiseFloorPct`, and
`sigma0Hist` for the distribution. ⚠ **`sigma0Hist`'s bottom bins hold everything at or under the
floor** — read them against `neszDb` or they will read as exceptionally smooth ice.

### The rules, if it is ever built

> **Validated first, capped forever.**

0. **Clear gate zero first.** The validation below asks *"does the conjunction separate our reports?"*
   It presumes there is signal to separate them with, and on `VH` at these depths that is now an open
   question rather than an assumption. Running the validation without checking the margin would
   produce a null result that looks like "the physics does not hold" when it means "we measured the
   noise floor 2,576 times".
1. **Validated against our own condition reports before anything renders.** We have reports carrying
   surface descriptions, dated and located. That is a ground-truth set nobody else has, and it is the
   only honest way to find out whether the conjunction means what we think it means. **No validation,
   no feature** — the N6a lesson: an evidence gate nobody points at is not a gate.
2. **The strongest claim it may ever make is *"smooth ice observed on \[date]."*** Never *"black ice
   here."* Never *"black ice now."* Never a color ramp that reads as a quality score, for the same
   reason D82 forbade one for depth.
3. **It never feeds anything.** Not a notification, not a bounty gate, not the recommended feed, not a
   trust signal. An observation layer that becomes an input is a prediction wearing a different hat.
4. **It obeys D151's bracket.** The observation is dated, and the previous pass is part of the claim.

### What a first pass would actually look like

Deliberately unglamorous: take the bodies where we already have dated reports describing the surface,
pull the S1 backscatter and S2 classification for the nearest pass, and **see whether the conjunction
separates the reports at all.** That is a scatter plot and an afternoon, not a feature — and it either
justifies the lane or kills it for the price of neither.

---

## Lane 2 — Bodies that never freeze

> **Founder, 2026-08-21c:** *"I'd be very happy to fully eliminate bodies if they haven't frozen over in
> the past 9 years. We already have N7b planned which would allow users to manually request that we add
> a body to the corpus, at which point we'd be able to grab all the data we delete during this
> elimination phase once more with a proof point that people actually want it!"*

**The argument is good**: a Cape Cod salt pond that has not frozen in nine observed winters is not a
skating destination, it is corpus weight — and [N7b](./phase-N7b-corpus-by-request.md) makes removal
recoverable rather than final, which is what changes the calculus. Three findings shape how it should
be done.

### Nothing is sub-pixel, but the smallest bodies still can't answer

The founder's check was right: **the corpus hard floor is 1 acre** (`HARD_MIN_SURFACE_AREA_ACRES`,
`packages/core/src/osm.ts:91`), which at Sentinel-2's 10 m is **~41 pixels**. Nothing in the corpus is
smaller than a pixel.

**But 41 pixels is not 41 usable pixels.** A 1-acre pond is roughly 6×7 px, and standard practice
erodes the shoreline by 1–2 px before classifying, because edge pixels mix water with bank. After
erosion a 1-acre body has **under ten** pixels to vote, and a 5-acre body has around a hundred.

⚠ **So "never observed frozen" is strong evidence for a 50-acre lake and weak evidence for a 1-acre
pond** — and it is weak in the dangerous direction, because a body too small to classify reads exactly
like a body that never froze. **The elimination rule needs its own area floor, well above the corpus
floor**, and that floor should be measured against bodies we *know* freeze rather than assumed.

#### ✅ That floor is now measurable rather than assumed — 2026-08-25

The erosion this section calls for is **built**, and every frame records what it left behind:
`interiorPixels` (how many pixels actually voted on this pass), `interiorTotalPixels` (how many the
body has *at all*, independent of the pass), and the full 12-class `classHist` beside them.

The distinction between those two is the one that matters here. `interiorPixels` varying tells you a
pass caught only part of a lake; **`interiorTotalPixels` is a property of the geometry**, and it is
what an area floor should actually be set against — *"this body is too small to ever be classified"*
rather than *"this granule only caught a corner of it"*. Verified on a synthetic 3×3-pixel pond: it
comes out of the erosion with **exactly one** voting pixel, which is this section's caution rendered
as a number an operator can be shown.

⚠ **And every frame cut before 2026-08-25 measured the wrong shape.** The zone raster was the *reveal*
— the lake buffered 60 m outward, unioned with the walk in and the parking, islands filled. Measured
across 40 real corpus bodies, the median old zone was **44% not-lake**, rising to **70% under ten
acres** and 86% on a 1.3-acre pond. Since this lane eliminates bodies precisely at the small end, an
elimination run against those frames would have been reading the surrounding woods. Only frames from
the re-cut carry water-only statistics.

### Delete the row, keep the enrichment

The expensive part of a corpus row is not the row. N7-3's campaign spent real quota and real time on
**3DEP elevation (99.5% coverage), measured depth, and the wind climatology** — none of which comes back
from N7b for free. A user requesting a body via N7b would trigger a re-run of ETL passes that were
already paid for once.

**So: remove from the live corpus, archive the enriched row.** A cold JSON export in R2 beside the
imagery archive costs approximately nothing and turns N7b re-add from *"re-run the enrichment"* into
*"restore the row."* This is the one design note that makes the founder's recoverability argument
actually true rather than nearly true.

### Evidence of absence has a third failure mode

Nine seasons of never-observed-ice is nine seasons of **what we managed to observe**. Cloud gaps
cluster (a stormy fortnight takes several passes at once), and D151's warning about non-uniform
Sentinel-1 revisit applies here too. A body observed 40 times over nine winters and never frozen is a
finding; a body observed 9 times is a shrug.

**So the rule carries an observation count, not just a verdict** — and the count is what an operator
sees when they confirm the removal.

### The shape of the rule

| | |
|---|---|
| **Candidate** | ≥ N observations across the nine seasons, **zero** classified as ice, area above the elimination floor |
| **Never automatic** | Surfaced to an operator with the evidence — count, seasons covered, area, and the frames themselves |
| **Recoverable** | Enriched row archived to R2 before removal; N7b restores rather than re-derives |
| **Priors that agree** | Salt/brackish flags and `tidalBand` already exist in the ETL — a coastal body the imagery says never froze is two independent signals agreeing, which is a much stronger candidate than either alone |

**Expected catch:** coastal and southern-Massachusetts bodies, Cape Cod salt ponds, and tidal
reaches — overlapping substantially with the 1,353 downstate bodies the region/corpus mismatch already
left unpurged.

---

## Out of scope for both lanes

- **Anything that recommends.** Both lanes produce *observations about the past*. The moment either
  becomes an input to a notification, a ranking or a gate, it is a prediction (D3, D150).
- **Shipping either without its gate.** Lane 1's gate is validation against our own reports; Lane 2's
  is an operator confirming with the evidence in front of them.
- **Starting before N6e PR 2.** Neither lane has an input until the archive exists.
