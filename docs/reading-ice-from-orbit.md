# Reading ice from orbit: what satellites can and cannot see

How the app knows anything about a frozen lake it has never visited — where the pictures come from,
what the machine is actually measuring, and the several things it confidently gets wrong.

> **Who this is for.** Anyone touching the imagery pipeline; anyone looking at a date on the freeze-up
> scrubber and wondering how much to trust it; and any skater curious why the app says what it says.
> **No remote-sensing knowledge assumed.** Build notes:
> [`plans/phase-N6e-satellite-imagery.md`](../plans/phase-N6e-satellite-imagery.md).

**The one-sentence version:** two European satellites fly over every few days — one carries a camera,
one carries radar — and between them we can usually tell whether a lake is open or frozen, except in
the one case skaters care about most, which is the case this document spends the most time on.

---

## Orientation: ten words

| Word | What it means here |
| --- | --- |
| **pass / granule** | One satellite flyover, cut into a rectangular chunk of ground. A granule is the unit we fetch, process and store. One covers roughly 110 km square. |
| **band** | One slice of the spectrum the camera records — blue, green, red, infrared, and so on. A satellite "photo" is really a stack of separate greyscale images, one per band. |
| **optical** | A camera. Records sunlight bouncing off the ground. Needs daylight and a clear sky. |
| **radar / SAR** | Sends its own microwave pulse down and listens for the echo. Brings its own light, so it works at night and straight through cloud. |
| **backscatter** | How much of the radar pulse came back. **This is a measure of texture, not color** — the single most important idea in the radar half of this document. |
| **polarisation** | Which way the radar pulse is oriented going down (V or H) and coming back. `VH` means sent vertical, received horizontal. |
| **`sigma0`** | Backscatter as a physical number, in decibels, after correcting for how the instrument saw it. A raw radar file does *not* contain this — see Chapter 5. |
| **SCL** | *Scene Classification Layer.* A free per-pixel label — "this pixel is water / cloud / snow" — that the European Space Agency computes and ships with every optical scene. |
| **NDSI** | *Normalised Difference Snow Index.* An arithmetic trick for telling snow from cloud, which color alone cannot do. |
| **black ice** | Clear, new ice you can see the lake bottom through. The good stuff. Also, as we'll see, nearly invisible from space. |

---

## Chapter 1: Two satellites, two completely different senses

Everything here comes from **Copernicus**, the European Union's Earth-observation programme. It is
free, it is open, and the archive goes back years. We use two of its missions and ignore the rest.

**Sentinel-2 is a camera.** Two spacecraft (now three) in the same orbit, photographing the planet in
daylight at **10 metres per pixel**. At our latitude, some patch of ground gets photographed every
2–4 days. Over one tile covering Lake Morey and Mascoma Lake, winter 2025-26 gave us **45 passes**.

**Sentinel-1 is radar.** It transmits a microwave pulse and measures the echo. Because it makes its
own illumination it does not care about darkness or cloud — it sees a lake in a January blizzard at
two in the morning. Also ~10 m per pixel.

⚠ **But the radar constellation has a hole in its history.** Each spacecraft revisits every 12 days,
so it takes two to get a 6-day cadence — and **S1B failed in December 2021 while S1C did not launch
until December 2024**. Winter 2025-26 has two satellites flying; the winters in between have one. Any
look further back than last year gets half the radar coverage, which bears directly on whether older
seasons are worth processing at all.

**What we ignore, and why.** Sentinel-3 sees at 300 m per pixel, which makes a 200-hectare lake about
three pixels across — not a lake, a smudge. Sentinel-5P measures atmospheric gases. Neither can tell
you anything about ice. **There is no third option we are leaving on the table.**

> ### ⚠ Sentinel-1 has one radar band, not several
>
> Worth saying plainly, because "let's get all the radar bands" is the natural way to think about it
> and it is not how the instrument works. Sentinel-1 is a **single C-band radar** — one frequency,
> 5.405 GHz, a wavelength of about 5.6 cm. What varies between passes is *polarisation*, which is the
> orientation of the pulse, not a different band.
>
> Copernicus flies no other radar. Once Sentinel-1 is wired in, **the radar story is complete** — there
> is no L-band or X-band mission waiting to be added later.

