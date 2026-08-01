# Drawing the bottom of a lake: what didn't work

A field report from building the bathymetry layer (N6b) — the underwater contour lines you see inside
a lake when you open its drawer. Almost everything in here is a **failure**, kept deliberately,
because the failures were far more instructive than the successes and every one of them looked
correct in advance.

> **Who this is for.** Anyone touching the contour pipeline, anyone tempted to "improve" one of its
> gates, and anyone who wants to understand why a feature that sounds like a weekend turned into the
> most iterated work in the project. **No prior mapping knowledge assumed.** Build notes:
> [`plans/phase-N6b-bathymetry-layer.md`](../plans/phase-N6b-bathymetry-layer.md).

---

## Orientation: five words you need

| Word | What it means here |
| --- | --- |
| **sounding** | One measured depth at one location. *"24 ft, at this GPS point."* A boat with a depth-sounder produces thousands, in lines along its track. |
| **isobath / contour** | A line joining points of equal depth. The 20 ft contour is the line you'd walk along if you could walk on water 20 ft deep. |
| **interpolate** | Guess the values *between* the measurements, so you have a continuous surface rather than scattered dots. This is where almost all the trouble lives. |
| **grid / cell** | We convert the lake into a fine chequerboard and estimate a depth for every square. A cell is one square, typically 25 m across. |
| **the fit** | The estimated depth surface, once interpolation has filled in the gaps. Contours are traced *from the fit*, not from the measurements. |

**The core tension in one sentence:** states publish either finished contour lines (easy — we redraw
them) or raw sounding dots (hard — *we* have to invent the surface between the dots, and every
mistake in that invention gets drawn as though it were a measurement).

---

## Chapter 0: The thing we refused before starting

There is a free, global dataset called **GLOBathy** with per-lake depth rasters for 1,427,688 lakes.
It would have taken an afternoon.

**We must never draw contours from it**, and understanding why sets up everything else. GLOBathy's
method is: take the lake outline, compute for every point how far it is from the nearest shore, and
convert that distance into a depth with a straight-line formula. Depth is therefore *purely a function
of distance from the bank*.

Contours drawn from that are **inward copies of the outline we already draw**. They'd be smooth,
plausible, and carry exactly zero information beyond the lake's maximum depth and its shape — both of
which we already have. Every feature a skater would actually use the layer for (the deep side, the
shallow arm, the shelf off the point) is precisely what that method cannot represent.

**This matters as a permanent yardstick.** Several later mistakes were versions of this same failure
arriving by a different road, and "are we accidentally rebuilding GLOBathy?" became the standing test.

---

## Chapter 1: Making a surface from dots — four failures, then success

We need a continuous depth surface from scattered soundings. Four methods were tried and rejected,
**each of which looked correct until it was rendered.**

### 1.1 Inverse-distance weighting — *bullseyes*

The obvious method: each unknown point's depth is a weighted average of nearby soundings, closer ones
counting more.

**What went wrong:** it's an *exact* interpolator — the surface passes precisely through every
measurement. So every sounding becomes a tiny local peak or pit, and the contours drew a **ring around
every single data point**. The map looked like bubble wrap. Those rings are the arithmetic of the
method, not the shape of the lake.

It also has **no edge** — it produces a value for every point in the rectangle, so contours ran off
across dry land to the corners of the image.

### 1.2 Delaunay triangulation — *facets and slivers*

Connect the soundings into triangles, and shade flatly within each triangle.

**What went wrong:** it drew the triangulation. Contours came out as **angular facets** — a lake bed
rendered like a low-poly video game — and where soundings sat in near-parallel boat tracks, the
triangles became long thin slivers that produced spikes.

It did get one thing right, which is worth stealing: a triangulation only exists *inside* the area the
survey covered, so it gave us a correct "don't draw beyond the data" boundary for free.

### 1.3 Moving average — *the search radius, drawn*

Average everything within a fixed radius.

**What went wrong:** it rendered its own radius. Around every cluster of readings you got **overlapping
circular arcs** — a pattern of the algorithm's search circle, not the basin.

> **The pattern across all three:** these are general-purpose tools for *scattered* data, and our data
> is **transect** data — dense along boat tracks, sparse between them. That asymmetry defeats all of
> them, and each one signs its own name on the output.

### 1.4 A tensioned spline — *right, but split*

