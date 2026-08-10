# Where the lakes come from

Every lake in this app is a **merged record**. Nobody publishes "the list of skateable water in the
Northeast" — so we build it, from four public catalogues that disagree with each other, and then we
enrich it from a dozen more.

This is the story of that pipeline: what we take in, how we decide two outlines are the same lake,
what we refuse and why, and — the part that matters most if you're standing on ice — **what we know
about your lake and what we're only guessing at**.

> **Who this is for.** Two audiences, deliberately. If you're a skater wondering why a pond you know
> isn't listed, or why the depth reads "estimated", the answers are here. If you're a developer
> meeting this repo, this is the map; the decision log is
> [`plans/01-decisions.md`](../plans/01-decisions.md) and the full engineering record is
> [`plans/phase-N7-unified-corpus.md`](../plans/phase-N7-unified-corpus.md).

**The corpus today: 24,953 water bodies across Vermont, New Hampshire, Maine, Massachusetts and
New York** (north of I-84).

---

## The mental model: claims, not sources

One idea carries the whole design.

**A catalogue does not tell us what a lake *is*. It makes a claim about it.** OpenStreetMap claims
this outline. USGS claims that name and this classification. The state's survey boat claims this
depth. Our record is *ours* — we mint the identifier, and every catalogue becomes a claim attached
to it.

That sounds like bookkeeping. It's the difference between a corpus that can improve and one that
can't:

- When two catalogues disagree about a shoreline, we can pick the better one **per lake** instead of
  picking a winner globally and living with it.
- When a new source arrives, it attaches to lakes that already exist rather than inserting duplicates
  beside them.
- When something is wrong, there's a record of *who said so*, so it can be overruled without
  guesswork.

The corollary is the rule that governs everything downstream:

> ### Merge first, filter once.
>
> Combine every catalogue's account of a lake into one record, **then** decide whether it belongs.

We learned that the hard way. An earlier build filtered each source *before* merging — and
OpenStreetMap's "this is a marsh" tag silently deleted **123 water bodies that USGS calls lakes**, 17
of them with official names. Neither source was wrong. Filtering early just meant one of them never
got a vote.

---

## Step 1 — The four catalogues

| Source | What it's good at | What it's bad at |
| --- | --- | --- |
| **OpenStreetMap** | Current. Volunteers fix a shoreline the week a dam changes. Rich local names. | Inconsistent. The same lake may be one shape, two overlapping shapes, or a shape plus a relation. |
| **USGS NHD** *(National Hydrography Dataset)* | Authoritative classification and federal IDs. Complete — it doesn't skip the pond nobody mapped. | **Frozen since 2023.** No longer updated. |
| **USGS 3DHP** | The modern replacement for NHD. | Measured against NHD over 7,878 lakes: **the same data**, zero meaningful disagreements. It's a re-publication, so it gets one vote, not two. |
| **USGS GNIS** *(Geographic Names)* | The official name of a place, and the ID that ties names together. | Points, not shapes. It can tell you a lake is called Beau Lake; it can't tell you where the shore is. |

They're archived byte-for-byte before anything reads them — checksummed, mirrored to cloud storage,
and never re-downloaded silently. Two of them can be refreshed annually; NHD can't, because it's
frozen. That asymmetry is why the pipeline is built to accept a *replacement* for NHD later without
re-plumbing anything.

### Why four sources and not one

Because the disagreements are the useful part. In Maine, OSM and NHD each draw about the same number
of lakes — and when we scored them against 2,359 lakes where we hold real depth soundings, they were
**a dead heat: 63% ties.** Neither is better. But they're better in *different places*, which is why
the choice is made per lake instead of once.

---

## Step 2 — Deciding two outlines are the same lake

This is the hardest problem in the pipeline, and it has no perfect answer.

We compare shapes by **how much they overlap** — technically the shared area divided by the combined
area. Two catalogues tracing the same shoreline typically land at 0.85–0.98. The measured median
disagreement on area between OSM and NHD is **2.4%**.