---

## Chapter 2: Thirteen bands, and the two we actually keep

A Sentinel-2 scene is thirteen separate images — twelve in the processed product we use, since the
cirrus band is consumed by atmospheric correction and not republished. They range from deep blue
through visible color, into near-infrared, and out to **shortwave infrared (SWIR)** at 1.6 and
2.2 microns, well past anything an eye can see.

We fetch two of them.

| Asset | What it is | What we do with it |
| --- | --- | --- |
| **`visual`** | Red, green and blue combined into an ordinary-looking color picture | **This is the only thing a skater ever sees.** Everything else is machinery. |
| **`scl`** | ESA's per-pixel classification — see Chapter 3 | Two uses. The per-lake statistics are the valuable half and always run. The image itself is also published, so a curious skater can switch to it and see what a claim was derived *from* — the honest reason to offer a band selector at all. It costs roughly a quarter again in processing. |

**Everything else we read past and discard**, including the green and SWIR pair that makes NDSI
(Chapter 4). That sounds wasteful and mostly isn't: the raw pixels live on Amazon's servers for free,
forever, and we can re-read any granule any time. What is *not* cheap to redo is a statistic computed
across 4,485 granules — that costs a full re-run of the season.

So the rule we settled on is: **keep the picture, keep the numbers, discard the intermediate images.**

---

## Chapter 3: SCL — a free opinion about every pixel

The single most useful thing in a Sentinel-2 product isn't a band at all. **ESA runs its own
classifier over every scene and ships the result**, labelling each pixel with one of twelve
categories:

| | | | |
| --- | --- | --- | --- |
| 0 no data | 3 cloud shadow | 6 **water** | 9 cloud, high probability |
| 1 saturated / defective | 4 vegetation | 7 unclassified | 10 thin cirrus |
| 2 cast shadow | 5 not vegetated | 8 cloud, medium probability | 11 **snow / ice** |

From those we compute four numbers **for every lake in every pass**, and the definitions matter more
than they look:

- **`coveragePct`** — how much of this lake the pass actually reached. A lake straddling the edge of a
  granule appears in two passes and neither is wrong; this is what says which saw how much.
- **`clearPct`** — of the pixels we could see, how many were unobscured. Cloud, cloud shadow and
  terrain shadow all count as obscured. A lake in deep shadow is technically visible and completely
  unreadable, so calling it "clear" would flatter exactly the frames that are least useful.
- **`snowIcePct`** — the fraction SCL called snow/ice. Named for what it measures, not for what a
  reader hopes it measures — see "What follows from that" below.
- **`waterPct`** — the fraction SCL called water.

**Two deliberate choices worth knowing.** A lake we could not see at all reports `null`, never zero —
*"we couldn't look"* and *"we looked and saw no ice"* are different claims and collapsing them would
quietly invent data. And `snowIcePct`/`waterPct` are both measured against the same denominator rather
than against each other, so a lake 90% hidden by cloud can't report the same confident-looking number
as one in full view.

---

## Chapter 4: ⚠ The surprise — black ice reads as *water*

This is the most important thing in this document, and we found it by accident, from one skater's
Strava history.

**The measurement.** On 22 December 2025 both Lake Morey and Mascoma Lake were almost cloud-free. Our
pipeline reported:

| | clear | ice | water |
| --- | --- | --- | --- |
| **Lake Morey** (VT) | 85% | **45.2%** | 28.6% |
| **Mascoma Lake** (NH) | 98% | **2.3%** | **82.5%** |

**The ground truth.** The founder had been skating Mascoma since **10 December**, and skated the full
length of it — both sides of the bridge — on **23 December**, the day after that satellite pass.

So the satellite looked straight down at a lake somebody skated the next morning and called it
**82.5% water**.

### Why

**Black ice is transparent.** New ice, formed on a calm night without snow, is clear enough to read
the bottom through. From above, the light coming back is light that went *through* the ice, bounced
off dark water and lake bed, and came back — which is, spectrally, almost exactly what open water
looks like. It is dark in visible light and dark in infrared.