The fourth attempt (GMT's `surface`) fits a flexible sheet through the measurements — like stretching
a rubber membrane through the data points. This finally looked like bathymetry.

**Its failure was subtler and the founder spotted it.** Deep readings along the lake's length sit about
300 m apart; shallow readings across its width sit about 100 m apart. The method treats distance the
same in all directions, so the *sideways* pull toward the shallow shore beat the *lengthwise* pull
between deeps — and a single continuous trough broke into **a row of isolated pits**.

We could prove this was wrong rather than merely ugly: the raw depth profile along the lake's axis ran
44–64 ft *continuously* across half its length. The trough is in the data; the fit was cutting it up.

### 1.5 The fix, and one more failure inside it

**Squash the lake along its long axis before fitting, then unsquash it.** A trough then competes fairly
against the sideways pull. Conceptually: pretend the lake is shorter than it is, fit, then stretch the
answer back.

**First attempt failed too.** We squashed the coordinates and left them squashed for everything
downstream — smoothing, masking, contouring. All of those measure distance in grid units, so a circular
smoothing brush became a **4–8× stretched oval**, and every lake smeared into an axis-aligned lens.

**And the "obvious" flag was inert.** GMT has a documented anisotropy option (`-A`) that ought to do
this properly. Measured across settings from 0.25 to 4, contour elongation didn't move (~2.2 either
way) and the fragment count went *up*. Worth recording so nobody spends an evening on it again.

**What actually works:** squash for the *solve only*, then relabel the result's coordinates back to
real metres before anything else touches it. The solver sees a compressed lake; the smoother, the mask
and the contour tracer all see true distances.

---

## Chapter 2: Lakes bend, and our axis doesn't

The squash direction is **one straight line per lake**. A lake that curves along its length gets its
contours pulled toward a direction that only fits part of it, which reads as rigid and over-stretched.

**The mitigation is nicer than it sounds:** cap the squash at each lake's own measured elongation. A
curved lake's cloud of points is *rounder* than a straight one's, so a bending lake asks for less
squashing automatically. A round pond ends up at 1 — no squashing at all, which is correct.

| Lake | shape | squash applied |
| --- | --- | --- |
| Pleasant Lake (curved) | | 1.95 |
| Quantabacook (long, straight) | | 3.32 |
| a round pond | | 1.00 |