**The bar is 0.5: they share more area than they don't.** Below that, a pair is usually not "one lake
drawn twice" — it's a bay against its parent lake, a reservoir against the river that feeds it, or
two neighbours in a chain. A bay is typically well under 0.3 of its parent, so 0.5 refuses that class
cleanly.

Three refinements, each from a real failure:

**A shared official name lowers the bar to 0.3.** If two catalogues independently assert the same
GNIS place ID, that's two publishers agreeing this is the same named place — real evidence beyond the
geometry.

**One catalogue matched against *itself* needs 0.9.** OpenStreetMap sometimes publishes a lake twice
— once as a shape, once as a "relation" wrapping that shape. Cross-catalogue overlap is two
independent observers agreeing; same-catalogue overlap is one observer contradicting itself, and the
innocent explanations are at least as likely. So that bar is much higher, and anything below it goes
to a human instead of being merged automatically. When we added this check, **`Mud Pond Swamp` turned
out to be in the corpus twice.**

**When geometry can't separate two candidates, we refuse to pick.** A lake in a chain acquiring its
neighbour's identity is an error that's invisible afterwards.

### What happens to the ones we can't decide

They're **flagged, not merged, and not deleted**. About 300 overlapping pairs sit in a review queue
for a human to settle. That's deliberate: a wrong merge destroys information, while a duplicate is
merely untidy and can be fixed later.

---

## Step 3 — Best-of-both, field by field

Once a lake is one record, each field is chosen on its own merits.

- **The outline** comes from whichever catalogue draws it better *for that lake*.
- **The name** comes from the gazetteer where there is one, and every catalogue's spelling is kept
  alongside — so searching for a lake by the name your grandfather used still finds it.
- **The area is measured from the outline we actually store.** It is never the larger of two claims.
  A name is not an area, and a catalogue asserting "412 acres" doesn't override the shape on the map.

One case worth knowing about: **Beau Lake**, on the Maine–Québec border, merged at 2,457 acres
against Maine's published 1,788 — because OSM's outline swallowed a neighbouring pond. It's now drawn
from NHD at 1,871 acres. Whenever one catalogue's outline *contains a named bay that the other
excludes*, that's evidence the first one is drawn wrong, and we switch.

---

## Step 4 — What we refuse, and why

This is where a skater is most likely to disagree with us, so here's the whole rule.

From ~178,000 candidate groups, we keep **24,953**. Everything refused is named in a log — no silent
deletions.

| Rule | Kept | Why |
| --- | --- | --- |
| **Nothing under 1 acre** | — | Below this, automatic sources are mostly drainage ditches and farm ponds. |
| **1–5 acres: needs a name** | ✅ | A name is somebody caring enough to name it — the best cheap signal that a small pond matters. |
| **5+ acres** | ✅ | Everything. |
| **Unnamed wetland: needs 50 acres** | ✅ | See below. |
| **Salt water** | ❌ | Tidal water doesn't form reliable skating ice. |
| **Rivers and streams** | ❌ | …with an exception, below. |
| **New York south of I-84** | ❌ | Outside the region we claim to cover. |

### The wetland rule, and why it's the one we're least sure about

Wetland is 13% of Maine's water above the floor and **63% of New Hampshire's**. So how we treat it
isn't a detail — it's most of one state.

Named wetland gets in at 5 acres like anything else. **Unnamed** wetland needs 50, which keeps about
11% of that class and refuses 3,244 bodies.

We know area is the weaker signal here. A 60-acre round bog gets in where a 12-acre channel doesn't,
and the channel is the better skate. The honest reason we use it anyway: the better signal (the long
axis of the water) is a *derived* statistic, and a rule that depends on one splits into two
contradictory readings — an import must refuse a body whose axis is unknown, a cleanup must keep it,
and that disagreement is exactly how silent deletion happens.

**If we cut a pond you skate, that's the mechanism to fix it** — a specific request beats any
threshold, and it overrides every rule on this page.