SCL's snow/ice class is built to find **bright** frozen surfaces — snow, and the white opaque ice that
forms once snow lands and refreezes. Black ice has none of that brightness, so the classifier does the
reasonable thing and calls it water.

And the contrast with Morey on the same day is the proof, because it comes with its own explanation.
The founder's note: *"my first skate on Morey was January 9, but I think that was probably because I
missed getting on it before the first snow fell."* Morey had **snow on its ice by 22 December**, which
is precisely why the satellite could see it. Two lakes, thirty kilometres apart, same day, same
sky — and the one with snow on it read 45% ice while the one with perfect skating ice read 2%.

### What follows from that

**`snowIcePct` is a snow-cover index, not an ice index.** It is a perfectly good measurement; it is
just not measuring the thing a reader hopes it measures, in exactly the case skaters care about most.
It was called `icePct` until 2026-08-25, and the rename is the smallest honest fix available: frames
cut before then still carry the old key, so a reader wants `snowIcePct ?? icePct`.

**NDSI would not rescue this.** NDSI is the standard trick for separating snow from cloud: snow is
bright in green and very dark in shortwave infrared, cloud is bright in both, so

```
NDSI = (green − SWIR) / (green + SWIR)
```

is high for snow and low for cloud. It is genuinely worth having — it is an independent second opinion
where SCL is weakest, and true color cannot do this at all. But it is a *snow* index, built on the
same brightness that black ice does not have. It would agree with SCL for the same reason.

**So a freeze-up alert built on optical alone would fire late, and would miss the black-ice window
entirely** — the best skating of the year, and the reason anyone opens the app in December.

---

## Chapter 5: Radar sees texture, and that changes everything

Radar does not measure color or brightness. It fires a pulse at the ground and measures **how much
comes back**, and that depends almost entirely on how *rough* the surface is at the scale of the
wavelength — about 5.6 cm.

- A **smooth** surface acts like a mirror: the pulse glances off away from the satellite, and almost
  nothing returns. **Smooth reads dark.**
- A **rough** surface scatters in all directions, including back up. **Rough reads bright.**

Which gives, roughly:

| Surface | Radar | Because |
| --- | --- | --- |
| Calm open water | dark | mirror-flat |
| Wind-roughened water | bright | little waves scatter |
| Smooth new ice | dark | mirror-flat again |
| Snow-covered or rough ice | brighter | the pulse penetrates and bounces around inside |

**The catch is right there in the table:** calm water and smooth ice both read dark. That is a real
limitation and it is the reason radar is not a magic answer.

### Polarisation, and why VH is the useful one

The radar can send its pulse oriented vertically or horizontally, and listen in either orientation.
`VV` is sent and received vertical; `VH` is sent vertical, received horizontal.

A flat mirror-like bounce preserves orientation, so it comes back as `VV`. Getting energy into `VH`
requires the pulse to **bounce around inside something** — which ice, with its air bubbles and layers,
does and open water does not. That makes the cross-polarised `VH` channel the more informative one.

**Measured, over one winter:** on lakes that actually freeze, `VH` separates open water from midwinter
ice by about **2 dB**, while `VV` manages only 0.6–0.8 dB. Replicated independently on two different
satellites.

### ⚠ Calibration, and why skipping it would have quietly ruined everything

**A Sentinel-1 product does not contain backscatter.** It contains detector counts — digital
numbers — and turning those into the physical quantity needs a per-pixel gain that ships alongside the
scene:

```
sigma0 = DN² / A²        in decibels:        dB = 20·log10(DN) − 20·log10(A)
```

**`A` is not a constant**, because the radar looks at the near edge and the far edge of its swath from
very different angles. Measured on a real scene, `A` runs from 558.4 to 663.4 — a spread of
**1.50 dB across a single image**.

