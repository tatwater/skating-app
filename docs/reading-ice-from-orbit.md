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

## Orientation: nine words

| Word | What it means here |
| --- | --- |
| **pass / granule** | One satellite flyover, cut into a rectangular chunk of ground. A granule is the unit we fetch, process and store. One covers roughly 110 km square. |
| **band** | One slice of the spectrum the camera records — blue, green, red, infrared, and so on. A satellite "photo" is really a stack of separate greyscale images, one per band. |
| **optical** | A camera. Records sunlight bouncing off the ground. Needs daylight and a clear sky. |
| **radar / SAR** | Sends its own microwave pulse down and listens for the echo. Brings its own light, so it works at night and straight through cloud. |
| **backscatter** | How much of the radar pulse came back. **This is a measure of texture, not colour** — the single most important idea in the radar half of this document. |
| **polarisation** | Which way the radar pulse is oriented going down (V or H) and coming back. `VH` means sent vertical, received horizontal. |
| **SCL** | *Scene Classification Layer.* A free per-pixel label — "this pixel is water / cloud / snow" — that the European Space Agency computes and ships with every optical scene. |
| **NDSI** | *Normalised Difference Snow Index.* An arithmetic trick for telling snow from cloud, which colour alone cannot do. |
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
two in the morning. Also ~10 m, also every few days.

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
through visible colour, into near-infrared, and out to **shortwave infrared (SWIR)** at 1.6 and
2.2 microns, well past anything an eye can see.

We fetch two of them.

| Asset | What it is | What we do with it |
| --- | --- | --- |
| **`visual`** | Red, green and blue combined into an ordinary-looking colour picture | **This is the only thing a skater ever sees.** Everything else is machinery. |
| **`scl`** | ESA's per-pixel classification — see Chapter 3 | Never displayed. We compute per-lake statistics from it and throw the image away. |

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
where SCL is weakest, and true colour cannot do this at all. But it is a *snow* index, built on the
same brightness that black ice does not have. It would agree with SCL for the same reason.

**So a freeze-up alert built on optical alone would fire late, and would miss the black-ice window
entirely** — the best skating of the year, and the reason anyone opens the app in December.

---

## Chapter 5: Radar sees texture, and that changes everything

Radar does not measure colour or brightness. It fires a pulse at the ground and measures **how much
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

And there was an accidental control group. **Lake Champlain barely freezes** — it is enormous and
deep — and its `VH` reading stayed flat all winter (0.2–0.5 dB), while the small lakes around it moved
2 dB. The lake that doesn't freeze doesn't move. That is about as clean a natural experiment as
observational data offers.

### Did radar see what optical missed?

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

| | true colour | SCL | NDSI | radar `VH` |
| --- | --- | --- | --- | --- |
| **Open water** | dark | water | low | dark if calm, bright if windy |
| **Black ice** | dark — *looks like water* | **water** ⚠ | low ⚠ | dark |
| **Snow-covered ice** | white | snow/ice | high | brighter |
| **Cloud** | white — *looks like snow* | cloud | **low** ✅ | invisible — passes straight through ✅ |
| **Shadow** | dark | cast/cloud shadow | — | unaffected ✅ |

Read the columns and the division of labour falls out:

- **Optical answers "is there snow on it?"** reliably, and is defeated by cloud maybe 75% of the time.
- **NDSI's one job** is separating snow from cloud, which true colour genuinely cannot do — both are
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

**What that costs:** one winter is 4,485 machines, about **1.7 hours** wall-clock and roughly
**$1.46**, producing ~19 GB.

### What we keep, and what we deliberately don't

| Kept | Discarded |
| --- | --- |
| The masked colour picture, per pass | The raw scenes — re-readable free, forever |
| Per-lake numbers, per pass | The other ten bands |
| Where the satellite actually had pixels | The SCL image itself (the numbers survive) |

**Why not keep the raw scenes?** It would cost roughly $9–18 a month *per season, forever*, to insure
against Amazon deleting a public archive — and re-reading is free. The numbers are the expensive part,
because recomputing them means touching all 4,485 passes again.

---

## Chapter 8: Which data answers which question

**For showing a skater a picture: true colour, and nothing else.** Every other product here is an
input to a calculation, not something to look at.

**For "when did this lake freeze / thaw":**

| Source | Sees | Catch |
| --- | --- | --- |
| Weather (observed overnight lows) | when to *start looking* | says nothing about a specific lake |
| Optical `snowIcePct` | snow-covered ice, confidently | ⚠ misses black ice; blocked by cloud ~75% of the time |
| Radar `VH` | a change in surface texture | needs calibration to combine satellites; calm water mimics ice |

**And a date from any of them is a bracket, not a point.** With cloud knocking out three passes in
four, we get 11–12 usable optical frames per lake per winter. Morey's freeze-up sits in a **30-day
gap**; both lakes' ice-out sits in a 15-day gap. So the honest claim is never *"it froze on the 14th"*
but *"open water observed 22 Nov, fully frozen observed 22 Dec."* The app is designed to say the second
thing, and the phrasing is load-bearing rather than modest.

---

## Chapter 9: ⚠ One number for a whole lake, when a lake isn't one thing

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

The app already has a mechanism for this: lakes can be divided into **sub-areas** (bays, arms, basins),
which were built for naming rather than for ice. Narrows and bridges are exactly where a lake stops
behaving as one body — they are where flow concentrates, where ice forms last, and where local
knowledge says "the north end goes first."

**This is an open design question, not a decision.** Splitting bodies at bridges and narrows would
make the freeze-up series far more useful and would make every statistic here more expensive and more
complicated. It is recorded here because the winter's data and the founder's skate log independently
pointed at the same seam.

---

## What to take away

1. **Optical and radar answer different questions.** One sees colour and is blinded by cloud; the
   other sees texture and works in the dark. Neither is a substitute for the other.
2. **Our ice measurement is really a snow measurement.** It is honest and useful and it misses black
   ice, which is the ice worth driving to.
3. **Radar is the only candidate for catching black ice**, and making it work means calibrating the
   satellites against each other so their readings can be pooled.
4. **A date from space is always a bracket.** Cloud decides how wide.
5. **Nothing here sees thickness, and nothing here is a safety judgement.** The app reports what an
   instrument recorded on a date. Whether ice will hold you is a question for the ice, and for you,
   standing on the shore.

---

### Related reading

- [`docs/on-ice-alerts.md`](./on-ice-alerts.md) — what happens once you're actually out there
- [`docs/water-body-data.md`](./water-body-data.md) — where the lake outlines come from
- [`docs/weather-since.md`](./weather-since.md) — how observed weather ages a report
- [`plans/phase-N6e-satellite-imagery.md`](../plans/phase-N6e-satellite-imagery.md) — build notes
- [`plans/PR2-HANDOFF-2.md`](../plans/PR2-HANDOFF-2.md) — measurements, in detail