### The exception that proves the rule

Rivers are refused — but **"deadwater", "stillwater" and "flowage" name still water**, and a
catalogue calling them rivers is describing the watershed, not the ice. 43 bodies are in the corpus
because a name overruled a classification. Debsconeag Deadwater and Nesowadnehunk Deadwater are real
places people skate.

The same care runs the other way: a naive keyword list would have deleted **Higley Flow**, a New York
state park, because "flow" sounds like moving water.

---

## Step 5 — The prune, and why it's separate

Importing and deleting are **different commands, and the deleting one is dry-run by default.**

The reason is a specific, embarrassing failure mode: a lake measured at 1.0001 acres by the import
and 0.9999 acres by the cleanup would be **added by every import and deleted by every cleanup,
forever**, with nothing to show for it but a row count that never settled. Both now read the same
number — the one the admission rule actually ran on.

Two more guards, both from real incidents:

- **A failed import can never be followed by a prune.** A load that lost a batch leaves ~150 real
  lakes unstamped, and a prune would read that as "these don't belong" and delete them.
- **A prune that would delete most of a page stops and says so.** A whole-corpus replacement is never
  what this is for; the expected deletion is the difference between two runs, which is a few percent.

There's also a subtler trap we hit and fixed: **importing never deletes.** When the merge decides two
records are one lake, the import writes the survivor — and leaves the other one sitting there. That's
now a separate, explicit step that folds the duplicate into the survivor, **moving every report,
track, favourite and hazard across rather than stranding them.** Nothing is ever hard-deleted; a link
to a retired duplicate still lands you on the right lake.

---

## Step 6 — What we know about your lake

Here's where coverage stops being a pipeline statistic and starts being what you see.

### Elevation — 99.5%

From **USGS 3DEP**, and **98.2% of it is 1-metre LiDAR**. Effectively solved.

We switched to it from a global 90-metre model partly for accuracy and partly because the old source
was a metered weather API that the app's own forecasts were competing with for quota. The archive is
stored, so re-deriving anything from it costs minutes and no requests.

### Depth — 24% of all bodies, but that number is misleading

The honest breakdown, because one percentage hides the whole story:

| Lake size | We have a depth for |
| --- | --- |
| Over 1,000 acres | **90%** |
| 250–1,000 acres | **90%** |
| 100–250 acres | **88%** |
| 50–100 acres | **83%** |
| 25–50 acres | 56% |
| 10–25 acres | 20% |
| Under 10 acres | ~6% |

**Above 50 acres, we know the depth of five lakes in six.** Below 25 acres, we usually don't — and
that is not a bug we can fix by trying harder.

Every global depth dataset has a floor of about 25 acres. Beneath it, no source exists. We tested
whether our matching was losing lakes the sources *do* cover, by checking all 40,260 source records
against every outline we hold: **our stored coverage tracks what the sources actually reach to within
1–2 percentage points in every size band.** The matching is essentially lossless. The gap is that
nobody surveyed those ponds.

**Where the depth comes from matters as much as whether we have it**, so every measurement carries
its source, and they're ranked:

1. **A moderator's entry** — read off a published chart or local knowledge. Beats everything.
2. **A state agency survey** — someone in a boat with a depth sounder. 3,033 measurements.
3. **NYSDEC CSLAP** — volunteers, sampling New York lakes through 2024.
4. **LAGOS-US** — observed depths compiled from ~65 monitoring programmes.
5. **The Adirondack Lakes Survey** — 1,345 ponds sounded in 1984–87. Real measurements, four decades
   old, so they beat every model and lose to every newer measurement.
6. **HydroLAKES / GLOBathy** — *modelled*. A statistical estimate from shoreline shape, area and
   elevation, validated against 1,503 lakes **globally**.

**81% of the depths we show are measured rather than modelled.** A modelled depth is a perfectly good
hint that a lake is deep enough to be slow to freeze; it is not a number to plan a route on, and the
app never displays it as though it were.