Set that beside the thing we are trying to detect. Open water separates from midwinter ice by about
**2 dB**. So an uncalibrated pass carries a gradient nearly as large as the entire signal, and two
lakes at opposite edges of the same image are being measured on different scales. That does not look
like a bug: it looks like lakes on one side of the region behaving differently from lakes on the other,
which is the kind of pattern that gets *explained* rather than debugged.

The same problem appears again between spacecraft. Uncalibrated, S1A reads **+1.01 dB (VV)** and
**+2.17 dB (VH)** above S1C on the same track — for VH, an offset larger than the signal itself.

**So the pipeline calibrates every pass before it measures anything.** The gain is published on a
sparse grid in radar geometry (27 × 649 for a 432-megapixel scene), so it is written out at its own
tiny resolution with ground-control points attached and projected onto the imagery grid, where the
division happens. It is a smooth function of range, so nothing is lost by interpolating it.

### ⚠ Calibration helps a great deal and is not enough

Removing the cross-platform offset is what *would* let two satellites be read as one series — the
difference between a ~12-day and a ~6-day look at a lake, which is most of radar's value. So it is
worth knowing how much of the offset calibration actually removes.

**Measured 2026-08-25** across all 503 radar passes of winter 2025-26, comparing the *same lake* seen
by two satellites about a day apart, in the same flight direction — 53,486 such comparisons over 8,789
lakes:

| comparison | VV | VH |
| --- | --- | --- |
| S1A − S1C, **all pairs pooled** | −0.15 dB | **−0.03 dB** |
| S1A − S1C, ascending only | −0.64 dB | **−0.52 dB** |
| S1A − S1C, descending only | +1.20 dB | **+1.53 dB** |
| S1A − S1D, **7 minutes apart** | +0.83 dB | **+0.99 dB** |

**Read the first row and you would conclude calibration works perfectly. It is the most misleading
number in this document** — the pooled figure is near zero because two opposite biases cancel, and
splitting by flight direction shows a 2 dB spread hiding inside it. That is the whole signal, disguised
as agreement.

**And the problem localises.** Comparing each satellite *against itself* across flight directions — same
instrument, same calibration, so any gap is viewing geometry — S1A is consistent to **+0.19 dB** while
S1C disagrees with itself by **+1.18 dB**. So this is not a general geometry effect that every
spacecraft shares; something is off about S1C specifically.

The S1D comparison is the cleanest control available: seven minutes apart, so the ice cannot have
changed, and still about **1 dB** apart.

**What follows:** calibration removes most of the gross offset — the uncalibrated VH gap was +2.17 dB —
but **0.5 to 1.5 dB survives, against a signal of about 2 dB.** Pooling satellites would import an
error the size of the thing being measured, so the pipeline keeps `platform` and `orbitDirection` as
filters and a time series stays within one satellite and one flight direction. **The 6-day cadence is
not available yet**, and getting it means understanding S1C rather than adding more passes.

*Caveats, because this was measured from stored statistics rather than a controlled radiometric study:
the satellites' ground tracks are not held constant, so incidence angle varies within each comparison;
S1C contributed about a quarter as many passes as S1A; and nothing here says which satellite is
**right**, only that they disagree.*

And there was an accidental control group. **Lake Champlain barely freezes** — it is enormous and
deep — and its `VH` reading stayed flat all winter (0.2–0.5 dB), while the small lakes around it moved
2 dB. The lake that doesn't freeze doesn't move. That is about as clean a natural experiment as
observational data offers.

### ⚠ The radar was also in the wrong place

A radar image does not arrive with a map position attached. It arrives with a set of reference points,
worked out by assuming the ground sits at one particular height. Anything higher or lower than that
assumption gets drawn **sideways** — about 140 metres out of place for every 100 metres of height
error.

Sentinel-1 looks out to one side, so a rising pass views a lake from one direction and a falling pass
from the other, and **the error flips between them**. A skater watching the timeline caught this before
any measurement did: two islands in Mascoma appeared to jump east, then west, then east again as the
dates advanced.

The fix is easier for lakes than for land, because a lake is flat and we already know its elevation:
the whole correction collapses to sliding each lake's pixels back into place. Two things had to be got
right, and neither was obvious.

