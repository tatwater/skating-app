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

### The rules, if it is ever built

> **Validated first, capped forever.**

1. **Validated against our own condition reports before anything renders.** We have reports carrying
   surface descriptions, dated and located. That is a ground-truth set nobody else has, and it is the
   only honest way to find out whether the conjunction means what we think it means. **No validation,
   no feature** — the N6a lesson: an evidence gate nobody points at is not a gate.
2. **The strongest claim it may ever make is *"smooth ice observed on \[date]."*** Never *"black ice
   here."* Never *"black ice now."* Never a colour ramp that reads as a quality score, for the same
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