### Bathymetry — 2,287 lakes have contour lines

Depth contours you can see in the lake view, from state agency surveys in Maine, New Hampshire,
Massachusetts and Vermont.

Two things to know:

**New York has no statewide bathymetry source.** It's the layer's largest geographic gap and it isn't
one we can close by working harder.

**Where the lines are ours rather than an agency's, we say so.** Some are published isobaths; some we
fit through a cloud of individual depth soundings. Those render differently and are labelled
differently, because "the state surveyed this" and "we interpolated this" are different claims.

There's one case worth telling because it shows what the data is really like. Maine files one of its
lake IDs — number 870 — as "North Pond, 59 acres". It actually contains **17,922 depth soundings
spread across 348 km, essentially the entire state**, of which 0.5% are in North Pond. It's not a
lake; it's where the digitisation dumped everything it couldn't file. Rather than throw those
measurements away, we assigned each sounding to whichever lake actually contains it — recovering
**232 lakes that had no contours at all.** The credit line on those says the lake assignment is ours,
not the agency's, because it is.

### Wind — 1,193 lakes

Winter wind climatology from NREL's WIND Toolkit: which direction wind actually comes from, combined
with how much open water lies in each direction.

That combination is the point. Fetch alone names the wrong shore. **Lake Willoughby** has its longest
open water to the south-southeast, and the founder was fairly sure it never gets a southerly — it sits
in a glacial trough between two mountains. The data says the trough *channels* wind along the valley:
strongly bimodal, 19.4% from the southeast and 18.6% from the northwest, with almost nothing from the
east where the ridges block it. The reasoning was right, the prediction was wrong, and the only way to
know was to look.

We're currently expanding this from 1,193 lakes to about 11,100, because wind matters for two
different hazards — pressure ridges (which need a long fetch) and wind holes (which don't) — and the
original cutoff was chosen for the first and was quietly deciding the second.

---

## What this means when you open a lake

A lake page is assembled from claims of very different strength, and the app is built to never blur
them:

- **The outline** is a published shoreline, usually accurate to a few percent, occasionally traced
  before the dam changed.
- **The name** is the official one where it exists.
- **The depth** either names the agency that measured it or reads as an estimate. Those are not the
  same sentence.
- **The contours** either say a state surveyed them or say we fitted them.
- **The wind** describes an average winter over five years, not today.

**None of it says whether the ice is safe.** It's context for a decision you make with your own eyes,
a spud bar, and other people's recent reports. Everything on this page describes the *lake*. Nothing
on it describes the *ice*.

---

## Known gaps, stated plainly

- **Depth under 25 acres** is largely absent, and no global source covers it. **Massachusetts and New
  York are the worst-served** — 443 and 629 lakes respectively that we'd expect a source to cover and
  none does. Massachusetts' state bathymetry archive turns out to hold only 265 lakes, all of which
  we already use, so closing this needs sources we haven't found yet.
- **New York has no statewide bathymetry.**
- **Québec is not covered**, though several lakes on the border are — the Canadian catalogues are a
  separate integration we haven't done.
- **About 1,100 bodies are `unclassified`** — we're confident it's water, and no source said what
  kind.
- **~300 possible duplicate pairs** are queued for human review rather than merged automatically.
- **A missing pond is fixable.** A specific request overrides every threshold on this page, and that
  escape hatch is what makes the rules above safe to be strict.

---

## Related

[Bathymetry challenges](./bathymetry-challenges.md) · [Report lifecycle](./report-lifecycle.md) ·
[Hazard decay](./hazard-decay-and-lifecycle.md) · [Adding a region](./adding-a-region.md)

For the engineering record: [`plans/phase-N7-unified-corpus.md`](../plans/phase-N7-unified-corpus.md)
(the full phase, with the operator's runbook at the bottom) and
[`plans/01-decisions.md`](../plans/01-decisions.md) (**D92–D105**, **D109–D137**).