**The height has to be the local one.** A pass covers 250 km, and averaging the terrain across all of
it gives a number describing what the satellite flew over rather than where any lake sits — measured
across five real passes, that average ranged from **8 metres** (mostly ocean) to **370 metres** (the
White Mountains). Correcting with the average was *worse than not correcting at all*. Using each
lake's own local reference instead cut the error from 116 m to 42 m.

**And the direction is easy to get exactly backwards**, which doubles the error rather than removing
it, while still producing a perfectly plausible-looking number. It was settled by measurement, not
argument: two passes over Mascoma 24 hours apart, one rising and one falling.

The payoff is not just tidier pictures. Because rising and falling passes now agree about where a lake
is, they can be read as one series — **which doubles how often we get to look at a lake.**

*The largest correction in our region belongs to Upper Lake of the Clouds, on Mount Washington at 1,531
metres: its pixels were landing about a kilometre from the lake.*

### ⚠ The radar has a floor, and lakes are sitting on it

Calibration turns detector counts into a physical brightness. It does **not** remove the instrument's
own electrical noise, which every radar has and which sets a hard limit on how dark a thing it can
report. That limit has a name — **NESZ**, the brightness the sensor reads back from a target returning
nothing at all — and Sentinel-1 publishes it, per pass, in a file alongside the calibration one.

Until 2026-08-25 nothing in this pipeline opened that file.

```
S1A    noise floor, VH    median −25.2 dB
S1C    noise floor, VH    median −28.0 dB
```

**Our lakes measure about −24.3 dB.** So the surface of a frozen lake is roughly *one decibel* above
the level at which the instrument stops being able to tell it from static — and on **38%** of lakes it
is genuinely below that level.

That sounds like a catastrophe and it is not, for a reason worth understanding. The noise is a known
quantity, so it can be subtracted, and a target below the floor is recovered correctly *on average*.
What averaging cannot do is rescue any **single pixel**:

| the question | how well we can answer it |
| --- | --- |
| *"how bright was this whole lake?"* | well — about ±0.5 dB, because hundreds of pixels average out |
| *"how bright was **this one pixel**?"* | badly — about ±3–4 dB near the floor |

**That distinction decides what radar can and cannot be used for here.** Watching a whole lake darken
as it freezes is a whole-lake measurement, and it works. Pointing at one corner of a lake and calling
it glassy is a per-pixel measurement, and at these levels it would be reading the instrument rather
than the ice. It is the reason the black-ice idea is still research and not a feature.

**How we know the floor is right rather than over-corrected.** The obvious worry about "38% below the
floor" is that we are subtracting too much. Three checks say otherwise: almost no lakes collapse to
nothing (2 out of 2,578); the spread of results stays wide rather than piling up at the bottom; and
**large lakes sit closer to the floor than small ones**, which is the opposite of what a measurement
error would do. Big open water really is that dark to radar.

*Every lake now carries its own floor in the archive, because the floor moves across a swath and
between satellites. A claim like "40% of this lake was below −22 dB" means nothing until you know
whether that lake's floor was −25 or −22.*

### Did radar see what optical missed?

*These are the numbers from the exploratory spike that decided radar was worth building — **raw
detector counts, before the calibration described above existed**. They are held to one satellite and
one orbit direction, which is what made them comparable at all. The production pipeline emits
calibrated `sigma0` in decibels; these are kept because they are what the decision was made on.*

Over Morey and Mascoma specifically, holding satellite and orbit direction constant so the numbers are
comparable:

```
2025-11-09    33.7    33.5      open water
2025-12-03    32.5    32.4      ← drop
2025-12-27    32.3    32.2
2026-01-20    32.5    32.3
2026-02-13    33.2    33.0
```

**The drop happens between 9 November and 3 December, on both lakes** — and the founder first skated
Mascoma on 10 December. Radar registered a change during the freeze-up; the optical pipeline still
called Mascoma 82.5% water three weeks later.

**Stated honestly:** six passes on one track is a small sample, the numbers are uncalibrated, and a
drop of 1.3 dB is consistent with the lake freezing *and* with November simply being windier than
December. It is suggestive and it points the right way. It is not yet proof.