**This is still a straight axis, just a politer one**, and it remains the largest known limitation.
Checked against Vermont's own published chart of Lake Morey, our deepest region comes out as a narrow
finger where the state shows a broad rounded basin — the squash over-applied on a lake whose basin is
rounder than its outline. The proper fix (follow the lake's curving centreline) is written up and
costed; it's real work and it isn't done.

---

## Chapter 3: Which lakes should we draw at all? — five ideas, five falsifications

Some lakes have too little data to draw honestly. We need a rule. **We tried five, and the render
falsified every single one.** This chapter is the most useful thing in this document.

### 3.1 Nearest-neighbour spacing — *measures the wrong gap*

*"Reject a lake if its soundings are too far apart."*

**Wrong gap.** On transect data, the distance to the nearest sounding measures spacing **along the
boat's track** — which is tiny — and says nothing about the distance **between tracks**, which is what
you're actually interpolating across. Measured on real lakes, the true coverage gap ran **8–12× larger**
than nearest-neighbour implied. One lake had 81 m between adjacent readings and **981 m** of water that
was nowhere near any reading.

**Replaced by:** *standing anywhere in the surveyed water, how far is the nearest measurement?* — which
is the gate we still use.

### 3.2 The coverage gap ratio — *kept, but its premise was wrong*

We set the threshold by rendering twelve real lakes in three bands and looking.

**The comparison overturned its own premise.** Visual quality did **not** track the ratio. The worst
map in the grid scored 10% — and had *more soundings than any other sample*. Two lakes at 11% and 12%
read cleanly.

We kept the gate (coverage is worth requiring on its own terms) but stopped believing it predicts
whether a map looks right. **This was the first warning, and we didn't take it.**

### 3.3 Shore share — *lasted one day*

To make contours close properly, we add points around the shoreline all marked "depth 0". Otherwise
the rings never close and nothing nests inside anything.

Measuring how much of the fit was *our* shoreline versus the *state's* soundings gave an alarming
number: on Maine's lakes, **84–96% of what the solver saw was our own outline.** That looked exactly
like accidentally rebuilding GLOBathy, so we gated on it.

**It dropped 672 lakes — every one in Maine.** Then we rendered twenty of them either side of the
threshold:

| Lake | shore share | verdict | how it actually looked |
| --- | --- | --- | --- |
| Beddington Lake | 74% | ✅ kept | **the worst map in the sample** |
| Bowles Lake | 85% | ❌ dropped | clean |
| Haywire Pond | 78% | ❌ dropped | clean |
| Deer Lake | 65% | ✅ kept | clean |

**It kept the worst map and dropped four of the cleanest.**

**Why it failed:** the shoreline point count has a *floor* (below ~120 points the rings stop closing).
So for any lake with fewer than ~120 soundings, the shoreline side is roughly constant while the
sounding side varies — meaning the ratio mostly reports **how few soundings a lake has**, which two
other gates already cover.

### 3.4 Fragment count — *falsified by Lake Champlain*

When you ask for the 20 ft contour, you get back however many separate pieces that depth makes. A clean
lake gives one closed ring per depth. A noisy fit gives eight disconnected squiggles, because the
surface **wobbles across 20 ft repeatedly** as it wanders between sparse readings.

So: count pieces ÷ depths requested. Beddington scored 7.7 (bad, correctly). Morey scored 1.5 (good,
correctly).

**Then it dropped Lake Champlain at 10.2** — our most prominent skating water and our *only* New York
coverage.

**And Champlain is not noisy.** A 174 km lake with a dozen basins and bays genuinely has many separate
rings at one depth. **Fragment count doesn't scale with lake size**, so the metric punishes big complex
lakes for being big and complex.

### 3.5 Closure — *the idea that felt right and measured flat*

If noise is the surface wobbling across a depth, those fragments should be **open stubs** that start
and stop in open water — geometrically impossible for a real contour, which must close on itself. Test
for closure and you'd separate real complexity from noise at any size.

**Measured: every lake was 100% closed.** Champlain, Morey, and both noisy lakes alike.

**Why:** the masking step produces a surface whose contours always close, either on themselves or
against the boundary of the surveyed area. Noise doesn't appear as open stubs — it appears as **small
closed rings**. The reasoning was right about real bathymetry and wrong about what our tracer emits.

### 3.6 A units error of my own, corrected

Along the way I reported fragment lengths **in grid cells** and concluded Champlain looked worse than
the lakes we were trying to catch. **Cell size varies 10× across the corpus**, so that comparison was
meaningless. In real metres it inverts completely:

| Lake | cell size | median ring length |
| --- | --- | --- |
| **Champlain** | 145 m | **1,305 m** |
| Morey (clean) | 11 m | 429 m |
| Ebeemee (noisy) | 16 m | 240 m |
| Beddington (worst) | 13 m | 208 m |

Champlain's pieces are **6× longer** than Beddington's. They're real basins.

---

## Chapter 4: How many lines to draw

### 4.1 A fixed number of bands per lake — *exactly backwards*

The first rule targeted ~12 contour bands per lake, computed from its maximum depth. Checked against
the agencies' own published charts, it was backwards in the way that mattered:

| Lake | soundings | **our** interval | **the state's** |
| --- | --- | --- | --- |
| Washington Pond (ME) | **105** | 2 ft — 17 levels | 5 ft / 10 ft |
| Lake Morey (VT) | **68,139** | 5 ft | 2 ft |

**The sparse lake got the fine interval and the dense one the coarse**, because depth was the only
input and depth says nothing about how much detail the survey can support.

### 4.2 A fixed ladder — *works*

Now every lake is drawn **every 5 ft**, and the ladder only ever steps *coarser* (10, 25, 50) — for
depth, or for thin data. Never finer.

The nice consequence: **the number of rings is now a readout of depth.** Three rings means a 17 ft
pond; eleven means 59 ft. Depth became legible *across* lakes rather than only within one.

For states that publish their own contours we reach the same ladder by **subtraction only** — thinning
their published lines toward 5 ft spacing, never moving or inventing one.

### 4.3 One bug inside that, worth naming

Thinning a lake published at 2/4/6/8/10/12 ft gave 4/10 — **dropping its 12 ft ring**, the innermost
one, the only line that says where the deep water is. That's understating depth by omission, which is
the exact thing we'd refused elsewhere, arriving by a different road. **The deepest published level is
now always kept.**

---

## Chapter 5: The unglamorous bugs

These broke things without being interesting. They're listed because each cost real time and each was
invisible until it wasn't.

- **Every lake drawn 28% too wide.** A degree of longitude at 44°N is ~0.72 of a degree of latitude.
  Scaling both the same squashed every lake — and on a project whose entire output is *the shape of a
  basin*, a round pond rendering as an oval reads as a finding rather than a bug.
- **Framing to the data isn't framing to the lake.** Images were bounded by the soundings, so any lake
  whose survey stopped short of the bank had its shoreline run off the edge.
- **A source lake key isn't always one lake.** New Hampshire files two ponds **51 km apart** under one
  id; Maine has one key scattered over **379 km**. One key resolves to one lake outline, so the second
  pond's contours get clipped away against a shoreline miles from them — and **vanish without an
  error**. 17 keys are like this. Found by noticing one blank image.
- **A tool that writes to the screen, and a 1 MB limit.** One step streams its output rather than
  writing a file, and Node captures only 1 MB by default. Vermont's dense lakes overflowed it and were
  killed — presenting as *"the tool failed for no reason"* with an empty error.
- **A database read cap.** Resolving lakes to our own records hit a 16 MB per-query limit. Lowering the
  batch size can't fix it: the cost per lake spans three orders of magnitude between a farm pond and a
  point in the middle of Champlain. It needs adaptive batching that splits and retries.
- **Changing a denominator without re-deriving its threshold.** We fixed a real unfairness (long thin
  lakes were getting an easier pass) by changing what the coverage gap is measured against. The new
  measure runs ~1.8× smaller, so the *unchanged* threshold silently tightened by that factor and the
  drop count went from **271 to 1,224**. Same number, four and a half times the refusals.

---

## Where we've settled, and what's wrong with it

**One gate: coverage.** Standing anywhere in the surveyed water, the nearest measurement must be within
22% of the lake's characteristic size. That threshold was chosen by the founder *looking at rendered
lakes*, and re-derived when its denominator changed so the same judgement survived.

That produces **1,973 lakes → 45,693 contour lines → a 12 MB tile archive**, validated where we can
check it: against Maine's and Vermont's own published depth charts, our maximum depths match **exactly**
(36 ft and 42 ft), and basin shapes agree.

### The problems we're shipping with

1. **The straight-axis limitation** (Chapter 2). Curved lakes are over-stretched. Documented, costed,
   not fixed.
2. **No output-side quality gate at all.** Every attempt was falsified, so rather than tune one to fit
   we shipped without. Some genuinely messy lakes get drawn. That's tolerable *only* because of a
   product decision: **the contour layer makes no safety claim**. It's context — the shape of the
   basin, why the reef hole is where it is — and carries no interpretive copy. A skater can't act
   wrongly on a contour, so an imperfect one is cheap in a way it wouldn't be on any other layer.
3. **Crowding on steep beds.** Where the bottom drops off fast the lines bunch into what reads as
   hatching. The obvious fix — dropping bunched lines — was rejected because a deep lake with a steep
   bed would then show *fewer* rings than a shallow one with a gentle bed, understating depth.
4. **The most detailed-looking part of the picture is the part we know least about.** The shoreline is
   pinned at zero and the nearest real reading is often 30–40 ft away, with nothing measured between —
   so contours crowd into exactly the band with no data. Inherent to the method.

---

## The next thing to try: drop the small rings

Chapter 3.5 measured something useful even though it falsified its own hypothesis: **noise appears as
small closed rings.** Not open stubs — small rings.

Which suggests a different move than everything we tried. Every idea in Chapter 3 was a **gate**: a
pass/fail on the whole lake. That framing is what kept costing us Champlain, because any per-lake
threshold has to be simultaneously right for a farm pond and a 174 km lake.

**Don't gate the lake. Remove the noise pieces.**

Contours are traced as separate pieces anyway. Drop the ones below some real-world size and keep the
rest. Champlain keeps every one of its ~1,300 m basin rings and loses only its specks; Beddington loses
most of its wobbles and keeps whatever is real. **There is no threshold that can cost us a whole
lake** — which is the property every previous attempt lacked.

Open questions before believing any of this:

- **What size?** Absolute metres, or relative to the lake? Both have obvious failure modes and I'd
  measure rather than reason.
- **Does it hurt genuinely small features?** A small deep hole in a big lake is a small ring, and it's
  real. This is the risk, and it's the same "understating by omission" trap as Chapter 4.3.
- **Is it cleanup or is it lying?** Removing a piece the fit produced is a cartographic judgement.
  Removing a wobble is honest; removing a real feature because it's small is not, and the line between
  them is exactly what needs looking at.

**It will be settled the way everything that stuck here was settled: render a grid and look at it.**

---

## The five lessons, if you read nothing else

1. **Every input-side metric we invented failed to predict output quality.** Five for five —
   nearest-neighbour spacing, the coverage ratio's premise, shore share, fragment count, closure. If
   you find yourself computing a number about the *inputs* and expecting it to tell you whether the
   *picture* is good, that has not once worked here.
2. **Render it. Every single failure above was invisible in code review and obvious in an image.** The
   test suite was green through all of them.
3. **A threshold is calibrated against its denominator.** Change one and you must re-derive the other,
   or you've silently retuned the system while believing you fixed a bug.
4. **Check your units before drawing a conclusion.** One comparison in grid cells rather than metres
   produced a conclusion that was exactly backwards.
5. **The most legible version of a map is often the most misleading one.** A green→yellow→red depth
   ramp would be far easier to read than our single-hue one — and would read as a *danger scale*,
   reintroducing through colour a claim we deliberately refuse to make in words. Legibility is not
   automatically the thing to optimise.