---

## Chapter 6: Telling the five things apart

The whole problem, in one table. **Nothing in the right-hand column is easy.**

| | true color | SCL | NDSI | radar `VH` |
| --- | --- | --- | --- | --- |
| **Open water** | dark | water | low | dark if calm, bright if windy |
| **Black ice** | dark — *looks like water* | **water** ⚠ | low ⚠ | dark |
| **Snow-covered ice** | white | snow/ice | high | brighter |
| **Cloud** | white — *looks like snow* | cloud | **low** ✅ | invisible — passes straight through ✅ |
| **Shadow** | dark | cast/cloud shadow | — | unaffected ✅ |

Read the columns and the division of labour falls out:

- **Optical answers "is there snow on it?"** reliably, and is defeated by cloud maybe 75% of the time.
- **NDSI's one job** is separating snow from cloud, which true color genuinely cannot do — both are
  white.
- **Radar's one job** is seeing through weather and detecting smoothness. It is the only column with a
  chance of catching black ice.
- **Nothing here measures thickness.** Not one of these can tell you whether ice will hold you. That
  is not a gap we plan to close; it is a property of looking at a lake from 700 km up.

---

## Chapter 7: How the data actually gets here

1. **Ask the catalogue.** A public index (STAC, hosted by Amazon) answers "which passes covered this
   box between these dates" — free, and before any computing happens.
2. **Skip empty ground.** Roughly half the passes returned cover only ocean, Québec or ground where we
   hold no lakes. We test each map tile once against our lake outlines and drop those, which removes
   about half the work while discarding nothing.
3. **Rent a machine per pass.** Each surviving pass gets a temporary cloud machine that lives ~70
   seconds and then destroys itself.
4. **Read only what's needed.** The source files support range requests, so we read the window over
   the lakes rather than downloading a whole scene.
5. **Cut to the lakes.** Everything outside a lake plus a 240 m margin is made transparent, with a
   soft edge so it doesn't look stamped out.
6. **Measure, then throw the working files away.** Per-lake statistics go into a small text record;
   the picture becomes a map layer.

**What that costs:** one winter of *optical* is 4,485 machines, about **1.7 hours** wall-clock and
roughly **$1.46**, producing ~19 GB.

### The radar path is not a variation on that one

Steps 1–4 are shared — same catalogue, same tile prefilter, same rented machine, same range reads,
though a different collection with a different id grammar and different metadata. **After that the two
pipelines diverge completely**, because a radar pass is not a picture:

- **Calibrate first.** The gain raster is built from the scene's own annotation and projected onto the
  imagery grid (see Chapter 5). Nothing is measured before this happens.
- **Measure both polarisations, render one.** `VV` and `VH` are both reduced to per-lake `sigma0`, but
  only `VH` becomes an image — it is the informative channel, and publishing both would put a frame in
  the archive that nothing looks at.
- **⚠ The grey scale is fixed, not per-scene.** −30 dB to 0 dB on every frame in every season. A
  per-scene stretch would make each individual frame look its best and **destroy the archive's only
  purpose**: a lake that darkened by 2 dB on freezing would be re-brightened by the stretch, and the
  between-date change the scrubber exists to show would vanish into the rendering.
- **The picture is never the measurement.** Nothing reads numbers back out of the grey; the full-precision
  `sigma0` was recorded before anything was squeezed into eight bits.

### What we keep, and what we deliberately don't

| Kept | Discarded |
| --- | --- |
| The masked color picture, per optical pass | The raw scenes — re-readable free, forever |
| The `VH` grey image, per radar pass | The nine optical bands `visual` doesn't use |
| Per-lake numbers, per pass — `clearPct`, `snowIcePct`, `waterPct`, `vvDb`, `vhDb`, `coveragePct` | The `VV` image (its number survives) |
| The SCL classification image, per optical pass | Every working file in between — warps, masks, distance ramps |
| Where the satellite actually had pixels | |
| For radar: which satellite, and which way it was flying | |

**Why keep which satellite and which direction?** Because a radar reading is only comparable to another
taken from the same geometry, so those fields are what make a time series a time series rather than a
pile of numbers from different vantage points.

### When we look at all, and which winter you're seeing

**We skip roughly half the year.** There is nothing to learn about ice in July, and every pass we do
not fetch is compute we do not pay for. So ingest is opened by *weather*, not by a calendar:

- From **1 October**, a daily job samples **observed overnight lows** — what actually happened, never
  a forecast — across the corpus.
- The season opens when a broad across-corpus freezing signal appears, **or** when one specific pond
  freezes: **Upper Lake of the Clouds**, a one-acre tarn at 1,531 m in the White Mountains that the
  skating community already treats as the season opener. It freezes weeks before anything in the
  valleys.
- **`OR`, never `AND`.** A gap in one weather series must not be able to stall a whole region's
  ingest.

⚠ **The pond is a *temperature* trigger, not an imagery one, and that distinction is what makes it
safe.** At one acre it is about 41 Sentinel pixels, nearly all of them shoreline-mixed — imagery could
never tell us when it froze. Reading a thermometer at a coordinate does not care how small the pond is.

The gate is deliberately generous, for the same asymmetry that runs through this whole document: an
over-eager gate wastes a few dollars of reads, while a late one **misses freeze-up entirely** — the
most valuable frame of the season, gone, with nothing to record that it was ever there. A warm autumn
can have us looking in October and finding nothing for six weeks, which is the cheap failure.

**And which winter you see is decided by a frame, not a date.** The scrubber shows the most recent
season that actually *has* frames — so last winter's stays live all summer, and the moment the first
frame of the new winter lands it flips, by itself. In a warm year it flips late, correctly, with
nobody adjusting anything.

**Why not keep the raw scenes?** It would cost roughly $9–18 a month *per season, forever*, to insure
against Amazon deleting a public archive — and re-reading is free. The numbers are the expensive part,
because recomputing them means touching all 4,485 passes again.

---

## Chapter 8: Which data answers which question

**For showing a skater a picture: true color, and nothing else.** Every other product here is an
input to a calculation, not something to look at.

**For "when did this lake freeze / thaw":**

| Source | Sees | Catch |
| --- | --- | --- |
| Weather (observed overnight lows) | when to *start looking* | says nothing about a specific lake |
| Optical `snowIcePct` | snow-covered ice, confidently | ⚠ misses black ice; blocked by cloud ~75% of the time |
| Radar `VH` | a change in surface texture | calm water mimics ice; readings only comparable within one satellite and one flight direction |

**And a date from any of them is a bracket, not a point.** With cloud knocking out three passes in
four, we get 11–12 usable optical frames per lake per winter. Morey's freeze-up sits in a **30-day
gap**; both lakes' ice-out sits in a 15-day gap. So the honest claim is never *"it froze on the 14th"*
but *"open water observed 22 Nov, fully frozen observed 22 Dec."* The app is designed to say the second
thing, and the phrasing is load-bearing rather than modest.

---

## Chapter 9: ⚠ Which pixels the number came from

Every figure in this document is an average. Two things decide what it means: **which pixels went
into it**, and **whether one number can describe the whole lake**. Both turned out to be wrong in ways
worth explaining.

### For two months, we were measuring the beach

The app draws satellite imagery in a shape — the lake, plus the walk in from the car park, each
widened by 60 metres so the shoreline and the path are actually visible. That shape exists for a good
reason: a photograph clipped exactly to the waterline is useless for working out where to park and how
to get down to the ice.

**The mistake was using that same shape to take the measurements.** So when the pipeline reported "82%
water", the area it averaged over was the lake *plus a 60-metre ring of its bank, plus its islands,
plus the trail and the car park*.

The error is not evenly spread, which is what made it hard to notice. A fixed-width ring around a big
lake is a rounding error; around a small pond it is most of the "lake". Measured across 40 real bodies
in our own corpus:

| body size | share of the measured area that was **not water** |
| --- | --- |
| over 100 acres | 23% |
| 10–100 acres | 47% |
| **under 10 acres** | **70%** |

The worst case was a 1.3-acre pond where **86%** of what we were calling the lake was dry land.

**For radar it was worse than a dilution — it was a swamp.** Forest is one of the brightest things a
radar can look at (the pulse rattles around inside the canopy and comes back strong), while smooth ice
and calm water are among the darkest. So a ring of trees does not blur the ice signal, it overwhelms
it. Correcting this moved the typical lake's radar reading by **3.67 dB** — against a freeze-up signal
of about 2 dB. **The contamination was larger than the thing being measured.**

Every number in this document from before 26 August 2026 was measured that way. The pipeline now keeps
two shapes: one for the picture, one for the measurement.

### And one number still cannot describe a whole lake

The founder's own account of last winter:

> *"I first skated on Mascoma Lake on December 10, but only N/NW of the bridge, because I don't think
> the south end was ready yet. It wasn't until Dec 23 that I was able to skate both the north and
> south sides."*

**Every number in this document is one figure for an entire lake.** Mascoma is 462 hectares with a
road bridge across a narrows near its middle, and for two weeks those two halves were in genuinely
different states — one skateable, one not.

Look at what our pipeline reported in January:

```
2026-01-11    ice 27%   water 65%
2026-01-16    ice 18%   water 69%
```

A partial number like that has at least two readings — *"the whole lake is patchy"* or *"one half is
frozen and the other isn't"* — and **we currently cannot tell them apart.** For a skater deciding
whether to drive there, those are completely different answers.

**So read every percentage in this document as a lake-wide average, and remember that a lake is not
obliged to behave like one surface.** Narrows and bridges are where that assumption breaks first: they
are where flow concentrates and where ice forms last, which is exactly what the skate log above
describes and what the January numbers are too coarse to show.

**Mascoma, at least, is now cut in two.** On 26 August 2026 the lake was split into *Mascoma North* and
*Mascoma South* along the line the road takes across the narrows — from the southern corner of the
peninsula to the far shore, a gap of just **90 metres** at the tightest point. North is 1.20 km²,
south is 3.43 km², and the two together account for every square metre of the lake.

That does not by itself produce two numbers — the measurement still has to be told to use the halves —
but it is the piece that had to exist first, and it exists for the one lake where somebody kept a
record precise enough to check the answer against.

*This is the first sub-area drawn for measurement rather than for naming. Whether the rest of the
corpus follows is a product question — see the build notes.*

---

## What to take away

1. **Optical and radar answer different questions.** One sees color and is blinded by cloud; the
   other sees texture and works in the dark. Neither is a substitute for the other.
2. **Our ice measurement is really a snow measurement.** It is honest and useful and it misses black
   ice, which is the ice worth driving to.
3. **Radar is the only candidate for catching black ice, and it is closer to its limits than it
   looked.** Calibration, noise removal and geometric correction all run on every pass now. What that
   revealed is that a frozen lake sits about a decibel above the level where the instrument stops
   being able to see it — fine for *"this whole lake darkened"*, not fine for *"that corner is
   glassy"*. Whether radar can **date** a freeze-up is still unproven.
4. **Check which pixels a number came from.** For two months these measurements included a 60-metre
   ring of shoreline, which was a rounding error on a big lake and 70% of the "lake" on a small one.
   Averages are only as good as the outline they were taken over.
5. **A date from space is always a bracket.** Cloud decides how wide.
6. **Nothing here sees thickness, and nothing here is a safety judgement.** The app reports what an
   instrument recorded on a date. Whether ice will hold you is a question for the ice, and for you,
   standing on the shore.

---

### Related reading

- [`docs/on-ice-alerts.md`](./on-ice-alerts.md) — what happens once you're actually out there
- [`docs/water-body-data.md`](./water-body-data.md) — where the lake outlines come from
- [`docs/weather-since.md`](./weather-since.md) — how observed weather ages a report
- [`plans/phase-N6e-satellite-imagery.md`](../plans/phase-N6e-satellite-imagery.md) — build notes
- [`scripts/imagery/README.md`](../scripts/imagery/README.md) — how the measurements were produced,
  and the traps that make a pipeline lie about them
