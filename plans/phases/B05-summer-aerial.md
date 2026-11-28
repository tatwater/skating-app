# Phase B05 — The summer aerial: our own NAIP archive of the region

*One photograph of the whole region, summer-flown and dated, cut once into our own tiles, so the
console's aerial opens in about a second wherever an operator looks, and seamlessly across state
lines.*

> **Status:** 🟡 **In progress 2026-11-25** — the design is ruled and the build starts now, alongside
> B01-7b. Decisions **D314** (we own the summer aerial: one region-wide archive, rebuilt on demand and
> offered each July), **D315** (the per-quarter-quad selection rule), **D316** (console staff only:
> not offered to skaters, for now and until the founder says otherwise; amends **D84** and **D146** for
> the summer tier), **D317** (z18 everywhere) and **D318** (the aerial always shows the date it was
> flown). Amends **D312**'s source and credit, not its behavior. **D147** is unchanged. The founder
> answered all eight forks on 2026-11-25 (§1.2), and two follow-ups the same day (no interim surface
> for the July offer; no clipped reveal for skaters either), having been told the size (12,000–20,000
> lines, two PRs) without objecting. The one question the rulings opened (§8, F-9) he answered the
> same day: (c), the pilot grows to ~63 cells. The builder briefs are §10. **B05-1 is built and
> integrated** (2026-11-26: S, T and P merged, their seams closed, the stages run end to end locally
> with the cloud stood in for); the pilot (§10.7, gated) is next. What the build found is at the end.
> **2026-11-27:** the pilot built and looked at, the founder ruled on its autumn frames (**D319**,
> amends D315: turned flights struck by his review of flight days, §2.1.4); the first proposal awaits
> his review before the full run. **B05-1 is open as PR #188** (the pipeline; built, integrated,
> piloted and independently reviewed). It ships the foliage strike list empty, with the proposal
> beside it. No full region run has happened. After it merges, in order: (1) the founder reviews the
> foliage sheet by flight day, and his confirmed strikes land as a commit to `NAIP_FOLIAGE_STRIKES`;
> (2) the widen's deploy to dev, then the full region run, which is his explicit go/no-go (§7.4);
> (3) B05-2, the app's swap (§10.8).
>
> **The token.** `B05`: the work is launch-era console infrastructure, and the `A` era (enrichment,
> `A01`–`A10`) is closed in the README's table, so it is not `A06j` even though its family is A06e's
> imagery. `B02` is spoken for (the store launch, scoped in its own tree, D228–D231), `B03` and
> `B04` are taken, and `B01-6` / `B01-7` are B01's PR sequences. It is a phase rather than a B01 PR
> because it has its own workstreams, its own decisions and its own infrastructure (Governor fork
> G-1 records the alternatives).

---

## §1 — What and why

### §1.1 — What it is

The console map's summer aerial (D312) today asks USGS's `USGSNAIPPlus` `exportImage` to render
each grid cell on demand. A cold view takes **3–45 s** (the register's Co15), its flight date often
never arrives because the identify call answers without CORS headers (Co18), and which frame we see
is USGS's choice, not ours. This phase replaces it with **one raster PMTiles archive of the whole
region**, built by us from NAIP's own cloud-optimized GeoTIFFs, with **the frames picked by the
founder's rule**, cell by cell, and **a date index that dates every cell** (D318). The console reads
it as one `pmtiles://` raster source, the way it already reads the bathymetry and the winter passes.

Behind the archive is a pipeline that can be run whole, by stage, or for one area, and a July check
that looks for newer summer flights and **offers** a rebuild without spending anything.

**It is for console staff only** (D316): admins and moderators placing and checking marks against the
shore. No skater surface draws it, on the web or the phone, clipped to a lake or not — not for now,
revisited only on the founder's word. Checked 2026-11-25: no skater can see one today (§4.3).

### §1.2 — The founder's rulings (2026-11-25)

Quoted where they bear; these are the inputs, not this doc's reading of them.

- **Own it.** *"I'm convinced – I want to own the imagery. Let's build it"* — said after seeing the
  cost.
- **Region, not per lake.** *"What if we got the whole 5-state region (go ahead and get CT/RI while
  you're at it, just to complete the region) in one go, and then render from our own tiles whatever
  each lake needs? Rather than storing separate satellite layers for each of the 25,000 lakes?"* —
  *"I don't care about per-state; I want to cover the region. And I want the user to be able to
  render the layer seamlessly across state lines as they pan, or if they zoom in on a lake that
  straddles a line."* NY, VT, NH, ME and MA are the supported five (*"Yes, NY is in it"*), plus CT
  and RI: *"Yep, better to grab all the data now and we can crop it later."* **Seven states, each
  covered whole.**
- **What a good frame is.** *"I value recency, but not if it shows dead trees and snow/ice. I value
  high resolution/quality, but only in combination with recency."* *"I'd definitely rather this NAIP
  layer be in summer months if possible"*. *"Also prioritize minimal cloud cover, if that's even an
  issue."*
- **The rule** (*"These are great rules, thanks!"*), per quarter-quad, in order: (1) leaf-on frames
  only — 1 June–30 September, plus 20 May onward south of 43.5°N; (2) among those, the newest; (3) a
  0.3 m frame wins over a newer 0.6 m frame when it is at most two years older; (4) minimal cloud
  cover. NH, MA, CT and RI: 2023 at 0.3 m over 2025 at 0.6 m (*"Agreed"*). Cells whose newer flights
  are all October or later take older summer frames (ME 2018, NY 2019), not foliage frames: *"Sure,
  let's see how it looks and re-address in the future"* — to be revisited once he has seen it.
- **Resolution.** *"The higher the resolution the better, assuming it's not just upscaled for no real
  reason. But I don't necessarily see a reason to go higher-res than 1px = 1sqft"*.
- **Upkeep.** *"could we run an every-July cron to reassess the available imagery and offer to
  re-build this layer if it notices a newer suitable pass for any of our region?"* and *"This should
  also become part of a standard machinery pipeline that can be called on demand or via a cron!"* The
  check only offers: it never starts a rebuild and never spends. The pipeline is a standard one,
  callable on demand — all of it, one stage, or one area — with run records carrying scope and
  heartbeat; a partial rebuild re-tiles only the cells that changed.
- **Cost, accepted.** The USGS service is free; owning costs about $70 a year and buys speed (about
  1 s for a first view, against 3–45 s), control of which frames, and independence from a service we
  don't run.

**The eight forks, ruled (2026-11-25).** The design's §8 asked; he answered every one:

1. **Maximum zoom: z18 everywhere** (F-1 b, D317). One archive, one layer, ~387 GB, ~$5.80 a month
   (the design's figure; the pilot measured ~260 GB and ~$3.90 a month, §6.1).
   No two-band stacking.
2. **Where the July offer appears** (F-2): not an Overview card and not the Inbox. *"I think this
   belongs in the Machinery pages eventually, where we manage the rest of the imagery runs."* And no
   interim surface: *"Don't worry about the interim, I'll have the Machinery built long before
   July."* So the check only stores its finding — its run row and a durable *newer suitable flight
   available* record (the cells, their flight dates, what the live layer was built from, the command
   to run), shaped so Machinery's imagery page can draw it (§3.3). No email. Machinery's console mode
   doesn't exist yet (§3.4), so the page is a register row owed to it.
3. **The pilot area** (F-3 a): Lake Champlain's north end (Vermont 2025 at 0.3 m against New York
   2024 at 0.6 m, the state line, Québec's edge, big water) plus a strip on the New Hampshire–
   Massachusetts line across 72°W, ~40 cells. Widened by F-9 (c) to ~63 (§7.4): plus the Maine strip
   north of Rumford and a New York 2024/2019 join.
4. **Dev only, now** (F-4 a): built to dev's key; at the prod cutover prod points at the same dated
   object. No prod copy.
5. **No summer aerial for skaters** (F-5, D316). *"I don't want summer for skaters at all. This is
   purely to help admins place landmarks on the map properly."* Console staff only — admins and
   moderators — not the skater web app or the phone; and not the older clipped reveal of one lake
   either, *"at least not for now (I'm not sure if they currently can or not)"*. They can't (checked,
   §4.3); it is revisited only on his word. Nothing goes on B04's running list.
6. **The rack's two rows** (F-6 a): *Winter satellite* (the Imagery tab's winter pass, today
   *Aerial*) and *Summer aerial* (this layer).
7. **The six Maine cells north of Rumford** with no summer frame at 0.6 m or better (F-7 a): the
   **2 October 2023 frame at 0.3 m**. And a new standing requirement: *"we should always show the
   date of the imagery, regardless of which tile/region."* (D318; the design is §2.7 and §4.2.)
8. **Cloud and glare review** (F-8 a): the builder pre-screens with a contact sheet; the founder
   confirms only the frames that would change a pick.

The build proceeds now, alongside B01-7b.

**The foliage rulings (2026-11-27, D319)**, on the pilot's finding that September flights can be in
full autumn color (§2.1.4): (1) keep the calendar, score every candidate flown from 1 September for
greenness, and have the founder confirm strikes by flight day on a review sheet — a screen for review,
never an automatic rule; (2) the threshold is 0.6; (3) the ~80 western Maine cells with no green frame
at 0.6 m or better keep their 27 September 2023 frames at 0.3 m, not the 2015 1 m ones, by a rule
that generalizes the six-cell exception and names the cells for the July check; (4) the six October
cells keep 2 October 2023, not 5 October 2018. His order of preference stands: no dead trees, snow or
ice first, then recency, then sharpness only with recency.

### §1.3 — Out of scope

- **Any summer aerial for skaters** (D316): no region view, no body-clipped reveal, on any client,
  until the founder says otherwise.
- **Color normalization in v1.** Flights from different years, states and sensors differ in tone;
  the mosaic shows that as a quilt, most visibly at low zoom (§5.4). Matching them is later work with
  its own trigger.
- **z19.** At 44°N a z19 pixel is 0.21 m, finer than any source; it would be upscaling with no
  detail behind it. The head maps' zoom ceiling of 19 overzooms the archive's deepest level instead.
- **Canada.** NAIP is US-only and ends 0–7 km past the border; Québec, New Brunswick and Ontario
  show the basemap.
- **A hosted runner.** The heavy stages run on Fly, started from the operator's laptop; a console
  *Rebuild* button that launches them is B01's deferred *hosted ETL runner* decision (§3.2).
- **Machinery's imagery page.** The July check's record is shaped for it (§3.3); the page is B01's
  Machinery mode (§3.4).

---

## §2 — The pipeline

Four stages, each its own run row (§2.6), one entry point (§3.1). The shape is A06e's (D148):
*what to cut* lives in TypeScript and `packages/core`; *how to cut it* in a container that takes one
unit of work; *where it runs* in one Fly-specific script.

### §2.1 — Select: the catalog, the rule, the manifest

**The catalog.** Microsoft Planetary Computer's STAC (`planetarycomputer.microsoft.com/api/stac/v1`,
collection `naip`) lists every NAIP quarter-quad as an item with `datetime`, `gsd`, `naip:year`,
`naip:state`, its bbox and a lossless 4-band COG. Reads are anonymous; asset URLs need a short-lived
SAS token from the anonymous token endpoint. Enumerating the seven states is about 70 POST pages
(1,000 items each); the scouts' snapshot holds **69,207 items** for **9,168 quarter-quads**.

**The rule lives in `packages/core`** (`naipSelection.ts`), so the select stage and the July check
(§3.3) run the same code — the A06i pattern, where granule selection moved into core for the same
reason. Per quarter-quad, with candidates from every state that lists it (319 border cells are
listed by two states, and their frames compete):

1. **Drop what isn't a candidate.** Frames coarser than 0.6 m (NY 2017's and the older 1 m flights);
   an item whose quarter-quad lies outside its labeled state's envelope (§2.1.1); an item on the
   reviewed exclusion list (§2.1.2).
2. **Leaf-on only.** Acquired 1 June–30 September, or from 20 May south of 43.5°N (the
   quarter-quad's middle) — **and not struck by the founder's foliage review** (§2.1.4, D319): a
   frame flown leaf-on by the calendar but already in autumn color. A struck frame is demoted, not
   dropped: never the pick while a green leaf-on frame is left, and below every green one in the
   stack.
3. **The newest**, by acquisition date. In the snapshot `naip:year` equals the acquisition year for
   every leaf-on frame (the four mismatches — NH and VT 2018 flown in January 2019, NY 2021 flown in
   April and May 2022 — are all leaf-off), so the two-year window is measured in program years and
   ties break by date.
4. **A 0.3 m frame within two years of the newest beats it.**
5. **The off-season step: no green leaf-on candidate left.** Two reasons, both the rule's and both
   named in every run's log and manifest (`offSeasonCells`, with why), so the July check can revisit
   them (D319 generalized the six-cell list this step once held):
   - **`allTurned`** — every leaf-on frame struck by the foliage review: steps 3 and 4 over those
     leaf-on frames, turned or not, so the cell **keeps its newest sharpest one** in autumn color
     (the founder's ruling 3, 2026-11-27: about 80 cells in western Maine keep 27 September 2023 at
     0.3 m, never the 2015 1 m frames).
   - **`noLeafOn`** — nothing flown leaf-on at 0.6 m or better: steps 3 and 4 over every candidate,
     whatever its season. Six quarter-quads in one north–south strip in Maine's western mountains, at
     70.53°W from 44.6°N to 45.0°N (running north from Rumford: `4407028ne`, `4407020se`,
     `4407020ne`, `4407012ne`, `4407004se`, `4407004ne`), flown only in October (2018, 2021, 2023)
     with summer frames only at 1 m (July 2015): each takes **the 2 October 2023 frame at 0.3 m**
     (F-7 a, confirmed 2026-11-27 over the 5 October 2018 frames).

**The fallback stack.** The pick's alternates, in the order the rule would choose them if the pick
were struck — every other leaf-on candidate, those struck as turned last (every other candidate,
for a cell never flown leaf-on). A frame
that doesn't cover its whole cell (a state's flight ending at a state line or the border, 134 of the
Maine picks per the scouts' thumbnails) lets the next one show through (§2.2). Stack depth in the
snapshot: 718 cells have one leaf-on frame and no fallback; the median cell has three.

**What the rule picks today** (S's select stage over the first walk, `naip-20261125`, 69,207 items,
after the founder's cloud review; the design's re-run matched the scouts' `picks_T2.json` — S's rule
matches it on 9,123 of 9,168 cells, the other 45 being one frame published under two states' labels
on the same day, which the rule now breaks by item id):

| State (by the pick's label) | Pick | Cells |
| --- | --- | --- |
| VT | 2025, 0.3 m | 812 |
| NH | 2023, 0.3 m · 2025, 0.6 m | 656 · 2 |
| MA | 2023, 0.3 m | 711 |
| CT | 2023, 0.3 m · 2025, 0.6 m | 398 · 1 |
| RI | 2023, 0.3 m | 85 |
| ME | 2023, 0.3 m · 2021, 0.6 m · 2018, 0.6 m · Oct 2023, 0.3 m | 1,648 · 809 · 258 · 6 |
| NY | 2024 · 2022 · 2021 · 2019, all 0.6 m | 2,474 · 385 · 132 · 791 |

After the cloud step (§2.1.2), which moved two Maine cells from 2023 to 2021 (the founder's review).
The three 2025 0.6 m picks are the rule working, not a gap in it: at `4407155ne` and `4407155se`
(NH) New Hampshire's 2023 0.3 m frame was flown on 3 October — leaf-off, so no candidate — and the
newest leaf-on frame is 20 September 2025; at `4107202se` (CT) the catalog holds no 2023 frame at
all (Connecticut's flights there are 2012, 2014, 2016, 2018, November 2021 and August 2025).

#### §2.1.1 — The mislabeled Maine 2025 items

The catalog's 744 *"Maine 2025"* items (`me_m_4207239_sw_18_060_20250920`, …) sit at 42.x°N —
Massachusetts quarter-quads, with Massachusetts 2025's own dates — under a `me_` prefix. They are
excluded by **a geometric rule, not by name**: an item whose quarter-quad (decoded from its id, §2.2)
falls outside its `naip:state`'s envelope plus a margin is dropped and reported in the run's counts.
A rule by name (`state = me and year = 2025`) would also drop a genuine future Maine 2025 item,
silently.

#### §2.1.2 — Cloud and glare: a reviewed exclusion list

The catalog has **no cloud property**: NAIP's "≤10% per tile" is an acceptance allowance, not a
measurement. Step (4) of the rule is therefore its own step, applied as **exclusions before the
season step**, so a struck frame falls back to the next leaf-on one:

- **Scoring.** The select stage scores each pick and each fallback that would show (§2.2) from its
  200-px catalog thumbnail (neutral-white pixels as a share of valid ones), as the scouts did: of the
  9,168 picks, 9,070 score under 2%, 44 between 2% and 3%, 54 over 3%. A pick with no score is cut
  as partial (its fallbacks warped too, §2.2), so the score decides pixels: **a thumbnail whose read
  failed this time** (a network error, a 5xx, a 429, a 403 — never cached, so a re-run reads it
  again) refuses anything but a dry run, which reports it and goes on (*added at the independent
  review of the PR's last rounds, 2026-11-27*). No thumbnail listed, a blob that is gone (404, 410)
  and an image GDAL can't decode stay unscored for good. The region's dry run had none unscored.
- **Review, not a threshold** (the founder's ruling, F-8 a). Anything over ~3% is a **candidate**,
  written to a contact sheet. **The builder pre-screens**: most are false positives (cities, dunes,
  beaches), set aside and listed. **The founder confirms only the frames that would change a pick** —
  a likely cloud or glare on a cell's pick, shown beside the frame that would replace it. A likely
  cloud on a frame that is only a fallback changes no pick; the builder decides it and lists it.
  Only confirmed frames join `naipExclusions.ts` in core — committed, each with its item id, the
  reason (`cloud` / `glare`), and who reviewed it when (`founder` or `builder`).
- **The first review (the founder, 2026-11-25)**, of the first walk's sheet (`naip-20261125`: 60
  picks over 3%, 25 the pre-screen thought real, 35 false positives). **Two frames struck:** the
  Aroostook picks of 2023-09-22 at `4606741se` and `4606741ne` (cumulus and shadow), which fall back
  to their clear 2021-08-31 0.6 m frames; nothing else moves. **Kept, on purpose:** the 23 Long
  Island and New York City picks with real glare or small cumulus (19 of 2024-07-02 and 2 of
  2024-09-13 with glare on the bays, 2 with cumulus over Queens and the East River) — *glare and
  cloud there don't matter, because nobody skates that water* — plus the borderline sea glint off
  `4106917sw` and the 35 false positives. The kept ones are recorded beside the list and in the
  sheet's review file as `kept`, so a later review doesn't raise them again. **Open:** `4606741sw`,
  the third Aroostook cell of that day, scored 2.3% (under the threshold), is a question for the
  founder. *(This replaces the design's expectation that the scouts' ~17 Long Island cells would be
  struck and fall to NY 2022; had they been, 5 of the 22 New York strikes would have fallen to 2019,
  not 2022.)*
- **New frames** (the July check, §3.3) are scored at the next select stage; until a person has
  reviewed a new pick's score, the offer says it is unscored.

#### §2.1.3 — The manifest

The select stage writes the build's record, **`…-manifest.json`**, immutable under the build's dated
key (§2.4): the rule's version, the catalog snapshot it read (archived to the private bucket,
`naip/inventory/<date>/<state>.jsonl.gz`, about 5 MB), the exclusion list's hash, the off-season
list it ran with, the build it diffs against (`basedOn`, `--from-current`), and **one table of
frames** by item id (acquisition date, gsd, `naip:year`, labeled state) holding every pick and every
fallback, so the date index can date a fallback that shows without parsing its id. Per quarter-quad:
its key, the states that list it, the pick (an item id in that table), the step that picked it
(`leafOn` or `offSeason`; the cells the off-season step reached are listed once more, each with why,
in `offSeasonCells`, beside the foliage list's hash, `foliageStrikesHash`), the fallback stack (ids in order), whether the pick covers its cell
(`partial`), its cloud score, and the work tiles it touches. Per work tile (§2.2): its input hash,
its cells, and whether this build cuts it (`retile`; `false` only for a `--from-current` work tile
whose hash is unchanged, which the assembler copies). About 1.5–3 MB raw. The assembler adds, before
publishing it, the archive's and the date index's name, size and SHA-256 (§2.7) — the archive's over
its bytes as uploaded, the index's over its **decoded JSON**, since the index is stored gzip-encoded
and a CDN may re-encode it — and each work tile's per-cell counts (`cellCounts`, §2.2 step 4), so a
later `--from-current` build that copies a work tile can still date it once the shards are deleted.
The types are `NaipManifest` in core's `naipManifest.ts`.

**What a build is built from is one value** (*added at the PR's sixth review, 2026-11-27*): core's
`naipBuildInputsHash`, over everything the select stage decides — the format, campaign, rule, the
catalog it read, both review lists' hashes, the off-season cells, `basedOn`, every frame, cell and
work tile — and never `createdAt` (a re-run that decides the same build is the same build) or what
the assembler adds, so the select stage's manifest and the published one hash alike exactly when they
name the same build; `naipBuildInputsDiff` says what differs. The assembly record carries it
(`inputs`), and once a campaign is published its inputs are fixed (§2.4).

The run's counts say how many cells picked by each step, how many fell back to October, how many
items each exclusion dropped, and assert the rule's invariants on the whole catalog (every cell has
a pick; no candidate beats its pick under the rule; no struck frame sits above a green one; the
off-season list is exactly the cells the step picked, each with the right why) — the full-inventory
proof that CI's fixture can't carry (§7.3).

#### §2.1.4 — Foliage: a reviewed list of turned flights (D319)

The pilot showed that step 2's calendar lets autumn through: Maine's 27 September 2023, New York's
16 September 2024 and Vermont's 20 September 2025 are in full color or brown, while New York's
18 September 2019 is green — the year matters more than the date, so a stricter cutoff is the wrong
tool. **The founder's four rulings (2026-11-27):** keep the calendar and score every candidate flown
from 1 September for how green its vegetation is, for his review by flight day; 0.6 is the threshold;
where striking leaves a cell nothing green at 0.6 m or better it keeps its newest sharpest frame
(step 5's `allTurned`), never the 2015 1 m frames; the six October cells keep 2 October 2023.

- **The score** (`scripts/aerial/src/foliage.ts`), from the 200-px catalog thumbnail: each pixel is
  nodata, water, neutral (roads, roofs, rock, cloud) or vegetation; a vegetation pixel is *green* when
  its green–red index `(G − R) / (G + R)` is over 0.02; the score is the green share of the
  vegetation, with no verdict under 200 vegetation pixels or a quarter of the valid ones (open water,
  a city). Exact integer tests, so it is the same on every machine for the same decoded pixels; on
  the 35,247 cached thumbnails it reproduces the analyst's scores and verdicts exactly. **Under 0.6
  reads as turned; 0.6–0.7 is borderline and kept.**
- **A screen, never a rule.** A turned score makes a frame a *candidate*; the selection reads only
  `NAIP_FOLIAGE_STRIKES` in core, which an entry joins once the founder has confirmed it
  (`reviewedBy: 'founder'`), as the cloud review's do. One entry strikes a whole flight day (labeled
  state and acquisition day) with a `keep` list; a frame entry strikes one frame on a day not struck.
  A day entry also strikes any frame the catalog adds to that day later, such as a reprocessed item
  under a new id — accepted (the governor, 2026-11-27): same flight, same foliage.
  The select stage refuses to build — anything but a dry run — with an entry still `proposed`.
- **The review** (`pnpm --filter @skating/aerial foliage <campaign>`, before a full build): scores the
  campaign's candidates from 1 September, proposes the turned ones — a day where turned frames are the
  majority is one flight entry keeping the rest by id, otherwise frame entries, so the proposal strikes
  exactly the frames under the threshold — and writes the sheet: per flight day a handful of its
  thumbnails with their scores, the proposal, the cells it changes, what each falls back to, the
  0.3 m → 0.6 m and age cost; then the borderline picks with what striking them too would do, and the
  cells left on a turned frame by name. Then it runs the select stage as a dry run with the proposal
  applied. Never proposed: a frame the cloud review kept (`NAIP_CLOUD_KEPT`: the 23 Long Island and
  New York City picks, three of them September frames), a frame a reviewed entry names, a frame not
  leaf-on by the calendar.
- **Known misses**, on the sheet: cities read as not green; some partly yellowed frames pass; dull
  July frames aren't judged at all (only frames from 1 September are scored).
- **A known limit, not chased:** the USDA stitches some quarter-quads from more than one flight under
  one date (about 130 picks probably hold such a strip, the analyst's count from the thumbnails'
  edge strips — `4407012se`'s orange west edge in the pilot is one). The date shown for that strip is
  the frame's stated date and can be wrong for the strip; the score reads the whole thumbnail.
  Fixing it would need the USDA's seamline files.

**The first proposal (2026-11-27, `naip-20261127`, the pilot's walk of 2026-11-26 — the same
69,207 items).** 18,939 frames scored (none without a thumbnail): 8,947 turned, 702 borderline, 8,399
green, 891 without enough vegetation. Proposed: **524 entries** (16 whole flight days, 508 frames),
committed as `scripts/aerial/review/naip-20261127-foliage-proposed.json`, **awaiting the founder**.
Applied, it changes **1,074 cells**, every one of the 9,168 still covered, and leaves the two
Aroostook cloud strikes and the 23 kept Long Island and New York City picks as they are:

| State (today's pick) | Cells change | 0.3 m → 0.6 m | Years older, changed cells | Picks after |
| --- | --- | --- | --- | --- |
| VT | 186 of 812 | 25 | 2.4 | 2025 0.3 m 626 · 2023 0.3 m 127 · 2021 0.6 m 18 (+ NH frames 41) |
| NH | 9 of 658 | 8 | 1.2 | 2023 0.3 m 682 · 2021 0.6 m 11 · 2025 0.6 m 5 · 2018 0.6 m 1 |
| MA, CT, RI | 0 | 0 | — | unchanged |
| ME | 456 of 2,721 | 231 | 3.2 | 2023 0.3 m 1,423 · 2021 0.6 m 732 · 2018 0.6 m 566 |
| NY | 423 of 3,782 | 0 | 3.5 | 2024 2,088 · 2022 526 · 2021 155 · 2019 1,013, all 0.6 m |
| **All** | **1,074** | **264** | **3.2** (0.37 over every cell) | 0.3 m picks 4,316 → 4,052 |

*Picks after* is by the new pick's labeled state (a Vermont cell can fall to New Hampshire's 2023
frame across the line). **88 picks still read turned**, every one accounted for: the 80 `allTurned`
cells (76 keep 27 September 2023 at 0.3 m; `4507035nw` and `4507035sw` keep 30 September 2023 at
0.3 m; `4407047ne` and `4407047nw` keep ME 19 September 2021 at 0.6 m — no green frame at 0.6 m or
better in any of them), the six `noLeafOn` October cells on 2 October 2023, and two kept by the cloud
review on purpose (`4007438ne`, `4007439nw`, New York City's 13 September 2024 glare frames, which
read as not green because they are city and water).

### §2.2 — Tile: the work tiles, the warp stack, the shard

**The unit of work is a z11 Web Mercator tile** — 1,769 of them touch a quarter-quad by the design's
count (z10 would be 488, z9 135; measured from the quarter-quad outlines), **1,764 by core's grid**
(`workTilesOf`, which doesn't count an outline that only touches a tile's edge; the select stage's
full dry run, 2026-11-25). A fully covered one is 176–202 MB of output on land and, by the pilot
(§6.1), about four minutes on a `performance-4x` Machine (256 s; a `shared-cpu-4x` throttles) — the
design said ~220 MB and ~7 minutes:
small enough that a failure costs minutes, large enough that boot time (seconds) is noise.

**The quarter-quad grid is computed, not read.** A key like `4407236se` is a 3.75′ cell: 1° block
(44°N, 72°W), 7.5′ quad 36 of 64, quadrant SE. Its nominal outline in NAD83 is exact from the key
(core, `quarterQuadCell(key)`, with a test against the catalog's footprints). Real images carry about
300 m of overlap past it.

**The warp stack, per work tile.** Inputs mix UTM zones 18 and 19 (the line is 72°W), so a VRT of
the raw COGs can't mosaic them. Instead:

1. For each quarter-quad touching the work tile, for each frame in its stack that supplies a pixel
   (step 4 is taken first), a **warped VRT** (`gdalwarp -of VRT`): to EPSG:3857 on the archive's
   pixel grid at z18's resolution (D317), written on **exactly its own cell's pixels** — `-te` the
   unit's `extent`, the pixels whose centers lie in the cell (`tiles.ts`' `pixelExtent`), so two
   neighbors split their shared edge with none left over and none claimed twice — alpha from NAIP's
   fill (`-srcnodata "0 0 0"`, §9), RGB only (NAIP's fourth band is near-infrared), `-r cubic`.
   *Changed from the design's `-cutline` (T, measured 2026-11-25):* a cutline is applied on each
   source's own pixel grid, and two frames on different grids disagreed about the edge pixel — a
   one-pixel gap or overlap at a join. A quarter-quad is a parallel-and-meridian rectangle, which is a
   rectangle in Web Mercator, so exact pixel extents cut it with no geometry at all.
2. One **mosaic VRT** of those, ordered bottom to top: each cell's oldest fallback first, its pick
   last. Since every input is cut to its own cell, neighbors abut exactly and the 300 m overlaps are
   discarded — no frame from one cell paints its neighbor, and within a cell the pick wins wherever it
   has pixels, its fallbacks wherever it doesn't. A state's flight that ends at a state line falls
   through to the other state's frame of the same cell.
3. `gdal raster tile` over the mosaic, clipped to the work tile: WebP quality 80 (A06e's setting; the
   scouts measured ~8–21 KB a 256-px land tile, under 1 KB water; T measured 43–80 KB a 512-px tile at
   the deepest zoom, §6.1), `--skip-blank`, pixel zooms z12 to z18 — **a z13 chunk at a time**
   (sixteen to a work tile, each its own run), because Planetary Computer's anonymous SAS tokens live
   15 minutes and a run must outlive its token (below); a chunk none of whose cells has a frame that
   shows is skipped, since the tiler refuses a range outside its mosaic rather than writing nothing
   (found by the integration's run of a whole work tile, 2026-11-26). The zooms above the chunks are
   built from the chunks' own top tiles, with no source read, **each a 2×2 average** of the one below
   (not cubic: a kernel wider than its block read past the window's edge and left a translucent rim
   and a one-pixel spill at every work tile's edge, T measured), and bounded to the work tile (a
   source ending exactly on its edge touches the neighbor's tiles). *Zooms in this doc are pixel zooms* (a 256-px tile's number at that resolution, D317's
   terms). At G-2's 512-px tiles a tile's number is one less (core's `naipTileZoom`): a shard holds
   tile zooms 11–17 (the work tile's own 512-px tile down to the deepest level), the archive's header
   reads 7–17, and the work tile is the same z11 slippy cell either way.
4. **What each frame supplied** (for the date index, D318): per cell the work tile touches, the
   number of pixels each frame of its stack supplies to the mosaic, counted on the z16 grid (about
   2.4 m a pixel at 44°N) from the frames' alphas in the stack's order — the pick's alpha first, each
   fallback only where everything above it is empty. Any pixel counts; a frame that supplies none is
   not in the cell's dates. **And the strip the z16 grid can't see** (*added at the PR's review,
   2026-11-27*): a z16 alpha is a sample at the pixel's center, so an upper frame whose data stops
   between two centers — short of its cell's edge, or of another frame's — reads as covering while
   z18 pixels there are empty, and the fallback that would fill them counts zero and was never
   warped: a transparent strip up to four z18 pixels wide. The counts now read a ring of one more z16
   pixel past each cell (never counted), and for a frame that counts zero, wherever its data lies
   within one z16 pixel of the band where no shown frame above it is set for two pixels around, the
   worker warps it and the frames above it at z18 over just that band; if it fills anything, it is
   counted (at least one, so the index dates it) and mosaicked on those windows only. Tiling 2.
5. **Packed into a shard**: the tiles ordered by zoom and then by PMTiles tile id, with a small index
   (tile id, length, hash), uploaded to the private build prefix
   `naip/build/<campaign>/shards/11/<x>/<y>.{pack,idx.json}` (a pilot's under
   `naip/build/pilot/<name>/<campaign>/`) with a done record, `….done.json`, naming the work
   tile's input hash, the image digest, per-stage timings and step 4's per-cell counts — the
   manifest-per-frame record the cutter keeps (A06e's lesson: a run records the code that produced
   it).

**Fallbacks are read only where needed.** A cell whose pick covers it (`partial: false`) contributes
the pick alone; its fallbacks enter the stack only when the pick is partial or the cell sits on a
state line or the border. That holds source reads near the picks' own size rather than the stack's
(the scouts' 9–10 TB counted whole stacks; the pilot measures the real figure).

**Where.** The COGs are in Azure West Europe, so the Machines run in **`ams`** (or `fra`), not the
cutter's `sjc`. Each Machine fetches its own SAS token. **The 15-minute rule** (T, measured
2026-11-25): an anonymous token lives 15 minutes and the endpoint hands out the *current* one however
little of it is left (minted 03:23:19, expiring 03:38:20, served at 03:26 with 12 minutes left), so a
token fetched once per work tile dies mid-tile. The worker checks before every read
(`AERIAL_SAS_MARGIN`, 180 s), waits out a dying token for the next, and runs the tiler a z13 chunk at
a time so each run finishes inside its token; GDAL reads the blobs through `/vsiaz/` with the token
in the environment, never on a command line, and the worker's stderr loses every `sig=` before it
reaches `fly logs`.

**Idempotent and resumable.** A shard's keys are a function of the campaign and the work tile; a
re-run overwrites them. "Landed" means a done record whose input hash matches the manifest's for
that work tile — **never presence alone** (A06e's `--recut` lesson: a reconcile by presence reports
4,485 of 4,485 landed for a recut that spawned nothing).

**Retries.** `backfill.sh`'s shape: spawn the outstanding work tiles, drain, ask the bucket what
landed, re-spawn the difference, three rounds; whatever is left is reported as failed by work tile,
with its Machine's last log lines. A failing work tile never blocks assembly of the rest — but an
incomplete set is never published (§2.5). *Added at the PR's review (2026-11-27):* a work tile whose
Machine is still up is waited for, never spawned a second time (a re-run after the laptop lost a
round, a drain that gave up), and a worker still running after an hour (`AERIAL_TILE_DEADLINE`) is
killed and re-cut by the next round, since nothing in GDAL bounds a stalled read.

**The container** is **its own image**, `scripts/aerial/Dockerfile`, built from the same pinned GDAL
base the winter cutter uses (`ghcr.io/osgeo/gdal:ubuntu-small-3.13.2`, rclone, `pmtiles`) plus Node
for the assembler (§2.4), with two entrypoints, `cut-aerial` and `assemble-aerial`. *Changed from the
design's "a second entrypoint beside `cut-granule`" (the briefs' call):* the winter season is live
and Convex dev's pump spawns the pinned cutter image (`FLY_IMAGE`), so the aerial work never rebuilds
or re-pins that image, and the winter cutter's files stay outside the aerial builders' territory. It
is pushed to the same Fly app (`skating-imagery`) under its own label, and every Machine is spawned
with A06e's non-optional flags (`--rm --restart no --detach`, explicit `--vm-size` and
`--vm-memory`, the image pinned by digest, the live-Machine cap counted on every live state). The
app's staged secrets already carry R2 credentials, and they reach the archive's bucket (G-6,
answered: `skating-imagery`).

**The image's TypeScript is bundled on the laptop** (`scripts/aerial/bundle.sh`, T and P): the
worker's packer (`src/tilesPackMain.ts`) and the assembler (`src/cli/assemble.ts`), each one
self-contained ES module built with the package's own `esbuild` devDependency into
`.scratch/image/`, which the Dockerfile copies. *Changed from P's brief's in-image build:* `pnpm
install` inside `docker build` fails the workspace's supply-chain check (it fetches metadata for every
lockfile entry, one from a registry that needs a token the build doesn't have — a 401, T measured),
and the image then needs Node alone, no `node_modules`. Node's binary needs `libatomic1`, which the
GDAL base lacks. Both bundles start under Node 26 (checked at integration, and the integration's
local run used them for the pack and the assembly).

### §2.3 — Overviews

Zooms below the work tiles (pixel zooms z8–z11, tile zooms 7–10 at 512 px, §2.2 step 3) are built
from the shards' tile-zoom-11 tiles by the assembler (each
level a quarter of the one above — a few hundred tiles in all). The floor is z8: the console
is fenced to one body, and the widest body (Champlain) frames at about z9. Below z8 the aerial draws
nothing and the basemap shows.

### §2.4 — Assemble and upload

**The archive can't be patched.** A PMTiles v3 file is a header and root directory in its first
16 KB, leaf directories, then tile data; R2 objects are written whole. Any change is a new archive.
What can be avoided is re-tiling.

**The old archive is the shard cache.** A rebuild re-tiles only the work tiles whose input hash
changed; the assembler copies every other work tile's tiles **out of the current archive** by range
reads (in a clustered archive each work tile's tiles at a zoom are one contiguous run, because the
Hilbert order keeps an aligned block's descendants together), and their per-cell counts out of the
current manifest's work tiles (`cellCounts`, which the assembler writes there for this reason). Keeping a separate shard cache would double storage (~$47 a year more at the pilot's ~260 GB, §6.1)
to save work the old archive already holds (Governor fork G-4).

**A streaming writer, not `pmtiles convert`.** `pmtiles convert` wants the whole input as an MBTiles
on local disk and spools its output too — over a terabyte for an archive this size, past what one
Fly volume is understood to hold (unverified, §9). The assembler instead:

1. reads every shard's index (and, for unchanged work tiles, the old archive's directory entries) —
   tens of millions of small entries, a few hundred megabytes;
2. lays the archive out **clustered** (zoom by zoom, work tiles in Hilbert order, tiles by id),
   deduplicating identical tiles by hash, and builds the root and leaf directories;
3. streams header, root, metadata, leaf directories and then the tile data, in that order, into
   `rclone rcat` — a multipart upload with 128 MiB parts (64 MiB × the 10,000-part cap is ~625 GiB,
   too close to the high estimate), so no step needs the archive on disk;
4. hashes the bytes as they pass (SHA-256 into the manifest; a multipart ETag is not a checksum);
5. writes the **date index** (§2.7) from the manifest and every work tile's per-cell counts.

**It is TypeScript on Node**, in `scripts/aerial`, writing the PMTiles v3 header and varint-encoded
directories against the spec itself and read back in its tests by the `pmtiles` JS library the web
uses. *Changed from the design's Python assembler on the protomaps package's helpers (the briefs'
call):* CI has no Python, the helpers' names were never verified, and D40 wants the round trip in
CI. It runs on one Fly Machine in **`iad`** (`FLY_ASSEMBLE_REGION`; T's call): it reads nothing from
Azure, only range-reads the shards from R2 and streams the archive back, so it belongs nearest the
bucket — R2 places a bucket near where it was created, and the team works from the US east, but the
bucket's location hasn't been read (Cloudflare's dashboard shows it; `ams` if it says Western
Europe). It ships in the image as a bundled ES module (`bundle.sh`, below). R2 has no egress charge, but Fly bills
outbound transfer (§6.1).

**Keys** (the bathymetry archive's convention, `dev/<name>-YYYYMMDD.pmtiles`, immutable — the public
URL is CDN-cached, so a key is never overwritten):

- `dev/naip/naip-summer-<YYYYMMDD>.pmtiles` — the archive
- `dev/naip/naip-summer-<YYYYMMDD>-cells.json` — the date index (§2.7)
- `dev/naip/naip-summer-<YYYYMMDD>-manifest.json` — §2.1.3
- `dev/naip/pilot/<name>/naip-summer-<YYYYMMDD>{.pmtiles,-cells.json,-manifest.json}` — a pilot's
  three, never at the production names (§3.1)

**A campaign is published once** (*added at the PR's sixth review, 2026-11-27*). Its keys are named
for it, so once its manifest is published, what its archive was built from is fixed: the published
manifest's `naipBuildInputsHash` (§2.1.3). Every stage that would act on a campaign holds the
manifest it has to that value first. **The same inputs are already done**: the select stage goes
ahead (the same decision, written again), the tiles stage has nothing to cut and uploads nothing,
the assembler and a re-run of the stage take the record (`finishedAssembly`). **Other inputs are
refused**, saying what differs (`cells: 1 changed (…)`, `foliage strikes: changed`, …) and what to do
— the change is a new campaign, `run-aerial.sh naip-<YYYYMMDD> --from-current` with
`NAIP_MANIFEST_URL` at the published campaign's manifest, which copies its unchanged work tiles (for
a pilot, a new pilot from nothing: a pilot is never a base, PR #188's ninth review) —
never an overwrite, and never a success over the earlier selection: the select stage (not a dry
run) before it writes its manifest, the tiles stage before it uploads that manifest over the
bucket's, the assembler before it reads a shard, the laptop's re-run against the record's `inputs`
(and again on the record that lands after it follows a Machine), and verify (§2.5). A dry run of
the select stage reads nothing from the bucket and checks nothing: its manifest reaches the bucket
only through the tiles stage, which refuses it.

**Dev only** (the founder's ruling, F-4 a). Prod has never been initialized; at the cutover prod
points at the same dated object. No prod copy is made.

### §2.5 — Verify, publish, clean up

**Verify** (the operator's laptop, after assembly; refuses to call a build good on any miss):

- **What it was built from** (*added at the PR's sixth review, 2026-11-27*). The assembly record's
  `inputs`, the published manifest's and the build's manifest's as it is now are one value (§2.1.3):
  a build manifest re-selected after the assembly — even one whose change re-cuts nothing, a strike
  on a frame that never shows — refuses the build, saying what differs.
- **Counts.** The header's addressed tiles against the shards' indexes plus what was copied; every
  work tile in the manifest present; every zoom present.
- **Spot reads.** A few hundred tiles fetched from the **public URL** by HTTP range, byte-compared to
  their shard source; the header and directories read by the same `pmtiles` JS library the web uses,
  and, where the CLI is installed, a second reader: `pmtiles show` over the URL. *Not `pmtiles
  verify`*, which takes a local file only — handed the URL, it failed every build on a machine with
  the CLI (found by the integration's local run, 2026-11-26); the structural verify is the
  assembler's round trip on a local archive (§7.3).
- **Coverage.** Per quarter-quad **the archive holds** (a pilot's manifest records the whole region),
  the pixels its frames supplied (the cut's counts, on the z16 grid) over its nominal outline's;
  anything under 99% listed. Expected: only cells cut by the coast or the Canadian border — and, in
  a pilot, cells whose other work tiles it didn't build.
- **Dates (D318).** Every cell any tile touches has an entry in the date index; every entry names at
  least one flight; every flight's date is a real day that matches its item id's; the index names
  this archive, and the SHA-256 of its decoded JSON is the manifest's. Any miss refuses the build: **an undated cell is
  never published.**
- **Seams.** For every quarter-quad edge whose two sides differ in flight (year or gsd), a sampled
  tile pair rendered into a contact sheet; and a low-zoom (z9–z11) overview of the region, so the
  quilt is looked at before anyone else sees it.
- **A viewer page** in the report: MapLibre over the archive's public URL, with the credit drawn by
  core's own date-range function (§4.2), so a pilot can be looked at before the console's swap exists.
- **The report** lands in `scripts/aerial/.scratch/<campaign>/report/` (gitignored; `keys.ts`'
  `scratchPaths`) and its counts in the run row.

**Publish** is by hand, the bathymetry way: set `VITE_NAIP_PMTILES_URL` in both local web checkouts
and on Vercel (Preview and Production), redeploy; set `NAIP_MANIFEST_URL` on Convex dev (§3.3). The
founder or the governor's named executor sets them; no brief displays a value.

**Clean up.** The campaign's build prefix (shards, indexes, its build manifest and assembly record)
**stays** after verify passes — a re-run of assemble takes the record from it, verify reads the
record, the build manifest and the shards it spot-compares from it — and goes only with the
campaign's archive, when a later campaign's cleanup deletes both as the old build's (*corrected at
the PR's ninth review*: this said the prefix went once verify passed, which would have left a
finished campaign failing its later checks and without its record). The previous archive (and its
index and manifest) is deleted no sooner than a week after the new one is live on Vercel — never by the build itself, and never the newest key
(`run-aerial.sh <campaign> --stage cleanup --old <key> --live-since <day>` refuses both). **The week
counts from publication, which nothing records** (*changed at the PR's review, 2026-11-27*: it
counted from the replacement's upload, and an archive uploaded a month before it was published
could be deleted the day its replacement went live, under clients still holding its URL). So the
operator states the day the web began serving the replacement, `--live-since`; cleanup refuses
without it, with one in the future or before the replacement's upload, and while the web's env files
don't point at the replacement — an archive no env file names has never been live (true of every
archive until B05-2's swap). A bare day counts from its end. A pilot is never published (its viewer
reads it from the upload), so its week counts from the upload and it takes no `--live-since`.

**An assembly that dies before its manifest** — after its archive (or index) went up, before the
manifest, the last write — leaves objects at published keys that nothing names and nothing has
served. **Ruled (the governor, 2026-11-27): they are deleted by hand**, as built. The keys are never
overwritten, so a re-run refuses, naming what was left; the operator deletes those objects
(`rclone deletefile`, `scripts/aerial/README.md`) and assembles again.

### §2.6 — The run record (D218, D310)

Every stage writes an `importRuns` row through `RunLogger`, with a scope stated at start and a
heartbeat as it reports progress, so Machinery can draw a build whole by its campaign id
(`naip-<YYYYMMDD>`). Widen-only additions to `IMPORT_RUN_KINDS` (and `@skating/run-log`'s
`ImportRunKind`, kept in step by `importRunVocabulary.test.ts`):

| Kind | Stage | Scope (`pass`, `states`, `complete`) | Progress (the heartbeat) | Lands in |
| --- | --- | --- | --- | --- |
| `aerial_select` | §2.1 | `archive`, the seven, `true` (a `--states` run: those, `false`) | none until its close, which carries the per-state counts (§2.8: a refused select's row is its open and its failed close) | B05-1 |
| `aerial_tiles` | §2.2 | `archive`, the states its work tiles touch, `true` only for a full build | every 25 work tiles landed (the done records read every ten minutes during a round) | B05-1 |
| `aerial_assemble` | §2.3–§2.5 (assembly, upload, the index, verify) | `archive`, the seven, `true` | from when the assembler has decided (its index reads, overviews and layout are behind it: §2.8), per zoom written and at least every five minutes within one; then per verify check | B05-1 |
| `aerial_reassess` | §3.3 | `survey` (new), the seven, `true` | at start and finish | B05-2 |

**`survey`** is a ninth scope (widen-only): *reads a third-party catalog to learn what changed and
writes nothing but the finding*. None of the eight fit — `derived` is computed from data already
held, `archive` acquires data. `states` carries `CT` and `RI`, which `KNOWN_STATE_CODES` doesn't hold;
the validator takes any string, but anything that renders a run's states by that list must not drop
them (the build checks).

The widen deploys before the first run that writes those kinds (widen → deploy → use): B05-1's three
with its merge, before the full region run; B05-2's with its own. The pilot writes to a throwaway
local backend, never dev (G-8 a).

### §2.7 — The date index (D318)

*"we should always show the date of the imagery, regardless of which tile/region."* The pipeline
ships, beside every archive, an index that dates every cell by the flights that actually supply its
pixels.

**Format** (`NaipCellIndex` in core, `naipManifest.ts`; JSON, `version: 1`):

```json
{
  "version": 1,
  "archive": "naip-summer-20261212.pmtiles",
  "flights": [
    { "date": "2023-06-21", "gsd": 0.3, "state": "VT" },
    { "date": "2022-07-07", "gsd": 0.6, "state": "NY" }
  ],
  "cells": {
    "4407339ne": [0],
    "4407336nw": [0, 1]
  }
}
```

- **`flights`** — one entry per distinct (acquisition day, gsd, labeled state): a few hundred for
  the region. `date` is the item's acquisition day (`YYYY-MM-DD`, from its `datetime`), never a
  program year.
- **`cells`** — quarter-quad key → indices into `flights`: the pick's flight first, then any other
  flight that supplies at least one pixel to that cell (§2.2 step 4), most pixels first. A cell
  appears only if the archive has tiles in it; a cell with tiles always appears.
- **Size:** 9,168 cells at ~15 bytes each is ~140 KB raw, ~30–40 KB gzipped (an estimate; the pilot
  measures it). Uploaded gzip-encoded (`Content-Encoding: gzip`), immutable, so the browser fetches
  it once and caches it.
- **Where it lives:** beside the archive, `…/naip-summer-<YYYYMMDD>-cells.json`, its URL derived from
  `VITE_NAIP_PMTILES_URL` (`.pmtiles` → `-cells.json`, core's `naipIndexUrl`). It names its archive,
  and the client refuses an index that names another (a mismatched pair never draws). Its SHA-256 —
  of the decoded JSON, not the gzip body (the encoding is transport) — is in the manifest.
- **Built by** the assembler from the manifest and the shards' per-cell counts (copied from the
  current manifest's `cellCounts` for unchanged work tiles); **checked** by verify (§2.5), which refuses to
  publish an archive with any tile whose cell the index can't date.

**How the map uses it** is §4.2: the cells under the view, their flights, and the credit's month
range. **"Date unknown" is never a shipped state**: the build won't publish one, and the map never
draws the layer until its index has loaded.

### §2.8 — Decide before you write (the eighth review)

**The rule.** Every stage decides before it writes. On any refusal path a stage has written
nothing — not to R2, not to the campaign's scratch files a later stage reads, not a Fly Machine, and
nothing to its run row beyond opening it and closing it failed. Four review rounds in a row found a
stage that wrote first and refused after (a manifest, a done record, a shard, a row's terminal
state); the seventh ("What the build found", the PR's seventh review) was the tiles stage
uploading a changed selection over the build manifest and only then reaching `spawn.sh`'s
live-assembler check.

**The shape.** Each stage is a **preflight** (`src/preflight.ts`) and a **body** (`src/stage/`). The
preflight reads every fact a refusal depends on — the arguments, the campaign's lock, where its
rows may go, which variables are set, whether the campaign is published and from which inputs, what
the bucket's build manifest and record say, whether its assembler or any of its work tiles' Machines
is up (`spawn.sh status`, the one file that knows how Machines are named), which work tiles have
landed — through a `ReadView`, a
world with no way to write, each fact read at most once (`CampaignFacts`); it returns a plan or
throws a `StageRefusal`. The body carries the plan out. Every refusal has an id (`src/refusals.ts`,
102 of them since the ninth review and its independent pass); `refusals.test.ts` scans the source so that every refusal constructed names an id from
the catalog and every id is thrown somewhere, holds `CASES` (typed `Record<RefusalId, …>`, so an id
without a case fails `check-types`) and runs each case against a world that records every write
(`stageHarness.ts`), asserting the named refusal, no write beyond the row's open and failed close,
and the bucket and scratch byte-identical; a property test does the same over random combinations
of the facts for the tiles and assemble stages, and holds that under a live assembler the build
manifest never moves. The shell's exits are classified line by line in `tilesScripts.test.ts`: each
refusal runs against its stand-ins and starts no Machine and writes nothing; `cut-aerial.sh`'s order
is held structurally (no R2 write before `unput "$DONE_KEY"`).

**Two allowances, named.** The kept walk and the score caches are memos of reads — written once,
never replaced, read back so a re-run decides the same build (§2.1) — and may be written before a
select refuses on what it computed from them. A failed check in **verify** is its verdict, not a
refusal: the report is written (no later stage reads it) and the row closes failed.

**What can't be decided before a write** — races that exist only once something is started:

- **What only the assembler can decide** (a shard's index against its record, the date index's own
  check, an empty zoom, a copied work tile's counts): the Machine has to be started to read every
  index. It decides before its first write — no progress object is written until it has (the
  latest event is held and handed over then) — and on a refusal leaves only its error object, which
  the laptop relays as `assemble.machine`. Everything a handful of reads can decide is decided on the
  laptop first (published, orphans, landed, the base), so a Machine is started only for these.
- **The record that lands** is held to the build manifest again (`finishedAssembly`): an assembler
  attached to, or one that started from a manifest replaced between the laptop's preflight and its
  own read, may have built other inputs. Reachable only from a second machine (the lock covers
  every checkout on this one); never exposed — verify refuses it and nothing points the web at an archive verify
  hasn't passed.
- **`spawn.sh tiles`' own assembler check** stays, for an assembler started between the preflight's
  listing and the spawn (from another machine); it refuses before any `fly machine run`, but after
  the manifest upload — and the next tiles run, with the published selection, puts a drifted build
  manifest back (below).
- **A round's capacity wait past its first batch** fails after some spawns, by design: those Machines
  land their own shards, and the next round or a re-run (which waits for live work tiles) carries on.
- **A worker the laptop can't see, under a live assembler** (*the PR's ninth review*). The laptop
  starts no assembler while any of the campaign's work-tile Machines is up
  (`assemble.workTilesRunning`), and the tiles stage reconciles only once none is (`spawn.sh drain`
  before every reconcile; a wait that gives up fails the stage). Neither reaches a worker started
  from a second machine, or one Fly's listing missed. The assembler, which can't see Fly, checks its
  own reads instead: it keeps a hash of each cut work tile's done record as step 1 read it, and once
  its last pack byte is read — before the archive's upload completes — reads every one again. A
  worker drops its done record before it overwrites the pack and uploads its new record last
  (`cut-aerial.sh`, held structurally by `tilesScripts.test.ts`), so a pack replaced at any moment
  after step 1 read its record leaves that record gone or different: the assembler abandons the
  upload (rclone rcat killed before its stdin ends: no object, at most an unfinished multipart
  upload — H5) and refuses `assemble.shardReplaced`, relayed by the laptop as `assemble.machine`.
  **The residual window is none for the archive's bytes**: every read of a pack (the overviews' and
  the stream's) happens between the two reads of its record, and the index and the date index come
  from step 1's reads of the same records. What it rests on: R2's strong read-after-write
  consistency, and every worker keeping `cut-aerial.sh`'s order (a worker image older than the
  drop-first fix would not — the done records name their image). A pack replaced after the second
  read can't reach this archive; it is the next tiles run's to reconcile.

**Writes in order, and what an interruption between two leaves** (each stage takes the campaign's
lock first — `${XDG_CACHE_HOME:-$HOME/.cache}/skating-aerial/locks/<campaign>.lock`, one directory for
every checkout on the machine — and releases it last, however the process ends short of `kill -9` or
a power loss; one left so is refused `lock.stale` by every later stage, naming the file to remove and
the holder's log):

| Stage | Facts read before any write | Writes, in order | Interrupted between … | Leaves | A re-run |
| --- | --- | --- | --- | --- | --- |
| select | args, lock, row target, `R2_BUCKET`, `NAIP_MANIFEST_URL`; then (row open) strikes confirmed, `--cells`, the current manifest checked, the published manifest | lock → row open → [kept walk: state files, `walk.json` last] → [thumbs, score caches] → `manifest.json` → cloud sheet → row close | walk files and `walk.json` | a walk with no record | walks again (a snapshot without its record is none) |
| | | | manifest and sheet | a manifest with no sheet | decides the same build (kept walk, cached scores) and writes both |
| | | | sheet and row close | a row left running (no aerial kind is ever called stalled) | opens a new row; the old one stays running — cosmetic |
| tiles | args, lock, scratch manifest (a pilot's never built on a build), units (pure), row target, `R2_BUCKET`, published and build manifests, `AERIAL_IMAGE`, Fly (assembler up?), under a live assembler the done records, the snapshot's keys | lock → units → build manifest → snapshot → row open → per reconcile: wait until no work-tile Machine of the campaign is up (`spawn.sh drain`), then read the done records → per round: list file, Machines (each: drop done, pack, index, done) → row close | units and the upload | units for a manifest not yet uploaded | rewrites the units, uploads |
| | | | the build manifest and the rounds | the bucket naming the new selection, its shards not yet cut | an assemble refuses `assemble.notLanded` before any Machine; tiles cuts what is outstanding |
| | | | inside a round (the laptop asleep, a lost stage) | Machines still running — perhaps an earlier selection's, their old done records still standing | waits until none of the campaign's work-tile Machines is up, then reconciles by done record against the manifest it has; never doubles one, and never succeeds over a live one (assemble refuses meanwhile) |
| | | | a Machine's drop and its done record | the work tile outstanding | re-cut by the next round |
| assemble | args, lock, `R2_BUCKET`, row target, build manifest, record, Fly (assembler up? work tiles up?), the error object's time, published manifest, the publish prefix's listing, the base manifest, the done records | lock → row open → Machine → [Machine, once decided: progress → archive (one multipart upload) → index → manifest → record] → row close | the Machine's start and its archive (or a shard replaced under it, a failed read, a stop, a crash: the upload abandoned, `rcat` killed before its input ends) | at most an unfinished multipart upload (no object) | starts it again (or attaches to it) |
| | | | archive and index; index and manifest | an archive (and index) no manifest names | refuses `assemble.orphans` before any Machine: delete them by hand (ruling, §2.5), assemble again |
| | | | manifest and record | a published campaign with no record | refuses `assemble.publishedNoRecord` before any Machine (new: it started a Machine that refused "already assembled"): only while nothing has served them, delete exactly the three published keys it names by hand, assemble again (README; the build prefix stays) |
| | | | the record and the row close | a row left failed or running | takes the record, closes a new row succeeded |
| verify | args, lock, `R2_PUBLIC_BASE_URL`, row target, `R2_BUCKET` | lock → row open → report → viewer → row close | report files | part of a report | writes it afresh (read-only on R2) |
| cleanup | args, lock, `R2_BUCKET`, the publish prefix's listing, the web's env files, the plan (every refusal) | lock → old build prefix → old index → old manifest → **old archive last** | any two deletes | the archive and some of the rest | plans again (the archive its refusals read is still there) and deletes the rest — **fixed**: the archive went first, and a re-run then refused `cleanup.absent` with the index, manifest and build prefix left behind |
| foliage | args, lock; the review and the applied dry run decided | lock → [walk, caches] → applied manifest → its cloud sheet → proposal → review sheet | any two | part of the review | rewrites all four — **fixed**: the proposal and sheet were written before the applied select, whose refusal then left them beside no applied manifest |

**The operator's sequences**, each a test (`operatorSequences.test.ts`):

- **select → tiles → interrupted → select with changed picks → tiles**: the new selection is uploaded
  and its changed work tiles re-cut; assemble then builds it, and every identity agrees.
- **The same during assembly** (the seventh review): tiles refuses `tiles.assembling`, the build
  manifest byte-identical; restoring the selection, tiles has nothing to cut and uploads nothing
  while the assembler is up; it finishes from what it read, and the record, the published and the
  build manifests name one build.
- **The same after publication**: select and tiles refuse `published.otherInputs`, nothing moves.
- **A build manifest that drifted under a published campaign** (this finding's leftovers, or the race
  above): the next tiles run with the published selection puts it back — never while the assembler
  is up — and verify passes again.
- **Two terminals, one campaign** (from one checkout or two): the second stage refuses `lock.held`,
  naming the first and its checkout; the first finishes and frees the lock.
- **`--from-current` while its base campaign assembles**: refused `select.fromCurrentUnpublished`
  (the base's manifest names no archive until it is published), or `select.fromCurrentRead` when
  the URL doesn't answer yet.
- **An interrupted cleanup**: the re-run finishes it.
- **Select A → tiles → select B → tiles, interrupted with B's Machines up → select A → tiles** (the
  ninth review): tiles waits for B's workers, then re-cuts what they replaced with A's; nothing
  succeeds while they run, and assemble refuses `assemble.workTilesRunning` until they have gone.

---

## §3 — On demand and by cron

### §3.1 — One entry point

`scripts/aerial/run-aerial.sh` — a new package, `@skating/aerial`, beside `scripts/imagery` (whose
Fly app it reuses, with its own image), shaped like `scripts/etl/run-corpus.sh`: it logs itself with
timestamps to `scripts/aerial/.scratch/run-<campaign>.log`, refuses to be piped, and carries one
campaign id across every stage. Every stage CLI (`src/cli/<stage>.ts`) reads the same arguments
through `stages.ts`' `parseStageArgs`, which takes `--flag value` and `--flag=value` alike.

```text
run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]
              [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>] [--dry-run]
              [--old <key>]
```

- **`all`** runs select → tiles → assemble → verify, stopping at the first refusal.
- **One stage** re-runs that stage against the campaign's stored manifest — under a campaign already
  published, only with the inputs it was published from (§2.4: the same are already done, others
  refused).
- **`--states` / `--cells`** narrow what is *considered changed*, not what is selected: the rule is
  always applied to the whole catalog (a cell's pick can come from a neighboring state's flight), and
  then only cells in those states (or listed) whose stack differs from the current archive's are
  re-tiled. **`--from-current`** is the partial rebuild: diff against the current manifest, re-tile
  the changed work tiles, copy the rest from the current archive (§2.4). `--states` and `--cells`
  together are refused (one narrowing at a time); `--cells` lists one key a line, `#` comments
  allowed.
- **`--pilot <name>`** writes under `dev/naip/pilot/<name>/…`, never touches the production key
  names, and writes its run rows only to a local deployment (it refuses dev and prod). The flag and
  the campaign go together: `--pilot` needs a `naip-pilot-<YYYYMMDD>` campaign and a pilot campaign
  needs `--pilot`, so no key can put a pilot at the production names.
- **`--old <key>`** belongs to `--stage cleanup` alone, which requires it and takes nothing else but
  `--pilot` and `--dry-run`.

### §3.2 — What "on demand" honestly means

- **The heavy stages run on Fly**, spawned from the operator's laptop with `flyctl`, as A06e's
  backfills are. The laptop runs the orchestration for the build's wall time (about 7–9 h for the
  region on 25 `performance-4x` Machines by the pilot's figures, §6.1; a pilot minutes), so it must stay awake (`caffeinate`) — but every stage is
  resumable, so a laptop that sleeps costs a re-run of the reconcile, not the work done.
- **Convex can launch Fly Machines** — the live imagery pump does (`imageryLive.ts`, `lib/fly.ts`,
  `FLY_API_TOKEN` and `FLY_IMAGE` on Convex dev since 2026-10-09). So a console *Rebuild* is
  technically reachable. It is not built here: an overnight campaign with its run rows written through
  `RunLogger` (the `convex run` CLI with a deploy key) and a long-lived assembler is B01's deferred
  *hosted ETL runner* decision, not a button. Governor fork G-5 weighs a Fly "conductor" Machine as
  the step between.
- **So in this phase**, "on demand" is the command (D218): the July check's record carries the exact
  command, with the campaign id and flags filled in.

### §3.3 — The July reassessment

A Convex job, `aerialReassess`, on the recurrence rollover's shape: **a daily tick with a month
gate** (a no-op outside July, and a no-op again once the year's check succeeded — read from
`importRuns`' `by_kind_started`), so a failed 1 July is retried on 2 July rather than next year. An
admin can also run it at any time with `convex run` (a Machinery *Trigger* once that page exists,
D218, with nothing to dry-run because it writes only its finding).

What one check does, in one action:

1. **Reads the current manifest** from `NAIP_MANIFEST_URL` (public, immutable, ~1.5 MB).
2. **Enumerates the catalog** — the same ~70 STAC pages the select stage reads, against a deadline
   inside the action limit; items held as compact candidates per quarter-quad (a few MB), not raw
   STAC JSON.
3. **Applies the core rule** with the committed exclusion list and the committed foliage strikes
   (D319), and compares the cells the off-season step reaches with the manifest's `offSeasonCells`:
   a cell new to it (or one that left it, a newer green flight) is reported in the finding by name.
   New September frames are not foliage-scored here; the offer says they are unreviewed.
4. **Diffs** picks and stacks against the manifest: per state, the changed cells, the newest
   leaf-on flight among their new picks and the oldest date it would replace; the count of new picks
   with no reviewed cloud score.
5. **Writes its run row** (`aerial_reassess`, scope `survey`), whose notes and counts carry the
   finding in words, and — when something changed — **the durable record** (below).
6. **Offers, never spends**: the offer is the stored record and nothing else — no email, no
   notification (the founder: no interim surface). Nothing starts a Machine. Until Machinery's page
   exists, the run row is readable on the old Imports page (`/admin/imports?run=<id>`), which needs
   nothing from this phase.

**The record: `aerialOffers`** (one table, B05-2's schema; the Machinery imagery page's future read):

- `status`: `open` · `built` (a build whose manifest postdates the offer was published; the next
  check closes it) · `superseded` (a later check found a different diff and opened a new offer).
- `openedAt`, `checkRunId` (its `importRuns` row), `closedAt?`, `closedByRunId?`.
- `builtFrom`: what the live layer was built from — the archive key, the manifest's build date, its
  rule version and catalog snapshot date.
- `states`: per state, the changed cells' count, the newest flight among the new picks, the oldest
  date it replaces.
- `cells`: at most 500 changed cells (key, the current flight date and gsd, the new one's), and
  `totalCells`; the full diff is recomputed by `--from-current`, so the row never approaches Convex's
  8,192-item array cap.
- `unscored`, `offSeasonChanged` (counts: new picks with no reviewed cloud score; cells joining or
  leaving the off-season list), `command` (the exact `run-aerial.sh` line, formatted by
  core's `aerialRebuildCommand` so the script and the offer agree).
- Index `by_status_opened`. One open offer at most: an unchanged diff on a later check leaves it
  open and sends nothing.

**Where it is drawn**: nowhere in the console yet. Machinery's imagery page (B01's Machinery mode,
§3.4) draws the open offer with its cells, dates, source and command, and *Run now* for the check —
a register row owed to that mode. The founder expects Machinery built long before the first July
check; the record waits for it either way.

**Bounded.** No document read scales with the corpus: the manifest and catalog are fetched, not
stored; the mutations read and write one or two rows. Convex's 1 s limit binds queries and
mutations, not the action; the action's own limit binds the catalog walk, which is why it has a
deadline and a page count.

**Failure-reporting.** A new `FAILING_JOBS` member, `summerAerial`: the tick is all-or-nothing, so
like `seasonWatch` it is counted, never parked; a failed check leaves a failed run row and
Machinery's health read shows it; the July gate retries daily. A catalog answering short (fewer
items for a state than the manifest's snapshot held) is a failure, not "unchanged".

**Copy holds to D3**: the record and the run row speak of a *summer photograph* and its flight dates,
never of ice or conditions.

### §3.4 — Machinery, today

Checked against the code at `11290f1f9`: **the console has no Machinery mode.** `CONSOLE_MODES`
(`apps/web/src/components/admin/shell/consoleNav.ts`) holds Overview, Inbox, Corpus and People;
there is no `/admin/machinery` route and no `components/admin/machinery*`.
`packages/convex/convex/machinery.ts` is the Overview's *Machinery* card's read (`overviewJobs`: the
imagery poll, pump and index, the metric rollups, the last import), not a page. Imagery runs are
managed on the old `/admin/seasons` page's *Satellite imagery* section and import runs on the old
`/admin/imports`. The mocks draw a Machinery imagery page (`machinery-imagery-v5.html`: a band of
crons with *Run now*, the granule ledger) that a *Check for newer summer flights* cron card and an
offer band would slot into — but building it means building the mode, which is B01's §5.5, not a
small slot. So the page is a register row owed to Machinery, and B05 stores the record it will read.

*Since #189 (B01-8a, D340–D346), merged into this branch 2026-11-27:* the mode exists —
`/admin/machinery`, with one page, Corpus — and watches a corpus campaign through the run logger's
lines, beats and one stall rule (core's `runLiveness`). The aerial's runs are in none of it yet: no
aerial kind is a corpus kind, so none is listed in a lane, and none has a gap in `RUN_QUIET_MS`, so a
quiet one is never called late (its stages report per round, per 25 work tiles, per zoom and per
check — irregular, and hours long). A run page opened from the Overview card reads one plainly.
Giving the aerial its own lane, a gap per stage and the logger's `beat()` is that page's work.

---

## §4 — The app

### §4.1 — The console's aerial becomes one raster source

`consoleAerial.ts` keeps its contract with the map and the rack and changes its source:

- **One `pmtiles://` raster source** on the shared protocol handler (`apps/web/src/lib/mapCanvas.ts`,
  refcounted), `url: pmtiles://<VITE_NAIP_PMTILES_URL>`, so MapLibre reads the zoom range and bounds
  from the archive's header. Tile size per Governor fork G-2.
- **Added only once its date index has loaded** (D318, §4.2), and only to the live map (`liveMap()`,
  the theme-switch lesson); re-added with the new mode's paint after a switch.
- **D312's behavior kept**, staff only (D316): the *Summer aerial* rack row on every Body console
  tab, for any console staffer, remembered per viewer, never reset by a tab; on, without a switch,
  under Class conflicts' head map; dimmed by mode (`AERIAL_PAINT`); placed by `consoleAerialAnchor`
  (under any winter pass, else the console's raster band — over the body's fill, under hazard fields
  and every line).
- **The rack's names** (the founder, F-6 a): the winter pass's row, today *Aerial*
  (`BodyMapPane.tsx`), becomes **Winter satellite**; this layer's stays **Summer aerial**.
- **Every map that draws it** reads the same source and the same credit: the Body console
  (`useBodyMapCanvas.tsx`, `BodyMapPane.tsx`), the Corpus head maps (`CorpusHeadMap.tsx`), the
  Inbox's maps (`InboxMap.tsx`, whose `aerial` switch is drawn only where a caller asks for it, In30),
  the stills in stories and boards (`BodyMap.tsx`), and the old lake editor (`LakeEditorMap.tsx`,
  `/admin/water/$id`) while it stands.
- **Overzoom.** The head maps' ceiling of 19 is past the archive's deepest level; MapLibre overzooms
  a raster past its source's `maxzoom` natively, so no code is needed.

**Loading and failed** keep their words and the credit's dock:

- `loading` from the switch on until the source reports its view's tiles loaded (`sourcedata` for
  this source id with `isSourceLoaded` — never `idle`, which doesn't fire after a late `addSource`).
- `failed` when the archive's header **or its date index** can't be read (a 404, a CORS refusal, no
  network, an index naming another archive): nothing draws; *Try again* drops and re-adds both.
- `partial` when some tiles errored (MapLibre's `error` events for this source); *Try again* reloads
  the source.
- The *"no timeout, because an abandoned cold render isn't cached"* rule goes: tiles are static.

**Blank URL ⇒ the layer never mounts** (the bathymetry rule): no rack row, and the head map draws
without it. D312's "never disabled" holds for a row that exists.

### §4.2 — The credit: the dates under the view (D318)

The credit dates **the whole view**, not its center:

1. **Which cells.** Core's `quarterQuadsIn(bounds)` enumerates the 3.75′ grid keys over the map's
   visible bounds, on load and on every `moveend`. At the console's z8 floor a 1440 × 900 view spans
   about 78 × 40 cells (~3,100 keys), a cheap loop; zoomed in to a body it is a handful.
2. **Which flights.** Each key in the index contributes its flights (§2.7); a key absent from the
   index has no tiles, so nothing of the layer is drawn there.
3. **What the credit reads** — core's `naipCreditRange(index, keys)`, the earliest and latest
   flight, as month and year:
   - one month: *Aerial · NAIP Jun 2023*;
   - several: *Aerial · NAIP Jun 2021 – Aug 2023* — every photograph on screen was flown between the
     two, so none is misdated by a single cell's date;
   - no cell in view (past the coverage, into Canada, out to sea): the layer draws nothing there, and
     the credit says no photograph covers this view (*Aerial · NAIP · none in view*), never a dateless
     *Aerial · NAIP*;
   - while loading, the existing suffix (*· Loading…*).

   The words are drafts for the founder's copy pass. The October cells read their month (*Oct 2023*)
   like any other.
4. **No service call.** The index is fetched once a session, before the source is added; Co18 (the
   identify call refused for CORS) closes with the call deleted.

**Never undated.** The build refuses an archive with an undated cell (§2.5); the map adds the source
only after the index has loaded and named this archive; an index that fails to load fails the layer
(nothing draws). So no frame of the summer aerial is ever on screen without its date.

### §4.3 — The USGS path is deleted

Once tiles ship, nothing draws from `imagery.nationalmap.gov`, and its code goes in the same PR
(D305's rule for a replaced path):

- **Web:** `useImageryReveal.ts` and its test; `lib/imageryCache.ts` and `lib/imageryCanvas.ts` and
  their tests; the exportImage and identify halves of `consoleAerial.ts` (`aerialDate`,
  `creditPoint`, `forgetAerialDates`, the reveal call, `aerialMasks`); `useImageryReveal.test.ts`'s
  entry in `src/test/domTests.json`. **The old lake editor** (`LakeEditorMap.tsx`, `/admin/water/$id`)
  is the hook's only other caller (it draws NAIP unmasked under the editor, A06e §5); it switches to
  the same archive layer and credit — a few lines — so the hook has no caller left.
- **Core:** `aerialImagery.ts` (`aerialExportUrl`, `aerialIdentifyUrl`, `parseAerialScene`, the
  scene-name parsers and formatters) and `imageryTiles.ts` (the grid-snap), with their tests, once a
  search shows no other reader (the design's search found none outside the reveal).
- **What stays:** the constants and helpers the winter passes import from `useImageryReveal.ts` —
  `FREEZE_UP_LAYER_PREFIX` and `insertBeforeLayerId` (`useFreezeUpFrame`, `useFreezeUpSeam`) — move
  to a small module of their own; whatever of `imageryLayers.test.ts` tests a survivor moves with it.
  **`IMAGERY_LOADING_LAYER_ID` does not survive**: its one reader is the skater map's `imagery-loading`
  wash layer (`skater/map/mapLayers.ts`, about eight lines and an import), filtered to match nothing
  and written by nothing since the hook lost its skater caller; it is deleted with the hook (D316). `imageryMask.ts` in core stays (the winter
  passes' mask bake and `landmarks.ts` use it; `AERIAL_MASK_METERS` goes if nothing else reads it).
- **What a skater sees: nothing changes** (D316). Checked 2026-11-25 at `11290f1f9`, for the founder's
  *"I'm not sure if they currently can or not"*: **no skater can see a summer aerial today**, on the
  web or the phone. On the web, `useImageryReveal`'s only callers are `consoleAerial.ts` and
  `LakeEditorMap.tsx` (both admin); its skater caller, the old `MapView`, went in B03-4 (#98); no
  `_skater` route, skater component or toggle reaches NAIP, and the skater web's imagery is the winter
  passes alone (`ImageryPane` → `useFreezeUpFrame`). What is left is dormant: the wash layer above,
  and comments that still speak of a skater reveal (`skater/map/useMapSpec.ts:78`,
  `lib/mapAttribution.ts:10`, `lib/env.ts:53–54`, `skater/map/mapLayers.ts:4`), which W corrects in
  passing. On the phone there was never a summer tier (`apps/mobile/src/components/MapView.tsx:417`,
  `FreezeUpFrames.tsx:6`, `ImageryDock.tsx:60` say so; nothing fetches NAIP).
- **A guard** (`packages/guards`, since it reads the apps' sources): no `nationalmap.gov` anywhere in
  `apps/` or `packages/`, and the summer aerial's source and credit imported by no file under
  `apps/web/src/components/skater/` or `apps/mobile/` (D316 held by the build, not by habit).

### §4.4 — The env var

`VITE_NAIP_PMTILES_URL` — the archive's public URL. Named for the source, not the rack's label.
The date index's URL is derived from it (`.pmtiles` → `-cells.json`). Set, as the bathymetry archive
is: both local web checkouts (`apps/web/.env.local`, where the checkouts keep their URLs; cleanup
reads every env file Vite does), Vercel Preview and Production,
`apps/web/.env.example` (blank), the web README's table, and `05-accounts-and-credentials.md` § 2c.
Not EAS: mobile has no console and never draws it (D316). Convex dev gets `NAIP_MANIFEST_URL`
(§3.3), registered in § 2a.

---

## §5 — Risks and rules

### §5.1 — D3: a summer photograph, with its date

The layer is a photograph flown in summer, two to three years apart per state (D147) — and in the
cells the off-season step reaches (§2.1 step 5), in autumn or October. It is never evidence about
ice, and no word may say it can or can't show any: the rule keeps a cell's newest sharpest frame
whatever its season when nothing better is flown, so an absolute claim would be one the catalog can
break. The credit names the program and the flight months under the
view (D318); the July record speaks of flights and cells. No word anywhere calls it current,
live, or satellite "of today".

### §5.2 — D48 takedowns: the lever is display

D48's takedown is a soft-delist of **a water body** (`listed: false`), so the body leaves the map;
it says nothing about imagery and needs nothing from it. The archive is a public-domain mosaic of the
region, not tied to any body, so a landowner's request has nothing in it to remove — and the
console, the only surface drawing it, is staff-only (D312, D316). Confirmed against D48's text.

### §5.3 — The public URL

The archive is public on R2 like the basemap and bathymetry, and its URL is in the web bundle (the
console is a route of the same app), so anyone can read it — NAIP is public domain, so the exposure
is cost, not license, and it is not a skater surface (D316). Cloudflare's edge won't cache an object
this large, so every tile is an R2 Class B read: 10 million free a month, $0.36 per million after.
Staff use is far below that. **The trigger**: the cost ledger (D219) showing R2 reads past the free
tier, or Class B reads not explained by staff sessions; the answer then is a Worker in front of the
archive caching per tile (the protomaps serverless pattern), or a token on the read.

### §5.4 — Seams and the quilt

Adjacent cells from different flights differ in color and in leaf-out. The cutlines make the seams
straight and exact (§2.2), but at low zoom the region reads as a patchwork of state flights and
years. In the console, fenced to one body and usually zoomed in, it is mostly invisible; the verify
report shows it before anyone else does, and the credit's range says when a view mixes flights.
Color matching is out of scope (§1.3).

### §5.5 — The Maine North Woods and other old cells

Maine 2023 didn't fly 565 quarter-quads in the North Woods; they fall back to ME 2021 (807 cells) or
ME 2018 (258) at 0.6 m. That is a recency gap, not a hole. The six October-only cells north of
Rumford take their 2 October 2023 0.3 m frame, in autumn color (§2.1, the founder's ruling, confirmed
2026-11-27). The credit's dates say how old and which month each is. **Revisited 2026-11-27 (D319)**,
once the pilot showed the September flights in color too: turned flights are struck by the founder's
review of flight days (§2.1.4), which moves about 450 Maine cells to ME 2021 or 2018 at 0.6 m, and
the ~80 cells around Rangeley, Rumford and Kingfield with no green frame at 0.6 m or better keep
27 September 2023 at 0.3 m in autumn color, named for the July check.

### §5.6 — Coast and border nodata

Past the last quarter-quad there are no tiles (`--skip-blank`): the map shows the basemap's ground
and water, which is honest — no photograph there. Inside a cell, pixels no frame covers (a border
flight's edge with no fallback) are transparent the same way. The photograph stops 0–7 km into
Canada with a hard edge.

### §5.7 — Convex's limits

The July action fetches and diffs in memory; its mutations read and write one or two rows; its
offer holds at most 500 cells. No `.paginate()`, no corpus-wide read.

### §5.8 — Credentials

What exists (the register, 05 § 1): the Fly app `skating-imagery` with R2 credentials staged;
`flyctl` logged in on this machine (and the app's scoped deploy token, `FLY_API_TOKEN`, where a
non-interactive spawn needs one); `FLY_API_TOKEN` and `FLY_IMAGE` on Convex dev for the live pump; R2
tokens scoped per bucket; Planetary Computer needs no account (anonymous STAC and SAS). **What may be
new, a founder task:** if the archive lives in a bucket the app's staged R2 token can't write (G-6),
a token scoped to that bucket, staged on the app; and `NAIP_MANIFEST_URL` on Convex. The founder sets
both; no brief displays a value. Every brief that touches them carries CLAUDE.md's rule verbatim
(§10.2).

---

## §6 — Sizes

### §6.1 — The archive

The design's figures were the scouts' (6.59 M z17 tiles over ~324,000 km², WebP q80 at 8–21 KB a
256-px land tile), ±30%. T's warp proof measured real 512-px tiles on three windows (§9, *What the
build found*), and the integration checked T's arithmetic (2026-11-26). **z18 everywhere** (D317):

| | Design | T, measured | Integration's figure | **The pilot, measured, re-extrapolated** (2026-11-26) |
| --- | --- | --- | --- | --- |
| Archive | ~387 GB | 375–700 GB, ~525 GB central | 380–700 GB, ~550 GB central | **~260 GB (220–300)** — 28 work tiles, 4.08 GB, 26.6 KB a tile over every zoom |
| R2 storage | ~$5.80 / month | ~$8 / month | ~$8.30 / month ($5.70–$10.50) | **~$3.90 / month** ($3.30–$4.50), ~$47 a year |
| Fly compute, a full build | ~220 machine-hours, ~$4 | ~410 machine-hours, ~$7.60 | ~400 machine-hours (320–540), ~$7–10 — unless shared CPUs throttle (below) | **They throttle.** On `performance-4x`: 256 s a work tile (178–356), ~125 machine-hours (87–175), **~$23** ($16–32) at Fly's published performance rate |
| Wall time on 25 Machines | ~9 h | ~16 h | ~16 h (13–22) | **~5 h of tiles** (3.5–7.5) + ~1.5 h assembly + verify: **~7–9 h** |
| Fly outbound transfer | ~2× the archive, ~$15 | ~1 TB, ~$21 | ~1.1 TB, ~$22 (0.75–1.4 TB) | **~520 GB, ~$10** (440–600 GB) |
| A fully covered work tile's shard | ~220 MB | 235–440 MB | 235–440 MB | **176–202 MB on land**, 62–75 MB on Champlain's open water |
| Source read from Azure | 9–10 TB (whole stacks) | 2–9 GB a work tile | | **0.86 GB a work tile** (0.35–2.5; the border tiles read most): **~1.5 TB** (1–2.5), inbound, free |
| Pixel at 44°N | 0.43 m (1.4 ft) | | | |
| The date index | ~140 KB raw, ~30–40 KB gzipped | | not re-measured (the integration's one-tile run: 169 B for 3 cells) | 4,297 B raw, **808 B gzipped** for 209 cells and 17 flights (P's region proof: 26 KB gzipped) |
| The manifest | 1.5–3 MB raw | | ~6–7 MB raw for the region: the integration's pilot manifest, which records every cell and frame, was 5.4 MB before any work tile's counts | **5.41 MB** published with its 28 work tiles' counts |
| A full run, all told | ~$20 | | ~$30–40 | **~$37** ($28–48): ~$23 compute, ~$10 transfer, ~$4 the first month |

**What the pilot changed (2026-11-26).** The tiles are about half the size T's windows suggested at the
deepest zoom — a tile-zoom-17 512-px tile averaged **21 KB** (land 25–27 KB, Champlain's water 10 KB),
the shallower ones 36–87 KB; per tile zoom over all 28 shards: z11 49.7, z12 57.8, z13 67.7, z14 72.2,
z15 61.7, z16 36.4, z17 21.0 KB — so the region is ~260 GB, not ~550. The extrapolation: 1,764 work tiles at the design's 91% fill is ~1,605
fully covered ones × 140–185 MB a shard (the pilot's mixed mean 146 MB; its land 176–202 MB). And a
`shared-cpu-4x` **does** throttle: its burst balance (19,342) drained in about three minutes, after
which the Machine ran at ~0.44 of a core with 28% steal; on `performance-4x` no tile throttled at all
(throttle counter 0), used 318 CPU-seconds a tile on average (227–400: ~1.2 cores of 4 busy), and peaked
under 0.6 GB of its 8 GB. So **`spawn.sh` spawns work tiles on `performance-4x` with 8192 MB by
default** (the governor, 2026-11-27; performance sizes need 2 GB a CPU), the size every figure above
assumes; the assembler stays on `shared-cpu-4x` (97 s in the pilot). Read with §6.1's older columns as
history.

**What the foliage review changes (2026-11-27, D319): nothing material.** The archive is z18
everywhere, so the tile count is the same whatever the picks; the first proposal changes 1,074 of
9,168 picks, and only 264 of them from 0.3 m to 0.6 m sources (0.3 m picks 4,316 → 4,052). The frames
the worker cuts fall from 11,481 to 11,457, the 0.3 m ones among them from 4,676 to 4,419, and the
source pixels decoded — the warp's work, in 0.3 m-equivalents — by about 3%; a 0.6 m source upscaled
to z18 may pack a little smaller, which the pilot didn't separate out (2.9% of cells, so under 1% of
the archive at most). The figures above stand: ~260 GB, ~$3.90 a month, ~7–9 h and ~$37 a full run.
Applying it **after** a full build instead would be a `--from-current` rebuild of ~615 work tiles
(35%: 429 touched by a changed pick, the rest by a reordered stack), ~$13 — hence the review first.

**Why the archive moved.** The design's 387 GB is the deepest level alone: 6.59 M 512-px tiles at
tile zoom 17 (the same footprint as a 256-px z17 tile) × ~59 KB, which is 14.7 KB a 256-px quarter —
inside the scouts' 8–21 KB, and no allowance above it. But the archive is a pyramid. Each level above
holds a quarter of the tiles below it, so tile zooms 7–16 hold 1/4 + 1/16 + … = **1/3 of the deepest
level's tile count**, and T's measurements show a shallower tile costs about what a deep one does
(Champlain 41.9 / 42.0 / 42.7 KB at tile zooms 15 / 16 / 17; the 72°W window 67.7 → 80.0 KB from 14
to 17; Maine 94.7 → 75.5 KB) — a downsampled tile packs more detail into the same 512 px. So T's
"overviews add about a third" is right, and the archive is 4/3 × the deepest level. The deepest level
itself: T's real tiles averaged 42.7 KB (a window half lake), 80.0 and 75.5 KB (land). The region is
mostly land, so a mean of ~62 KB (between the design's 59 and the land windows' 78, weighted for the
lakes and coastal quarter-quads) gives 6.59 M × 62 KB × 4/3 ≈ **545 GB**; the range is the measured
extremes, 6.59 M × 43–80 KB × 4/3 ≈ 375–705 GB. (The 6.59 M tile count checks: 9,168 quarter-quads of
~34.5 km² is ~316,000 km², over 0.048 km² a tile at 44°N, ~6.5 M.)

**Why the compute moved.** The design's ~7 minutes a work tile was the scouts' guess. The proof's
z14 windows took 71–130 s on the laptop, network-bound from the US, and a work tile is 64 of them at
full coverage (91% on average); the integration's run of a whole work tile against local sources
spent ~31 ms a tile on the laptop's cores, CPU alone, from 2.4 m sources (a real 0.3–0.6 m frame
decodes 16–64× more source pixels). On a `shared-cpu-4x` in `ams`, where the reads are ~10× faster
than the laptop's (T's estimate, not measured), that is roughly 12–20 minutes a work tile × 1,764 ×
91% ≈ 320–540 machine-hours; T's ~14 minutes, ~410 hours, sits inside it. **The risk the pilot
measures:** Fly's shared vCPUs carry a sustained-use quota (a baseline share of a core with a burst
balance), and a 15-minute CPU-bound tile may drain the burst and run throttled — if the pilot's
seconds per work tile are several times the estimate, the answer is a `performance` size, at several
times the hourly price, for the same total work.

**Transfer.** Fly bills outbound: the shards leave the work Machines for R2 (about the archive's size:
they hold tile zooms 11–17, all but a sliver of it) and the assembled archive leaves the assembler
for R2 (the archive again); reads into Fly — Azure's COGs, R2's shards — are inbound and free. So
~2 × ~550 GB ≈ 1.1 TB at about $0.02/GB (unverified): ~$22. R2 operations are pennies; R2 has no
egress charge. **A full region run is ~$30–40 all told** (compute, transfer, the first month's
storage), against the design's ~$20 — and ~$8 a month to keep (~$100 a year, against the founder's
"about $70 a year"). A partial rebuild costs its share.

### §6.2 — The code

Estimated per piece against the nearest measured analogue in this repo, then multiplied. **These are
design estimates**, re-estimated 2026-11-25 for the rulings — the date index and the per-cell counts
in, the Overview card, its *Dismiss* and the email out; the Corpus wave's design estimates ran ~4× low and its
briefs ~1.0×, and A06e's cutter grew from 154 lines at its first commit to 1,569 hardened.

| Piece | Analogue (measured) | Estimate, lines with tests |
| --- | --- | --- |
| Core: the rule (candidates, leaf-on, newest, 0.3 m window, off-season step, envelope, exclusions, stacks), the grid (`quarterQuadCell`, `quarterQuadAt`, `quarterQuadsIn`, work tiles), input hashes, the diff, the manifest and date-index types, the credit range, and their properties | `granuleSelection.ts` 309, `stacSearch.ts` 139, with tests | 1,500–1,950 |
| Select stage (catalog walk, thumbnail scoring, contact sheet, manifest, run row) | `selectGranules.ts` 346, `publishSearchPlan.ts` 81, `bakeMasks.ts` 304 | 900–1,300 |
| Worker (`cut-aerial.sh`, the stack, tiling, the per-cell counts, the pack) | `cut-granule.sh` 154 → 1,569; `tiles-to-mbtiles.py` 163 | 850–1,350 |
| Orchestrator (`run-aerial.sh`, spawn, reconcile, retries) | `fan-out.sh` 307, `backfill.sh` 238, `status.sh` 107, `run-corpus.sh` 243 | 700–1,000 |
| Assembler (TypeScript streaming PMTiles writer, the date index) and its round-trip tests | `tiles-to-mbtiles.py` 163 (simpler) | 800–1,200 |
| Verify (counts, spot reads, coverage, dates, seams, the viewer page) and cleanup | `buildIndex.ts` 129 | 500–750 |
| Container, Fly, README, the run kinds' widen | `Dockerfile` 114, imagery README 741 | 500–800 |
| **B05-1 sum** | | **~5,750–8,350** |
| Convex: the July check (action, `aerialOffers`, cron, `FAILING_JOBS`, the widen) and tests | `clerkReconcile.ts` 588 + 1,016; `seasonWatchEmails.ts` 267 + 256 | 1,300–2,000 |
| Web: the source swap on every map that draws it, the dated credit, the lake editor, the rack's names, the guard, stories and tests | B01-7a's aerial slice: `consoleAerial.ts` 286 + 212, `AerialCredit` 78 + 88 + 85, `aerialSwitch` 42 + 86 | 1,200–1,900 added; ~3,600 deleted |
| **B05-2 sum** | | **~2,500–3,900** |
| **Sum** | | **~8,250–12,250 new** (was 8,300–12,000) |
| **Honest range** (×1.5 at the low end, ×1.6 at the high, as the first estimate's 12,000–20,000 did) | | **~12,500–19,500 new; ~3,600 deleted** — B05-1 ~8,600–13,400; B05-2 ~3,800–6,200 added |

The size the founder was told stood at design. **Measured at B05-1's PR (#188):** ~23,000 lines
outside `plans/`, the fixtures, the proposal file and the lockfile — about 10,000 of them tests —
so B05-1 alone is past the 12,000–20,000 he was told for both PRs (§6.3).

### §6.3 — The PR plan

**Two PRs**, because the web swap can't merge before an archive exists on dev:

1. **B05-1 — the pipeline** (core rule, grid and date-index helpers, `scripts/aerial`, its image,
   the three run kinds' widen in `enums.ts` and `@skating/run-log`): ~8,600–13,400 lines estimated;
   **measured at the PR (#188), ~23,000 lines** outside `plans/`, the fixtures, the proposal file
   and the lockfile, about 44% of them tests (§6.2's estimate ran ~1.7–2.7× low). Over
   CLAUDE.md's ~5,000, for a reason: the rule, the worker, the assembler, the date index and the run
   record are one review boundary — a reviewer can't judge the warp stack without the manifest, the
   assembler without the shards' layout, or the index without the counts the worker takes. It merges
   after the pilot (§7.4) and before the full run, so the full run is from main.
2. **B05-2 — the app side** (the console's swap and the USGS path's deletion, the dated credit on
   every map, the lake editor, the rack's names, the July check and its record): ~3,800–6,200 added,
   ~3,600 deleted. It starts after the pilot and merges once the full archive is on dev and
   `VITE_NAIP_PMTILES_URL` points at it; the July job belongs here because it reads a published
   manifest.

Governor fork G-7 records the alternative (one PR, or three).

---

## §7 — Build model

### §7.1 — Builders and territories

The briefs are §10; this is the roster.

| PR | Builder | Territory (in short; §10 names every file) | Waits on |
| --- | --- | --- | --- |
| B05-1 | **X** — the seams | the `@skating/aerial` skeleton, core's typed stubs, the three run kinds, the shard and stage contracts | nothing: lands first, alone |
| B05-1 | **S** — selection | core's `naip*.ts` bodies and the inventory fixture; `scripts/aerial/src/{select,catalog,score}*` | X |
| B05-1 | **T** — tiles | `scripts/aerial/{cut-aerial.sh,run-aerial.sh,spawn.sh,Dockerfile,fly.toml?,README.md}`, `scripts/aerial/src/tiles*`, the warp proof | X |
| B05-1 | **P** — pack | `scripts/aerial/src/assemble/`, `verify*`, `cleanup*`, `viewer/` | X |
| B05-2 | **Y** — the seams | `schema.ts`' `aerialOffers`, `aerial_reassess` and `survey`, `FAILING_JOBS`' `summerAerial`, typed stubs, codegen, `06-data-model.md` | B05-1 merged and the pilot looked at |
| B05-2 | **K** — the July check | `convex/aerialReassess*.ts`, `lib/aerialReassess*.ts`, `crons.ts`, `recurringJobs.ts`' row | Y |
| B05-2 | **W** — the web | the console aerial, every map that draws it, the lake editor, the deletions, the guard | Y (types only); the full archive for its last proof |

### §7.2 — Seams and order

- **X lands first** (§10.3): the types every builder compiles against, the stage and key contracts
  `run-aerial.sh` and the stage CLIs share, and the shard's done record that T writes and P reads.
- **S ↔ T, P:** the manifest (`NaipManifest`) and the work-tile list. T and P build against
  hand-written manifests for the pilot cells until S's select stage lands.
- **T ↔ P:** the shard (`pack`, `idx.json`, the done record with its per-cell counts).
- **S ↔ K:** `selectNaipPicks(candidates, exclusions, offSeason)`, `diffNaipPicks(current, next)` and
  `aerialRebuildCommand` in core; K never re-implements the rule.
- **S ↔ W:** `quarterQuadsIn`, `naipIndexUrl`, `parseNaipCellIndex`, `naipCreditRange` in core; W
  never computes a date itself.
- **Order:** X → S, T and P in parallel → integration → the local proofs (§7.3) → the pilot (§7.4,
  gated) → `/code-review xhigh --fix` → B05-1 opens (#188, the strike list empty, the proposal beside
  it) → merge → the founder's foliage review by flight day (§2.1.4, D319; his confirmed strikes land
  as a commit) → the widen deployed to dev → the full run (the founder's go) → Y → K and W → B05-2
  opens → merge.

### §7.3 — What is proven how

- **The rule: properties on the real inventory.** `fast-check` over generated candidate sets (a pick
  is leaf-on whenever any candidate is; no leaf-on candidate is newer than the pick unless the pick is
  0.3 m within two years; the off-season step runs exactly where no green leaf-on candidate is left,
  with the right why; a foliage strike demotes, never drops; an excluded item is never picked or
  stacked; the stack is
  every other candidate in rule order; the answer doesn't depend on input order) **and** on a
  committed slice of the real inventory (~2,000–3,000 rows chosen to hold every edge class: the six
  October cells, the Long Island glare cells, Aroostook, the 319 two-state cells' kind, NY's April and
  October 2021–2024 frames, VT's and NH's January 2019 frames, the mislabeled Maine items, the 72°W
  line). The full 69,207-item catalog is checked by the select stage itself, each run (§2.1.3).
- **The grid.** `quarterQuadCell(key)` against every catalog footprint in the slice: the nominal cell
  sits inside the footprint with ~300 m to spare on each side. `quarterQuadsIn(bounds)`: any point in
  the bounds has its key in the set (a property).
- **The credit range** (`naipCreditRange`, a property): for any index and any set of keys, the range
  is `null` exactly when no key is indexed, and otherwise every flight of every indexed key lies
  within it, with both ends attained.
- **The warp stack on real COG windows, locally** (GDAL 3.13.2 on the Mac over `/vsiaz/` with a SAS
  token): a z14 window across the VT/NY line on Champlain and one across 72°W; asserted: alpha 100%
  inside the union of cells, no pixel painted by a neighbor's frame, a straight feature (a road)
  continuous across the cutline to a pixel, a partial frame falling through to its fallback, and the
  per-cell counts naming exactly the frames that show.
- **The worker, whole, start to upload** (`cutAerialServed.test.ts`, where GDAL's Python bindings
  are, so not on CI): `cut-aerial.sh` itself with real bash, curl, jq, GDAL, the counts helper and
  the packer, only the network's edges stood in — a local server answering as Planetary Computer's
  SAS and STAC endpoints and as the blob store (byte ranges, through GDAL's own `/vsiaz/`), serving
  synthetic frames, and `--local` for R2. Three shapes, each to the upload and exit 0, the bytes the
  worker reports equal to the bytes the server sent: three single-frame cells, a pick over a fallback
  that shows, a strip the counts' grid can't see. On CI the same script runs on stand-ins
  (`tilesScripts.test.ts`), across cell counts and stack depths that put an empty stats file last.
- **The assembler:** round trip from synthetic shards plus an old archive: every tile read back by the
  `pmtiles` JS reader byte-equal, clustered order checked, the date index naming every tiled cell,
  `pmtiles verify` clean on the output.
- **The Convex job:** `convex-test` under the suite's harness, with the catalog and manifest fetches
  faked: unchanged, changed, short catalog (failed), the July gate, the offer opening once, a later
  identical diff leaving it untouched, a different one superseding, a newer manifest closing it as
  `built`, no email or notification sent on any path, `FAILING_JOBS` counted.
- **The web:** the source added only to the live map and only after its index, re-added on a theme
  switch, the states' transitions from MapLibre's events, the credit's range as the view moves (one
  flight, several, none in view), an index for another archive failing the layer, the lake editor on
  the same layer, the rack's two names, and the guard (§4.3).

### §7.4 — The pilot, then the region

**The pilot** (the founder's area, F-3 a, widened by F-9 c): Lake Champlain's north end — the VT/NY
line, Vermont 2025 at 0.3 m against New York 2024 at 0.6 m, Québec's edge, big water (~24
quarter-quads) — plus a strip straddling 72°W on the New Hampshire–Massachusetts line near Jaffrey and
Winchendon (~16: the UTM zone seam and another state line); plus a strip north of Rumford (~15: the six
October cells of §2.1's off-season step, their 2023 summer neighbors, and a few cells where ME 2023
meets the ME 2018 fallback); plus a New York join where 2024 meets the 2019 fallback (~8). **~63
cells** in all, the pilot named `champlain-nhma-me-ny`. Built end to end to dev's bucket under
`dev/naip/pilot/champlain-nhma-me-ny/…`, its run rows on a throwaway local backend (never dev), and
looked at in the verify report's viewer page, its credit drawn by core's range. What it must show: a
state line, the
72°W zone seam, a 0.3 m / 0.6 m join, a partial frame falling through, the Canadian border's edge, the
six October cells in autumn color beside their summer neighbors, the ME 2023/2018 and NY 2024/2019
year joins (the two Maine rulings the founder wanted to see before they are final, §5.5), the
credit's range across a join, and the archive loading in about a second. What it measures: seconds
per work tile, bytes per tile at each zoom (to firm §6.1), the date index's size, source bytes read,
outbound transfer, the assembler's throughput. Pennies of spend, started only on the governor's go.

**The full region run** (by the pilot's figures, §6.1: ~7–9 h on 25 `performance-4x` Machines, ~1.5
TB read, ~$37 all told, $28–48; the Machine size is part of his call) is **the
founder's go/no-go**, given the pilot's numbers — never a builder's. **It waits for his foliage review**
(§2.1.4, D319): the confirmed strikes committed to `NAIP_FOLIAGE_STRIKES` first, and the applied run's
cloud sheet read, so the build is cut once with the picks he chose rather than re-cut by a
`--from-current` rebuild afterwards (which would re-tile ~615 of the 1,764 work tiles).

### §7.5 — Definitions of done

- **B05-1:** every gate green (`pnpm check-types`, lint, the suites, `packages/guards`);
  `/code-review xhigh --fix` over the PR's range; the pilot built, verified and looked at by the
  founder; its numbers in *What the build found (B05)* below; CI green including Convex's
  codegen-verify step.
- **The full run:** verify clean (counts, spot reads, coverage limited to coast and border, every cell
  dated, the seams sheet looked at); the archive, index and manifest at their dated keys; the run rows
  read back on dev.
- **B05-2:** the same gates; the console drawing the full archive on dev in both themes on a Body
  console tab, Class conflicts' head map and the lake editor, each with its dated credit; Co7's rack
  names, Co15, Co18 and Co19 closed in B01's register; the July job's dry tick on dev reading
  unchanged; no `nationalmap.gov` request in the web app.

### §7.6 — The full run's first hours: what to watch

*Written at the PR's fifth review (2026-11-27)*: what the code can't settle short of a real region
run on Fly and R2. Each is read in the first hour of its stage (tiles from the start, the assembly
when it begins, ~5 h in), with what trips it and what to do.

- **H1 — Planetary Computer under 25 Machines for hours.** The pilot ran 28 work tiles at the same
  concurrency, so a burst was tested; the region sustains it ~5 h: up to 22,886 STAC lookups (the
  units' cell frames, ≤ 68 for one work tile) ≈ 76 a minute, and a SAS token or two a work tile.
  Watch `fly logs --app skating-imagery` for `STAC lookup failed`, `no usable SAS token` and `429`.
  Trips at any work tile dying of them: lower `MAX_PARALLEL` (15) and re-run the stage — it resumes
  by done record, and running Machines are waited for, not doubled.
- **H2 — Fly's API at a five-second poll for hours.** ~3,600 `fly machine list` calls and 1,764
  `fly machine run` in batches of six. Watch `spawn.sh`'s `FAILED to spawn` lines and its
  capacity waits. A failed list reads as the cap (it waits) and a failed spawn is re-spawned next
  round; trips at more than a few percent of spawns failing: raise `POLL_SECONDS` to 15.
- **H3 — The slowest work tile against the deadline.** Each done record's timings. Trips at any tile
  over 30 minutes (half of `AERIAL_TILE_DEADLINE`'s hour) or any worker exit 124 in `fly logs`: raise
  the deadline before the next round, after reading why it was slow.
- **H4 — The assembler's rate on `shared-cpu-4x`.** The pilot's 97-second assembly ran inside the
  Machine's CPU burst balance; the region's ~1.5 h runs past it. The row's `bytesWritten` every five
  minutes gives MB/s (the pilot: 47.5). A slower one is still followed (the beat is per five
  minutes, never per zoom); trips below ~25 MB/s (~3 h): let it finish, and size the next one on a
  `performance` Machine (G-10, §8). And `peakRssMb` at the end against the 4 GB.
- **H5 — Incomplete multipart uploads.** A Machine that dies mid-upload, or abandons one
  (`assemble.shardReplaced`, §2.8), leaves its parts (up to the archive's ~260 GB, ~$0.13 a day)
  until the bucket aborts them; rclone aborts only the failures it sees, and a re-run starts a fresh
  upload. Before the run, read the bucket's lifecycle rules in Cloudflare's dashboard (R2's default
  for a new bucket aborts after seven days — unverified for this one); after any failed assembly,
  `rclone backend list-multipart-uploads r2:<bucket>`, and abort what it left with `rclone backend
  cleanup r2:<bucket> -o max-age=1h` — **only while no assembler is up** (`scripts/aerial/spawn.sh
  status <campaign>` prints no `assembler` for any campaign that may be assembling): the cleanup
  aborts every upload older than an hour, a running assembly's included.

---

## §8 — Forks

Founder forks are marked F, governor forks G. **All eight founder forks were ruled on 2026-11-25**
(§1.2); each is kept here with its ruling for the record. The briefs (§10) build on each governor
fork's recommendation; G-6 is checked at build start.

### Founder forks

**F-1 — The maximum zoom. Ruled: (b), z18 everywhere (D317).** The question: (a) z17 everywhere plus
z18 where the source is 0.3 m, or (b) z18 everywhere. At 44°N a tile pixel is 0.86 m (2.8 ft) at z17,
0.43 m (1.4 ft) at z18. Under (a) the 0.6 m sources (all of New York and about 40% of Maine) would
stop at z17 and lose about half of what the camera recorded, and the map would need two stacked
layers; (b) shows all of it in one source for about $1.70 a month more.

**F-2 — Where the July offer appears. Ruled: neither the Overview nor the Inbox** — *"I think this
belongs in the Machinery pages eventually, where we manage the rest of the imagery runs"*, with no
interim surface: *"Don't worry about the interim, I'll have the Machinery built long before July."*
Stored data shaped for Machinery's imagery page, nothing else (§3.3). The Overview card and the
email are out of B05-2.

**F-3 — The pilot area. Ruled: (a)** — Champlain's north end plus the NH–MA strip across 72°W, ~40
cells (§7.4); widened by F-9 (c) to ~63.

**F-4 — Dev only, or dev and prod, now. Ruled: (a)** — dev only; prod points at the same dated object
at the cutover.

**F-5 — A summer photograph for skaters. Ruled: no (D316)** — *"I don't want summer for skaters at
all. This is purely to help admins place landmarks on the map properly"*; and of the clipped reveal of
one lake, *"at least not for now"*. Neither option the design offered (later via B04, or in this
phase) stands; nothing goes on B04's running list; revisited only on his word.

**F-6 — What the rack calls the two imagery rows. Ruled: (a)** — *Winter satellite* and *Summer
aerial* (Co7's rack half).

**F-7 — The six Maine cells with no summer frame. Ruled: (a)** — the 2 October 2023 frame at 0.3 m,
through the rule's off-season step, held to the committed six (§2.1). With it, a standing
requirement: the imagery's date is always shown, on every tile and region (D318).

**F-8 — Who reviews the cloud and glare candidates. Ruled: (a)** — the builder pre-screens with a
contact sheet; the founder confirms only the frames that would change a pick (§2.1.2).

### Governor forks

**G-1 — The phase token.** (a) `B05`, its own phase; (b) `A06j`, beside A06e's imagery; (c) a B01 PR
(`B01-8`). **Recommendation: (a)** — the `A` era is closed, `B02`–`B04` are taken, and the work has
its own workstreams, decisions and infrastructure, which is a phase by the README's rule.

**G-2 — Tile size.** (a) 512-px tiles, read by MapLibre at `tileSize: 512`, so the deepest level is
z17 in tile numbers while its pixels are z18's; (b) 256-px tiles. Same pixels either way. **The
recommendation: (a)** — a quarter of the tile requests (R2 Class B reads), directory entries and
WebP headers. D317 is worded in pixel terms so it doesn't depend on this.

**G-3 — Assembly.** (a) a streaming PMTiles writer from the shards and the old archive into a
multipart upload, no local copy; (b) a Fly volume and `pmtiles convert` (needs the MBTiles, a spool
and the output on disk — over a terabyte, past one volume, unverified); (c) the laptop (a 387 GB
download and upload, and the disk). **Recommendation: (a)**, proven on the pilot, written in
TypeScript (§2.4); (b) split by zoom band as the fallback if the writer fails its round trip.

**G-4 — The shard cache.** (a) The old archive is the cache: a rebuild re-tiles changed work tiles
and copies the rest from the live archive; (b) keep every build's shards in R2 (doubles storage,
~$70 a year). **Recommendation: (a).**

**G-5 — Who runs the heavy stages.** (a) The laptop orchestrates Fly Machines, as A06e's backfills
do (it must stay awake for the build, 7–9 h by the pilot's figures, §6.1; every stage resumes); (b) a "conductor" Fly Machine runs the
whole build so the laptop can close (it needs a Fly token and a Convex deploy key staged on the app —
new credential placements, a founder task); (c) Convex launches it from a console button. **The
recommendation: (a)** now; (b) or (c) is B01's hosted-runner decision.

**G-6 — Which bucket.** The archive must be publicly readable; the Fly app's staged R2 token is scoped
to `skating-imagery`, while the basemap and bathymetry are public in `skating-basemap` (the register
and the imagery README disagree on where the winter frames live). (a) `skating-imagery` under
`dev/naip/` if it already serves `VITE_IMAGERY_ARCHIVE_URL` publicly (no new credential); (b)
`skating-basemap`, with a new token scoped to it staged on the app (a founder task). **The
recommendation: (a), checked at build start** (T's first task, §10.5).

**G-7 — How many PRs.** (a) Two: the pipeline, then the app side (above); (b) one, held until the
full archive exists (one review, ~12,500–19,500 lines); (c) three, splitting the July check from the
web swap. **Recommendation: (a)** — the pipeline must merge before the full run is from main, and the
app side can't merge before the archive exists.

**G-8 — The pilot's run rows.** The run kinds are new, and a deploy of an unmerged branch's Convex to
dev can drop another branch's indexes (the shared-deployment rule). (a) The pilot writes its rows to
a throwaway local backend and dev gets rows from the full run on; (b) merge the widen alone first.
**Recommendation: (a).**

**G-9 — Splitting the archive by zoom band.** (a) One archive; (b) two or three by zoom band.
**Settled: (a)** by D317 (z18 everywhere is one source).

### New questions the rulings opened (2026-11-25)

**F-9 — Should the pilot also show the October and older-summer cells?** You chose the pilot area
(Champlain's north end plus the NH–MA strip, ~40 cells), and you also said two Maine rulings are to be
seen before they're final: the older summer frames that fill October-flown cells (*"let's see how it
looks and re-address in the future"*), and the 2 October 2023 autumn frame for the six cells north of
Rumford. Neither is in the pilot area, so as planned you'd first see them after the ~9 h region run.
Options: (a) the pilot as you ruled it, ~40 cells; you see the Maine cells after the full run and any
change is a partial rebuild of those cells; (b) add a strip north of Rumford — the six October cells
and their 2023 summer neighbors, plus a few cells where ME 2023 meets ME 2018 (~15 cells, ~55 in
all), so you see both rulings in the pilot; (c) (b) plus a New York join where 2024 meets the 2019
fallback (~8 more). The extra cells cost pennies and add a few minutes. **Recommendation: (b)** — it
puts both of the rulings you wanted to see in front of you before the expensive run, and a New York
2019 join looks like any other year join.

**Ruled: (c)** (the founder, 2026-11-25, through the governor) — the pilot is Champlain's north end,
the NH–MA strip, the Maine strip north of Rumford (the six October cells, their 2023 summer neighbors,
a few ME 2023/2018 cells) and a New York 2024/2019 join: ~63 cells (§7.4, §10.7).

### What the pilot opened (2026-11-27)

**F-10 — Autumn frames inside the calendar.** The pilot showed September flights already in color
(§2.1.4). **Ruled (the founder, 2026-11-27, D319):** the measured screen with his review of flight days
at 0.6; the cells with no green frame at 0.6 m or better keep their newest sharpest frame by rule; the
six October cells keep 2 October 2023. **Open: his review of the first proposal** (524 entries,
`scripts/aerial/review/naip-20261127-foliage-proposed.json`, on the sheet by flight day), before the
full run.

**G-10 — The assembler's Machine size, for a run past its CPU burst** (opened at the PR's fifth
review, 2026-11-27). The governor kept the assembler on `shared-cpu-4x` from the pilot's 97 seconds,
which ran inside the burst balance a shared Machine starts with; the region's ~1.5 h assembly runs
well past it (the work tiles' balance drained in ~3 minutes under load, then ~0.44 of a core). The
assembler hashes and streams rather than decodes, so how far it slows is unmeasured. (a) Keep
`shared-cpu-4x`: no failure either way now (it is followed by a five-minute beat, not by zoom), at
worst a slower assembly, watched by H4 (§7.6). (b) `FLY_ASSEMBLE_VM_SIZE=performance-2x` with its
4096 MB: never throttled, a few cents more for the run. **Recommended: (b)** for the full run — the
assembly is the one stage that can't overlap anything, and a throttled one is hours of a 260 GB
upload. Open.

---

## §9 — Not verified

Relied on from the scouts or from memory, not re-checked for this doc — **as of B05-1's integration
(2026-11-26), with what the build answered marked**:

- The **sizes**: ~387 GB ±30%, ~220 machine-hours, ~9 h on 25 Machines — **revised** by T's
  measurements and the integration's arithmetic (§6.1: ~550 GB, ~400 machine-hours, ~16 h; the
  6.59 M tiles checked against the quarter-quads' area). Still unmeasured: 9–10 TB of source reads
  (and the claim that reading fallbacks only where needed cuts that: the proof's windows read
  135–321 MB a z14 window, which at 64 a work tile is 9–20 GB a tile from the laptop — T estimates
  2–9 GB a tile, as a Machine reads only what shows); seconds per work tile on a Machine, and whether
  shared CPUs throttle under a sustained tile (§6.1). **Measured by the pilot (2026-11-26):** 0.86 GB read a work tile (0.35–2.5),
  ~1.5 TB for the region; 256 s a work tile on `performance-4x`; and **shared CPUs throttle** — a
  `shared-cpu-4x` drained its burst in ~3 minutes and ran at ~0.44 of a core after (§6.1). **Measured:** the date index of the real region
  (P's index proof over the scouts' picks, 2026-11-26): 9,168 cells, 141 flights, 168 KB raw,
  **26 KB gzipped**, 18 bytes a cell; the assembler's memory for a region-sized layout (P's scale
  proof, 8.7 M tiles): **1.39 GB peak RSS**, inside the assembler's 4,096 MB.
- **Planetary Computer**: blobs in West Europe and lossless 4-band COGs (as read by T's proof).
  **Answered:** NAIP's COGs **declare no nodata value and carry no mask; an unflown pixel is RGB
  0,0,0** (T, measured 2026-11-25), so the warps read alpha from `-srcnodata "0 0 0"` with
  `UNIFIED_SRC_NODATA=YES` — a pixel is nodata only when all three bands are 0, and dark water stays
  opaque (the Champlain window, on the lake, had no transparent pixel inside its cells); **anonymous SAS tokens live 15
  minutes** and the endpoint serves the current one however little is left (§2.2). Unverified: the
  STAC's paging behavior from Convex (B05-2).
- **Ground facts**: ME 2023's 565 unflown North Woods cells, NAIP ending 0–7 km past the border, the
  ~300 m quarter-quad overlap, the 134 partial Maine picks (S's thumbnails found 140 partial picks
  region-wide). **Answered:** the cloud and glare cases (§2.1.2, the founder's review).
- **Infrastructure**: R2's 5 GiB single-PUT cap and 10,000-part multipart limit; Cloudflare not
  caching an object this size at the edge; R2's free 10 M Class B reads and $0.36/M; **R2's public
  URL serving a `Content-Encoding: gzip` object as such** — answered by the pilot (2026-11-26): it
  does, and decodes it for a client that doesn't accept gzip; Fly's outbound
  transfer rate; the Fly Machine's ephemeral disk size (a work tile's scratch is its shard plus
  small intermediates, a few hundred MB); `ams` being the right region for West Europe; **the
  bucket's location** — answered by the pilot: `ENAM` (S3 `GetBucketLocation`), so the assembler
  stays in `iad`; pushing a second image to `skating-imagery` under its own label without touching
  the pinned cutter image — answered: `aerial-20261126`, by Fly's remote builder, the app's Machines,
  config and secrets untouched; the Machine's root disk — answered: 8.35 GB, a work tile's scratch
  under 0.5 GB of it.
- **Tools.** **Answered:** `gdal raster tile --tile-size 512` (T's proof); `pmtiles verify` clean on a
  streamed archive and `rclone rcat` in 128 MiB parts (P's stream proof, re-run at integration: a
  1.8 GB archive in 15 parts through real `rclone` into a local S3 server, byte-equal, verify clean,
  92 MB/s, 832 MB peak RSS). **Answered by the pilot (2026-11-26):** against R2 itself, a 4.08 GB archive
  in 31 parts, byte-equal from the public URL, at 47.5 MB/s on a Machine in `iad` (~1.5 h for ~260 GB) —
  once the image's rclone was 1.74.4, not Ubuntu's 1.60.1, which can't `rcat` to R2.
- **Which bucket** serves `VITE_IMAGERY_ARCHIVE_URL` publicly (G-6). **Answered** (T, 2026-11-25, by
  hosts and names only): `skating-imagery`, from its own public host at the bucket's root; the
  register had it as `skating-basemap` and is corrected (`05` § 1).
- **The scouts' snapshot** was copied to the gitignored `scripts/aerial/.scratch/scouts/` (§10.3);
  S's first full walk is kept beside its campaign (`.scratch/naip-20261125/inventory/`, in S's copy).

Checked for the design: the inventory's composition by state, year, gsd and month; the mislabeled
Maine items (744, at 42.x°N, a `me_` prefix); the rule's picks re-run (identical to the scouts'); the
six October-only cells; the cloud scores' distribution; the 1,769 / 488 / 135 work tiles at
z11 / z10 / z9; that MapLibre 6.19 draws a missing `pmtiles` raster tile transparent rather than
falling back to its parent; that Convex already launches Fly Machines; that the skater web no longer
calls `useImageryReveal`. Checked for the rulings (2026-11-25, at `11290f1f9`): that no Machinery
mode, route or page exists (§3.4); that `InboxMap.tsx`, `CorpusHeadMap.tsx`, `BodyMap.tsx` and
`LakeEditorMap.tsx` draw or credit the aerial; that the rack's winter row reads *Aerial* in
`BodyMapPane.tsx`; that `importRuns` has `by_kind_started` and a Convex action can open its own run
(`standing.ts`); that `/admin/imports` takes `?run=`; that CI runs no Python; that D84 and D146 are
the decisions the skater ruling amends; and that no skater path on the web or the phone can show a
summer aerial today (§4.3).

---

## §10 — The builds: briefs

Written 2026-11-25 against `summer-aerial-tiles` rebased on main at `11290f1f9`. The governor's
harness is B01's (`plans/phases/B01-admin-console.md` §12, as *Briefs (B01-7a)* adapts it): builders
are subthreads, each in its own copy of the governor's worktree, committing there; their work comes
back by a file merge; disjoint territories keep the merges clean; builders never push or deploy.

### §10.1 — How these briefs work

- **A brief is pasted as two blocks**: *Every brief begins with this* (§10.2, its placeholders
  filled) and the builder's own section.
- **X lands first, alone** (§10.3). S, T and P start when the governor says X is merged, and pull it
  with `merge_worktrees`.
- **The phase branch** is `summer-aerial-tiles` (or the governor's cut of it), rebased on main.
  B05 shares no files with B01-7b's territory except `plans/` and the run-kind lists in
  `lib/enums.ts` and `scripts/run-log/src/types.ts`; X's hunk there is three lines, merged after
  whatever 7b has landed.
- **Decision numbers.** B05 holds D314–D318. B01-7b mints from D319 up.
- **Disk.** The machine had about 24 GB free on 2026-11-25; each builder's `pnpm install` is about
  2 GB, and the pilot's local proof windows are small. Four copies fit; the governor checks before
  starting a fifth.
- **The scouts' snapshot.** The catalog inventory, thumbnails and picks are in another session's
  scratchpad (`…/03acff8b-d7f9-4a22-a2da-2ee61a619aa9/scratchpad/naip2/`, about 380 MB, the
  inventory 12 MB in `inv/`). X copies `inv/` and `picks_T2.json` into the package's gitignored
  `scripts/aerial/.scratch/scouts/` before anything else, so S's fixture doesn't depend on a
  directory a reboot can clear. Never copy `tok.json` (a SAS token). *Done 2026-11-25:* `inv/`
  (seven `<st>.jsonl`, 69,207 rows, and their walk logs), `picks_T2.json` and `cloudall.json` (the
  scouts' per-pick thumbnail scores, 0.4 MB), 13 MB in all; the 380 MB of thumbnails stayed behind.

### §10.2 — Every brief begins with this

You are a builder for Phase B05 (the summer aerial as our own region-wide NAIP archive), in the
`skating-app` monorepo. Read `CLAUDE.md`, then `plans/phases/B05-summer-aerial.md` in full — §2 (the
pipeline), §2.7 (the date index), §7 (the build model) and §10 (these briefs) are yours; D314–D318 in
`plans/01-decisions.md` are the rules. The existing winter-imagery pipeline is the pattern, read and
never edited: `scripts/imagery/` (`cut-granule.sh`, `fan-out.sh`, `backfill.sh`, `status.sh`,
`tiles-to-mbtiles.py`, `Dockerfile`, `fly.toml`, `README.md`, `src/selectGranules.ts`), core's
`granuleSelection.ts` and `stacSearch.ts`, `scripts/run-log/` (`RunLogger`), and
`packages/convex/convex/importRuns.ts`.

You work in your own copy of the governor's worktree, on the phase branch, and commit there. Your
changes come back to the governor by a file merge. Start with `pnpm install --frozen-lockfile`, once.

The invariants:

```
- Never display an env file or a variable's value — not `cat`, `echo`, `env`, `printenv`, nor a
  `grep -v` that keeps values; a transcript is forever, and one such dump rotated five secrets. To
  learn which variables exist: `grep -o '^[A-Z_][A-Z0-9_]*=' <file>`. To load them:
  `set -a; source <file> >/dev/null 2>&1; set +a`.
- Never bare `git stash` / `git stash pop`: the stash stack is shared by every worktree and session,
  and a pop can land someone else's work. Set work aside with a WIP commit. Commit with explicit
  paths, never `git add -A` or `git add .`. Trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm`, never `npx` (the root devEngines blocks npm, and the error doesn't say so). Run
  `pnpm install --frozen-lockfile` once in your own copy; never another install, never `pnpm add`.
  A dependency you need is a seam request.
- D3: no copy, score, decay curve or classification may say or imply that ice is safe, skateable,
  or "good to go", or predict it. The summer aerial is a photograph flown in summer; nothing calls it
  current or live.
- D316: the summer aerial is console staff's only. Nothing you write reaches a skater surface
  (`apps/web/src/components/skater/`, `apps/mobile/`).
- D40: tests land with the feature — Vitest for logic, `fast-check` for the selection rule and every
  piece of date or grid math, `convex-test` for functions; the goal is 100% coverage, relaxed only
  where a line genuinely isn't worth a test, and you say which. US spellings in all new text. No
  decision numbers or section marks in any UI text or email. The repo is public: no real person's
  name or address in a fixture.
- Territory: you own <paths>. Edit nothing else. A change you need outside it is a seam request in
  your report, never an edit. `scripts/imagery/**` is the live winter cutter's: read it, never edit.
- Targeted tests only: `pnpm --filter <package> exec vitest run <files>`, plus
  `pnpm --filter <package> check-types` and `pnpm exec biome check <files you touched>`. The full
  suite is the governor's.
- Run every gate in the foreground and wait for it inside the turn. Never start a gate, a build, a
  spawn or a watch in the background and end the turn: a turn that ends with work running reports
  nothing.
- No pushes, no deploys, no `convex dev` against dev, no `convex deploy` ever. No cloud spend (no
  `fly machine run`, no image push, no R2 write) except a step this brief marks as gated, and then
  only after the governor's explicit go for that step.
- Before you report: mutation-check the invariants your tests guard (B01 §12.5) and name the
  mutations; say which lines you left untested and why.
- Report as your final message, compactly: what landed (one line per commit); the gates you ran and
  their counts; the mutations run; seam requests; anything you could not verify; branch + HEAD.
```

### §10.3 — X: the seams (T0, lands first)

**Owns:**
- **The package skeleton** `scripts/aerial/`: `package.json` (`@skating/aerial`, private, ESM;
  dependencies `@skating/core`, `@skating/run-log`, `pmtiles` at the web's range `^4.5.0`;
  devDependencies as `scripts/imagery/package.json`'s plus `fast-check` `^4.10.2`; scripts
  `check-types`, `test` with coverage, and one per stage CLI), `tsconfig.json`, `vitest.config.ts`
  (imagery's shape and thresholds, the CLI shells excluded by name), a package `.gitignore`
  (`.scratch/`); the lockfile, from X's one `pnpm install` (X is the only builder who installs a
  dependency). Copy the scouts' snapshot into `.scratch/scouts/` (§10.1).
- **Core's typed stubs**, each exporting its final signature with a body that throws `PLACEHOLDER`,
  exported from `packages/core/src/index.ts` now so no later builder edits it:
  - `naipSelection.ts`: `NaipCandidate` (item id, quarter-quad key, labeled state, acquisition date,
    gsd, `naip:year`, bbox), `NaipExclusion` (item id, `cloud` | `glare`, `reviewedBy: 'founder' |
    'builder'`, `reviewedOn`), `NaipCellPick` (key, pick, `step: 'leafOn' | 'offSeason'`, stack,
    states), `NAIP_RULE_VERSION`, `selectNaipPicks(candidates, exclusions, offSeasonCells)` →
    `NaipSelection`, `diffNaipPicks(current: NaipManifest, next)` → `NaipPickDiff`.
  - `naipGrid.ts`: `quarterQuadCell(key)`, `quarterQuadAt(lat, lng)`, `quarterQuadsIn(bounds)`,
    `workTilesOf(key)`, `NAIP_WORK_ZOOM = 11`, `NAIP_MIN_ZOOM = 8`, `NAIP_MAX_ZOOM = 18` (D317,
    pixel zooms), `NAIP_TILE_SIZE = 512`, `naipTileZoom`, `WorkTile`, `workTileKey`,
    `parseWorkTileKey`.
  - `naipManifest.ts`: `NaipManifest` (§2.1.3), `NaipCellIndex` and `NAIP_CELL_INDEX_VERSION = 1`
    (§2.7, the format verbatim), `parseNaipCellIndex(json, archiveName)`, `naipIndexUrl(archiveUrl)`,
    `naipCreditRange(index, keys)` → `{ from: string; to: string } | null` (`YYYY-MM-DD` days),
    `formatNaipCreditRange(range)`, `AERIAL_STAGES`, `AerialRunOptions`,
    `aerialRebuildCommand(campaign, options: AerialRunOptions)`.
  - `naipExclusions.ts`: `NAIP_EXCLUSIONS: readonly NaipExclusion[] = []` and
    `NAIP_OFF_SEASON_CELLS` — the six keys of §2.1, final (the founder's ruling).
- **The run kinds' widen** (three lines each): `aerial_select`, `aerial_tiles`, `aerial_assemble` in
  `IMPORT_RUN_KINDS` (`packages/convex/convex/lib/enums.ts`, with a comment naming
  `scripts/aerial`) and in `ImportRunKind` (`scripts/run-log/src/types.ts`), and their rows in
  `scripts/run-log/README.md`'s table. `pnpm --filter @skating/convex codegen` to confirm
  `convex/_generated` doesn't change (commit it if it does).
- **The shared contracts** in `scripts/aerial/src/`: `keys.ts` (the R2 key layout of §2.4 and the
  build prefix of §2.2 — `archiveKey`, `indexKey`, `manifestKey`, `buildPrefix`, `shardKeys`, each
  taking an optional pilot name), `stages.ts` (the stage names, the flags of §3.1 and one
  `parseStageArgs`, the contract `run-aerial.sh` and every stage CLI share), and `shard.ts` (the
  pack's index entry, the done record with its input hash, image digest, timings and per-cell counts
  `Record<cellKey, Record<itemId, number>>`). Implemented and tested, not stubs: they are small, and
  three builders read them.

**Tests owed:** `keys.ts`, `stages.ts` and `shard.ts` at 100%; `importRunVocabulary.test.ts`
(`packages/guards`) green with the three kinds.

**Gates, in the foreground:** `pnpm --filter @skating/aerial check-types`,
`pnpm --filter @skating/aerial exec vitest run`, `pnpm --filter @skating/core check-types`,
`pnpm --filter @skating/guards exec vitest run`, `pnpm --filter @skating/convex check-types`, Biome
on every file touched.

**Mutation checks:** drop one kind from `ImportRunKind` (the vocabulary guard must fail); make
`archiveKey` ignore the pilot name (a `keys.ts` test must fail).

**Credentials:** none.

**As built (X, 2026-11-25).** The files are the contract; this is the map, and where it differs
from the snippets above, the files win. Core (all exported through `index.ts` already; S adds any
further export in its own files with no `index.ts` edit, since every line there is `export *`):

- `naipSelection.ts` — **built:** `NAIP_RULE_VERSION = 1`, `NAIP_STATES` (the seven) and
  `NaipState`, `isNaipState`. **Types:** `NaipCandidate { itemId, key, state: NaipState, acquired:
  'YYYY-MM-DD', gsd, year, bbox: [w, s, e, n] }`; `NaipExclusion { itemId, reason:
  NaipExclusionReason, reviewedBy, reviewedOn }`; `NaipPickStep`; `NaipCellPick { key, pick, step,
  stack (the fallbacks, pick excluded, next choice first), states }`. **Stubs:**
  `selectNaipPicks(candidates, exclusions, offSeasonCells): NaipSelection` — *returns* `{ picks,
  dropped: { coarse, outsideState, excluded }, offSeasonBeyondList }` rather than refusing, so the
  select stage refuses on a non-empty `offSeasonBeyondList` and the July check reports it;
  `diffNaipPicks(current: NaipManifest, next: readonly NaipCellPick[]): NaipPickDiff` (`cells:
  NaipCellChange[]` with `from`/`to` `NaipFrameRef | null` and `stackOnly`; `states:
  NaipStateChange[]` with `cells`, `newest`, `oldestReplaced`).
- `naipGrid.ts` — **built:** `NAIP_WORK_ZOOM = 11`, `NAIP_MIN_ZOOM = 8`, `NAIP_MAX_ZOOM = 18` (pixel
  zooms, §2.2 step 3), `NAIP_TILE_SIZE = 512` (G-2), `naipTileZoom(pixelZoom)` (pixel zoom → the
  archive's 512-px tile number), `WorkTile { z, x, y }`, `workTileKey(tile)` → `11/<x>/<y>`,
  `parseWorkTileKey(key)`. **Stubs:** `quarterQuadCell(key): BBox` (core's `BBox`, `minLat`…),
  `quarterQuadAt(lat, lng): string`, `quarterQuadsIn(bounds: BBox): string[]`,
  `workTilesOf(key): WorkTile[]`.
- `naipManifest.ts` — **built:** `NAIP_ARCHIVE_SUFFIX`, `NAIP_INDEX_SUFFIX`, `NAIP_MANIFEST_SUFFIX`
  (`keys.ts` and `naipIndexUrl` share them), `NAIP_MANIFEST_VERSION = 1`, `NAIP_CELL_INDEX_VERSION =
  1`, `AERIAL_STAGES` and `AerialStage`, `AerialRunOptions` (the flags of §3.1 as optional fields).
  **Types:** `NaipManifest` (§2.1.3 as amended: `frames` by item id, `basedOn`, per work tile
  `retile`, `archive?`/`cellIndex?` as `NaipPublishedObject { name, bytes, sha256 }`),
  `NaipManifestCell`, `NaipManifestWorkTile`, `NaipManifestFrame`, `NaipCellIndex` and
  `NaipCellIndexFlight` (§2.7 verbatim). **Stubs:** `parseNaipCellIndex(json, archiveName)` (throws
  on a refusal), `naipIndexUrl(archiveUrl)`, `naipCreditRange(index, keys: Iterable<string>):
  NaipCreditRange | null` with `from`/`to` as `YYYY-MM-DD` days, **`formatNaipCreditRange(range)`**
  (new: `Jun 2023` / `Jun 2021 – Aug 2023`, so W never formats a date itself), and
  `aerialRebuildCommand(campaign, options: AerialRunOptions)`.
- `naipExclusions.ts` — final: `NAIP_EXCLUSIONS = []`, `NAIP_OFF_SEASON_CELLS` (the six, checked
  against the scouts' inventory: each has a `…_030_20231002_…` frame).

`scripts/aerial/src/` (built, 100% covered):

- `keys.ts` — `parseCampaign(id)` (`naip-<YYYYMMDD>` / `naip-pilot-<YYYYMMDD>`, a real day),
  `isPilotName`, `archiveName` / `indexName` / `manifestName(campaign)`, `publishPrefix`,
  `archiveKey`, `indexKey`, `manifestKey`, `buildPrefix` (a pilot's is
  `naip/build/pilot/<name>/<campaign>/`), `buildManifestKey` (the select stage's manifest before
  publish), `shardKeys(campaign, tile: WorkTile, pilot?)` → `{ pack, index, done }`
  (`….pack`, `….idx.json`, `….done.json`), `parseArchiveKey(key)` (cleanup's `--old`),
  `inventoryKey(walkedOn, state)`, `AERIAL_SCRATCH` and `scratchPaths(campaign, root?)` →
  `{ dir, manifest, inventory, report, log }`. Every key function takes `(campaign, pilot?)` and
  **throws on a pilot campaign without its name or a name on a production campaign**.
- `stages.ts` — `parseStageArgs(argv, forStage?)` → `StageArgs` (every field present: `null` /
  `false` when absent), throwing `StageArgsError`; a stage CLI passes its own stage as `forStage`.
  `AERIAL_USAGE`, `ALL_STAGES`, `stagesToRun(stage)`, `stageArgsToOptions(args)` (→ core's
  `AerialRunOptions`, for `aerialRebuildCommand`), `parseCellList(text)` (the `--cells` file).
- `shard.ts` — `SHARD_TILE_ZOOMS` (`{ min: 11, max: 17 }`, tile zooms), `ShardIndexEntry { tileId,
  offset, length, sha256 }` (the brief's three plus the offset), `ShardIndex { version, workTile,
  entries }`, `ShardCellCounts`, `ShardDone { version, campaign, workTile, inputHash, image (pinned
  `…@sha256:…`), tiles, bytes, packSha256, timings: Record<step, ms>, cellCounts, finishedAt }`,
  `checkShardIndex(json, packBytes?)`, `parseShardDone(json)`, `tileInWorkTile(tileId, tile)`,
  `shardLanded(done | null, { campaign, workTile, inputHash })`.
- The stage CLIs are `src/cli/<stage>.ts` (`select`, `tiles`, `assemble`, `verify`, `cleanup`), each
  a `pnpm --filter @skating/aerial <stage>` script and excluded from coverage by name, as is P's one
  process boundary, `src/assemble/upload.ts` (the `rclone rcat` stream).

### §10.4 — S: selection

**Owns:** `packages/core/src/naipSelection.ts`, `naipGrid.ts`, `naipManifest.ts` (replacing X's
stubs), `naipExclusions.ts` (the entries, once reviewed), `naipCatalog.ts` (new: the Planetary
Computer STAC walk by POST paging and the anonymous SAS token, `fetch` injected — beside
`stacSearch.ts`, which the live winter poll shares and S does not edit), their tests, and the fixture
`packages/core/src/fixtures/naipInventory.jsonl`; in `scripts/aerial/src/`: `cli/select.ts` (the
stage CLI, `parseStageArgs(argv, 'select')`), `catalog*.ts` (the CLI side of the walk and the inventory archive), `score*.ts` (thumbnail
scoring and the contact sheet), their tests.

**Builds:** the rule of §2.1 exactly — the five steps, the envelope drop (§2.1.1), the exclusions
before the season step, the off-season step and its refusal outside `NAIP_OFF_SEASON_CELLS`, the
fallback stacks; the grid; the input hash per work tile (a stable hash of the stack ids, the rule's
version and the image's inputs); `diffNaipPicks`; the date-index helpers (`parseNaipCellIndex`,
which refuses another archive's index or an entry with no flight; `naipIndexUrl`;
`naipCreditRange`); `aerialRebuildCommand`. The select stage: the walk over the seven states, the
inventory archived to `scripts/aerial/.scratch/<campaign>/inventory/` (the private bucket's copy is the full
run's, by the governor's executor), the scores, the manifest, the run row (`aerial_select`, scope per
§2.6, heartbeat per state) through `RunLogger`, its counts and the whole-catalog invariants of
§2.1.3. The scoring step decodes thumbnails with GDAL (`gdal raster info --stats`, or a small helper
over the GDAL 3.13.2 already on the Mac) rather than a new npm image library; if that is impossible,
a seam request.

**The cloud pre-screen** (F-8 a): run the scores over the real catalog, sort the high ones into
false positives (set aside, listed), likely cloud or glare on a pick (a contact sheet showing each
beside the frame that would replace it, for the founder), and likely cloud on a fallback only
(decided by S, listed). The founder's contact sheet goes in the report as a path; S commits only
the entries the governor relays as confirmed, plus its own fallback-only ones marked `builder`.

**The fixture:** ~2,000–3,000 rows cut from the scouts' inventory (`scripts/aerial/.scratch/scouts/`;
a fresh walk if it is gone), holding every edge class of §7.3, as compact candidates (~400 KB).

**Tests owed:** the properties of §7.3 for the rule (`fast-check`), the grid, `quarterQuadsIn` and
the credit range; the fixture's known answers (the six off-season picks are the 2 October 2023
frames; the Long Island and Aroostook strikes fall back as §2.1.2 says; the 744 mislabeled items are
dropped; the 319 two-state cells compete); `parseNaipCellIndex`'s refusals; the walk's paging, short
answers and expired-token retry against a fake `fetch`. Core's thresholds stand; the goal is 100% of
`naip*.ts`.

**Gates, in the foreground:** `pnpm --filter @skating/core exec vitest run src/naip`,
`pnpm --filter @skating/aerial exec vitest run src/select src/catalog src/score`, both packages'
`check-types`, Biome on touched files. Then the select stage for real, as a dry run
(`--dry-run`: the manifest under `.scratch/`, no run row), on the laptop; report its counts against
§2.1's table.

**Mutation checks:** the two-year window `<=` → `<`; the 20 May clause dropped; the exclusions
applied after the season step; the off-season refusal removed; the stack's order reversed;
`quarterQuadsIn` off by one cell at an edge; `naipCreditRange` returning the first key's flight
only. Each must fail a named test.

**Credentials:** none. The STAC and the SAS token endpoint are anonymous; a SAS token is a short-lived
credential, so it is never printed, logged or committed.

### §10.5 — T: tiles, the worker and the entry point

**Owns:** `scripts/aerial/cut-aerial.sh` (the worker), `scripts/aerial/run-aerial.sh` (the entry
point, §3.1), `scripts/aerial/spawn.sh` (spawn, drain, reconcile, retry: `fan-out.sh` and
`backfill.sh`'s shapes, their caps and warnings carried over), `scripts/aerial/Dockerfile` (§2.2:
the same pinned GDAL base, rclone, `pmtiles`, Node 26 for P's assembler; entrypoints `cut-aerial`
and `assemble-aerial`), `scripts/aerial/fly.toml` only if `fly deploy --build-only` needs its own,
`scripts/aerial/README.md` (the runbook: the six ways to get Fly wrong, carried from the imagery
README; the stages; the pilot; publish and cleanup), `scripts/aerial/src/tiles*.ts` (the work units
from the manifest, the input hashes compared, the reconcile by done record — `shard.ts`'
`shardLanded`, never presence), `scripts/aerial/src/cli/tiles.ts` (the stage CLI),
`scripts/aerial/proofs/` (the warp proof), their tests.

**First task — G-6, before anything that writes:** find which bucket serves
`VITE_IMAGERY_ARCHIVE_URL` publicly and whether the Fly app's staged R2 token can write there, **by
names and hosts only**: compare the URL's host against the buckets' public hosts in a script that
prints only `matches skating-imagery: yes/no`, never the URL itself; `fly secrets list --app
skating-imagery` prints names and digests, never values. Report the answer; the governor decides (a
new token is a founder task).

**Builds:** the warp stack of §2.2 exactly (warped VRTs cut to each cell's own outline on z18's grid,
RGB only, alpha from nodata, the mosaic ordered pick last, fallbacks only where needed), `gdal raster
tile` at z11–z18 WebP q80 `--skip-blank` at the tile size G-2 rules (512), **the per-cell counts**
(§2.2 step 4: on the z16 grid, each frame's pixels in stack order, any pixel counts), the shard per
`shard.ts`, the done record; SAS refresh per work tile; `run-aerial.sh`'s stages, logging and
refusals (piped, no campaign, a `--pilot` against a non-local Convex target); the run row
`aerial_tiles` with a heartbeat every 25 work tiles. The local warp proof (§7.3) as a script over
real COG windows with GDAL on the Mac.

**Tests owed:** `tiles*.ts` at 100%: the work units from a manifest; a changed stack changes exactly
its work tiles' input hashes (a property); reconcile counts a done record with a stale hash as
outstanding and never counts presence (a property); the three retry rounds and the failed list.
`run-aerial.sh`'s argument refusals through `stages.ts`' tests (X's) plus a shell smoke run with
`--dry-run`. The warp proof's assertions, run locally, results in the report.

**Gates, in the foreground:** `pnpm --filter @skating/aerial exec vitest run src/tiles`,
`check-types`, Biome; `shellcheck` on the shell scripts if it is installed (say if not); the warp
proof; `docker build` of the image **locally only** (no push).

**Mutation checks:** reconcile by presence (a property must fail); the cutline dropped from one
warped VRT (the proof's "no pixel painted by a neighbor" must fail); the stack's order reversed (the
proof's "partial frame falls through" must fail); the counts taken before the stack's order (the
proof's "counts name exactly the frames that show" must fail).

**Gated step (the governor's go, cloud spend):** pushing the image to the Fly registry under its own
label (`fly deploy --build-only --push --app skating-imagery --dockerfile scripts/aerial/Dockerfile`
with an image label; never plain `fly deploy`; never re-pin `FLY_IMAGE`) and the pilot's spawns
(§10.7).

**Credentials:** `flyctl`'s own login on this machine (or the app's scoped `FLY_API_TOKEN`, if the
governor says to export it); the R2 credentials are the Fly app's staged secrets, read by the
Machine, never on the laptop. The env-file rule in §10.2 applies verbatim: never display a variable's
value, a token, or a SAS URL.

### §10.6 — P: pack — assemble, the date index, verify, cleanup

**Owns:** `scripts/aerial/src/assemble/` (the streaming PMTiles v3 writer: header, varint
directories, leaf splitting, clustered layout, dedupe by hash, copy-from-old by range reads, the
`rclone rcat` stream with 128 MiB parts, SHA-256 as it passes; and the date-index writer, §2.7),
`scripts/aerial/src/verify*.ts` (§2.5, every check), `scripts/aerial/src/cleanup*.ts` (§2.5's
refusals), `scripts/aerial/src/viewer/` (the report's viewer page: MapLibre over the public URL,
the credit from core's `naipCreditRange`), the stage CLIs `scripts/aerial/src/cli/{assemble,verify,
cleanup}.ts`, their tests. The `rclone rcat` boundary lives in `src/assemble/upload.ts`, the one
file X's `vitest.config.ts` already excludes for it. How the assembler ships in T's image (a
bundled `.mjs`, or `tsx`) is P's call, agreed with T by a seam request; the entrypoint script itself
is T's. *As built:* a bundled `.mjs`, written on the laptop by `bundle.sh` with the package's
`esbuild` devDependency (§2.2, *The image's TypeScript*), not in the image.

**Builds:** §2.3 and §2.4's assembler, §2.7's index from the manifest and the done records (and, for
unchanged work tiles, the current build's counts), §2.5's verify, cleanup and the viewer; the run row
`aerial_assemble`, heartbeat per zoom and per verify check.

**Tests owed:** the round trip of §7.3 (synthetic shards plus a synthetic old archive → the writer →
every tile read back by the `pmtiles` JS reader byte-equal; clustered order; a deduplicated tile
addressed twice; an unchanged work tile copied from the old archive by a faked range reader, with its
counts); the index (every tiled cell has an entry, a property; the pick's flight first; flights
distinct; it names its archive); every verify refusal by its own test (a missing work tile, a zoom
gap, a byte mismatch, an undated cell, an index naming another archive, a hash not the manifest's);
cleanup's two refusals (the newest key, anything live under a week). The goal is 100%; the `rclone`
and network boundary is the one excluded seam, named in the config.

**Gates, in the foreground:** `pnpm --filter @skating/aerial exec vitest run src/assemble src/verify
src/cleanup`, `check-types`, Biome; `pmtiles verify` (Homebrew's, on the Mac) on a locally assembled
synthetic archive.

**Mutation checks:** a varint off by one (the round trip must fail); the clustered flag cleared; the
index skipping a cell with tiles (verify must refuse); cleanup accepting the newest key.

**Gated step (the governor's go):** the pilot's assembly on Fly and its upload under
`dev/naip/pilot/<name>/` (§10.7).

**Credentials:** the R2 credentials are the Fly app's staged secrets, read on the Machine; cleanup on
the laptop uses the gitignored rclone remote the bathymetry scripts use (`scripts/lib/mirror-r2.sh`'s
pattern), named, never printed. Verify reads only the public URL. The env-file rule in §10.2 applies
verbatim.

### §10.7 — The pilot (gated, after integration)

Run by one executor the governor names, from the integrated phase branch, only after the governor's
go:

1. **A throwaway local backend** with the branch's Convex (the widen), per CLAUDE.md — never dev,
   never prod; `run-aerial.sh --pilot` refuses any other target.
2. **The image** pushed under its own label (T's gated step); its digest pinned for the run.
3. **The pilot**: `run-aerial.sh naip-pilot-<YYYYMMDD> --pilot champlain-nhma-me-ny --cells
   scripts/aerial/pilots/champlain-nhma-me-ny.txt --stage all` → select, tiles, assemble, verify,
   under `dev/naip/pilot/champlain-nhma-me-ny/`. *The list* (proposed at integration, 2026-11-26, for
   the governor to confirm): 64 cells — Champlain's north end 24, the NH–MA strip 16, the Maine strip
   16 (the six October cells, their September 2023 neighbors, one ME 2018 cell), a Catskills NY
   2024/2019 join 8 — which touch **27 work tiles, 200 cells cut in all** (the dry runs of select and
   tiles over the first walk say so). *Built (2026-11-26) with one more: a partial Maine cell, `4507038sw` —
   65 cells, 28 work tiles, 209 cut (What the build found, the pilot).* At §6.1's figures: ~6 machine-hours (~$0.15), 6–12 GB of shards,
   an archive of ~8–15 GB, ~20 GB out of Fly (~$0.40), well under an hour on 25 Machines.
4. **The look**: the verify report and its viewer page to the founder through the governor (the
   joins of §7.4, the credit's range across them).
5. **The numbers** (§7.4's list) into *What the build found (B05)*.

Then `/code-review xhigh --fix` over `main...<branch>`, the gates again, B05-1 opens. **The full
region run is the founder's go/no-go** on the pilot's numbers, run from main after the merge and the
widen's deploy and **after his foliage review is committed** (§2.1.4: the run's select stage refuses an
unconfirmed strike, and reads only the confirmed ones), by the executor the governor names — never by
a builder.

### §10.8 — B05-2, in brief (after the pilot)

The same invariants (§10.2). Written in full when the pilot is in; the shape now:

- **Y — the seams** (lands first): `schema.ts`' `aerialOffers` (§3.3, index `by_status_opened`);
  `aerial_reassess` in `IMPORT_RUN_KINDS` and `ImportRunKind`, `survey` in `IMPORT_RUN_SCOPES` and
  `ImportRunScopePass` (and the run-log README); `summerAerial` in `FAILING_JOBS`; typed stubs of
  `convex/aerialReassess.ts`; codegen; `plans/06-data-model.md`'s row for the table (the
  data-model guard requires it).
- **K — the July check**: `convex/aerialReassess.ts` and `lib/aerialReassess*.ts` (the tick and its
  July gate, the action, the offer's open, supersede and close — stored only, no email or
  notification), `crons.ts`' entry, `recurringJobs.ts`' `CRON_OF` row, their
  `convex-test` cases (§7.3). Credentials: `NAIP_MANIFEST_URL` is set on dev by the founder; K's
  tests fake it, and K never reads or prints it.
- **W — the web**: `apps/web/src/components/admin/body/map/` (`consoleAerial.ts`, `AerialCredit.tsx`,
  `BodyMapPane.tsx`' rack names, `useBodyMapCanvas.tsx`, `BodyMap.tsx`, their stories and tests),
  `admin/inbox/map/InboxMap.tsx`, `admin/corpus/map/CorpusHeadMap.tsx`, `admin/LakeEditorMap.tsx`, the
  deletions of §4.3 (web and core's `aerialImagery.ts` and `imageryTiles.ts`), the survivors' new
  module and its importers (`useFreezeUpFrame.ts`, `useFreezeUpSeam.ts`, `skater/map/mapLayers.ts` —
  imports only), `src/test/domTests.json`, `apps/web/.env.example`, the web README's table, and the
  guard `packages/guards/src/summerAerialSurfaces.test.ts` (§4.3). It consumes core's helpers and
  never computes a date itself. Its last proof is the console on the full archive in both themes.
  Credentials: `VITE_NAIP_PMTILES_URL` is set by the founder; W reads it only by name.
- **Size:** ~3,800–6,200 added, ~3,600 deleted (§6.2). If the governor wants the founder's pilot look
  in the console itself rather than the viewer, W can start right after B05-1's X instead, against
  the pilot key; the default is after the pilot, as ruled.

---

## What the build found (B05)

**T0, the seams (X, 2026-11-25).**

- **The scouts' inventory rows** carry `id`, `dt`, `gsd`, `y` (a string), `c` (center) and `bbox` —
  **no `naip:state`**; the labeled state is the id's prefix (`vt_m_…`) or the per-state query the
  walk made. S's compact candidate decodes it either way.
- **Item ids can carry a second date**, the processing day: `me_m_4407028_ne_19_030_20231002_20240103`
  was flown 2 October 2023. Verify's *"every flight's date … matches its item id's"* (§2.5) reads the
  **first** date; a parser that takes the last would misdate every reprocessed frame.
- **The six off-season cells** each hold a `…_030_20231002_…` frame (0.3 m) and 0.6 m October frames
  of 2018 and 2021, with summer frames only at 1 m (2011, 2013, 2015) — as §2.1 says.
- **Zooms.** At G-2's 512-px tiles, the doc's pixel zooms and the archive's tile numbers differ by
  one (§2.2 step 3): shards hold tile zooms 11–17, the assembler builds 7–10. Core's
  `naipTileZoom` and `shard.ts`' `SHARD_TILE_ZOOMS` hold that in one place.
- **Codegen.** `pnpm --filter @skating/convex codegen` is the offline stand-in, whose output differs
  from the CLI's by template; after the widen it produced the same module set as the committed
  `_generated`, which was restored unchanged. The widen adds validator members only, so nothing in
  `_generated` moves; CI's `convex dev --once` step is the real check.

## What the build found (B05-1)

**S, selection (2026-11-25).**

- **The rule reproduces the scouts' picks on 9,123 of 9,168 cells.** The other 45 are one frame
  published under two states' labels on the same day (a border cell's two catalogs list identical
  pixels); the rule now breaks that tie by item id, so a pick is never a coin toss. §2.1's table
  shifts by that much between NH, MA and CT.
- **The first full walk** (`naip-20261125`, a dry run): 69,207 items (NY 30,983, ME 16,697, VT
  6,496, NH 6,168, MA 5,208, CT 2,842, RI 813), **9,168 cells, none without a pick**, 28,568 frames in
  picks and stacks, 1,764 work tiles, 140 partial picks, 319 border cells; 9,366 frames scored (every
  pick, then each partial pick's fallbacks round by round), 60 picks over 3% white, one fallback.
  The walk is kept beside its campaign and read back on a re-run, so a select after a refusal
  decides the same build.
- **The envelope's margin is pinned to the catalog's furthest real reach**: Vermont flies `4407361sw`
  on Champlain's New York shore, 0.25′ past its state's envelope; a zero margin dropped it and no
  test noticed (a mutation survived) until one did.
- **The three 2025 0.6 m picks in NH and CT are the rule, not a bug** (§2.1): New Hampshire's 2023
  0.3 m frame at `4407155ne`/`se` was flown on 3 October (leaf-off), and Connecticut has no 2023
  frame at `4107202se` at all.
- **Cell `4506827se`** (T reported the scouts' picks lacked it): they don't. `picks_T2.json` and
  `cloudall.json` both hold it, with the 20 July 2018 0.6 m frame (score 0, full coverage), and S's
  rule picks the same frame with an empty stack — its only other frames are October 2021 (leaf-off)
  and 1 m. Nothing to fix.
- **The cloud review**: two Aroostook frames struck, Long Island and New York City kept (§2.1.2).
- **A test that read core's fixture from `scripts/aerial`** was invisible to Turbo's hash (the
  `turboCache.test.ts` guard caught it); the select stage's tests read a 117-row slice of their own.

**T, tiles, the worker and the entry point (2026-11-25).**

- **No `-cutline`**: a cutline is applied on each source's own grid, and two frames on different
  grids disagreed about a join's edge pixel. Each frame is warped onto exactly its cell's pixels
  (§2.2 step 1).
- **Overviews are 2×2 averages**: cubic read past the window's edge and left a translucent rim
  (alpha 211–238) and a one-pixel spill at every work tile's edge, at every zoom but the deepest.
- **The 15-minute SAS rule**, the **z13 chunks**, and **NAIP's 0,0,0 fill with no nodata declared**
  (§2.2, §9).
- **The warp proof** on three real z14 windows (laptop in the US, network-bound): Champlain's NY 2024 |
  VT 2025 line, 2 of 9 stacked frames shown, 142 MB read, 77 s, 42.7 KB a deepest 512-px tile; the
  72°W UTM seam, 2 of 16, 321 MB, 130 s, 80.0 KB; a partial Maine 2023 pick falling through to 2021,
  3 of 4, 135 MB, 71 s, 75.5 KB. Every assertion held: cells partition each window, no frame paints a
  neighbor, no transparent pixel inside the cells, the pick shows wherever it has pixels, the counted
  frames are exactly the visible ones; the joins register at 0.00 px (72°W, both ways), 0.00 / −0.24
  px (NY | VT) and −0.51 px along the Maine forest join.
- **The image** builds locally from `ghcr.io/osgeo/gdal:ubuntu-small-3.13.2` plus rclone, jq,
  `pmtiles`, Node 26 (which needs `libatomic1`) and the two bundles, and cut the Champlain window to
  the laptop's counts. `pnpm install` inside the build fails the workspace's supply-chain check (a
  401), hence `bundle.sh`. Never pushed.
- **G-6**: `skating-imagery` (§9). **The assembler's region**: `iad`, overridable (§2.4).
- **Changing how a pixel is drawn means bumping `NAIP_TILING_VERSION`**, enforced by a fingerprint of
  the worker's GDAL lines and `TILE_SETTINGS` (`tiles.test.ts`).

**P, the assembler, the date index, verify and cleanup (2026-11-25).**

- **The writer** is checked against the spec and `pmtiles@4.5.0`'s reader: the 127-byte header,
  varint directories, the root inside the reader's first 16 KiB with leaves split as needed,
  clustered order, dedupe through a 128-bit content table, runs for consecutive repeats. The date is
  checked before a byte is written: every pixel's cell is dated from the cut's counts first.
- **Its proofs, re-run at integration (2026-11-26)**: the real region's date index, 168 KB raw and
  **26 KB gzipped** (141 flights, 531 cells dated by two); a region-sized layout of 8.7 M tiles in
  **1.39 GB peak RSS**; a 1.8 GB archive streamed through real `rclone rcat` in fifteen 128 MiB parts,
  byte-equal and `pmtiles verify` clean, at 92 MB/s.
- **The index's hash is over its decoded JSON**, not the gzip body (with S): the encoding is
  transport, and a CDN may re-encode it.
- **The viewer** is MapLibre 6.19.0 (the web's version, from unpkg) with core's own credit range,
  bundled by `esbuild`, which the package declares.

**The integration (2026-11-26).**

- **The merges were clean**: the three territories touched no common file beyond what each owned.
- **Seams closed**: one run-target rule for every stage (the builders' three copies disagreed — the
  tiles and verify stages let a build write its rows to prod or to an unknown deployment); the input
  hash now covers the frames the worker cuts (the rule moved into core as `naipFramesToCut`: a cell
  that became a border cell had its fallbacks cut while its hash stayed the same, so a
  `--from-current` build would have copied its old tiles); the tiling fingerprint reads core's
  version; the units use core's grid, checked cell for cell against the proof's decode; the
  assembler's manifest type is core's; the viewer's core-gated test runs. No `PLACEHOLDER`, `todo`
  or builder-gated skip remains: the skips left are P's three stream proofs (each run by hand, by its
  variable) and two tests that need GDAL, which CI doesn't have.
- **The local end-to-end run**: select and tiles through `run-aerial.sh` (dry runs, the kept walk, no
  network), the real worker on the whole of work tile `11/596/763` (four NY cells, 19% covered)
  against a local stand-in for Planetary Computer serving synthetic COGs, the bundled packer and
  assembler, verify through `run-aerial.sh` against local stand-ins for R2, and the index read back
  with core's parser: 1,139 tiles in 37 s on the laptop, a 1.9 MB archive of 1,143 tiles at zooms
  7–17, its index 147 bytes gzipped, every check passed, the credit *Aerial · NAIP Sep 2024*, an index
  naming another archive refused. The recipe is in `scripts/aerial/README.md`.
- **What that run found, each fixed with a test**: the worker died on any work tile its cells don't
  wholly cover (every coast, border and region-edge tile — `gdal raster tile` refuses a chunk outside
  its mosaic); the overview pass wrote a tile outside its work tile, which the packer refused (the
  overview runs are now bounded to the window; the fingerprint is re-recorded under tiling version 1,
  since no pixel inside changes and nothing had been built); verify handed `pmtiles verify` a URL it
  can't read, so it refused every build wherever the CLI is installed (`pmtiles show` now); and its
  coverage list named all 9,168 cells of a pilot's manifest.
- **The review found**: cleanup skipped its "never the archive the web points at" refusal when the web
  env couldn't be read (it now refuses); `run-aerial.sh` never loaded `scripts/aerial/.env.local`,
  where the runbook puts `AERIAL_IMAGE`, `R2_BUCKET` and `R2_REMOTE` (only `spawn.sh` did, so the tiles
  stage would have refused); and the credentials guard couldn't see any env read under a pipeline's
  `src/` subdirectories — the aerial's stage CLIs read theirs in `src/cli/` (it now scans the whole
  tree, and `05` registers what it found).
- **The manifest is ~6–7 MB, not 1.5–3**: it records every cell and every frame (the pilot's was
  5.4 MB before any counts). For B05-2: the July check fetches and parses it in a Convex action;
  a 7 MB JSON parse is tens of megabytes of heap, near the default runtime's 64 MB, so K measures it
  or runs the action in Node.
- **The cost**: ~$8 a month to keep (~$100 a year, against the ~$70 the founder accepted) and
  ~$30–40 a full build (against ~$20), because the design's 387 GB left out the pyramid above the
  deepest level (§6.1).

**The pilot (2026-11-26).** `naip-pilot-20261126`, `champlain-nhma-me-ny`: built on Fly and R2 end to
end, verified, and looked at. Every key under `naip/build/pilot/champlain-nhma-me-ny/` and
`dev/naip/pilot/champlain-nhma-me-ny/`; its run rows on a throwaway local backend; no Machine left.

- **The list grew by one cell**, `4507038sw` (65 cells, 28 work tiles, 209 cells cut): none of the 200
  cells the proposed list cut had a partial pick with a fallback, which §7.4 must show. It shows: a
  Maine 2023 0.3 m strip over its 2021 0.6 m fallback, dated `2023-09-30, 2021-09-04`.
- **Five defects, each fixed with a test** (commits on the branch):
  - **A pilot uploaded the catalog snapshot outside its prefixes** (`naip/inventory/<day>/`, shared with
    the full build) — found before anything ran; a pilot now archives nothing, and `selectUploads`
    refuses a pilot manifest that asks to.
  - **Every chunk failed on a 4-CPU Machine**: under 8 threads `gdal raster tile` runs a thread pool
    over `GDALGetThreadSafeDataset()`, which can't clone a VRT mosaic of warped VRTs ("Source dataset
    cannot be cloned"); the laptop, with more cores, spawned instead and passed. Reproduced locally by
    forcing the pool. Every tiler run is now `--parallel-method spawn`, byte-identical to a
    single-threaded run (89 real tiles compared); the fingerprint is re-recorded under tiling version 1.
  - **Ubuntu's rclone 1.60.1 can't `rcat` to R2**: every upload's first attempt answered `501
    NotImplemented` (the work tiles' `copyto` retried past it, "Attempt 2/3 succeeded"; `rcat` reads
    stdin once and failed the assembler outright). The image installs rclone 1.74.4 from rclone's own
    `.deb`, checked against its SHA256SUMS — and no build argument may start with `RCLONE_`, which
    rclone reads as a flag (`RCLONE_VERSION` became `--version` and failed the build).
  - **An opaque top tile broke the overviews**: GDAL's WebP writer drops the alpha of a tile with no
    transparent pixel, and the parent VRT asked every child for band 4 ("Illegal band #"). Each child's
    alpha is read from its WebP header; an opaque one gets a constant 255.
  - **Two progress writes raced**: the assembler's concurrent index readers reported 25 and 28 at once,
    two `rcat`s to one key, and rclone 1.74's post-upload check failed the assembly ("corrupted on
    transfer"). The progress hook is serialized.
  - Smaller: a pilot's `aerial_assemble` rows claimed `complete: true` (now only a build's); the
    viewer's date credit sat under MapLibre's attribution (now bottom left), and the viewer keeps its
    view in the URL (`#zoom/lat/lng`), so each join is a link.
- **Measured** (§6.1's last column): 28 work tiles in **9 minutes** wall on `performance-4x` in `ams`
  (256 s a tile, 178–356; tiling 213 s of it, counting 37 s), 318 CPU-seconds a tile, 24 GB read from
  Azure, 4.08 GB of shards (62–202 MB each), scratch under 0.5 GB above the image on an 8.35 GB root;
  the assembler in `iad` on `shared-cpu-4x`, 97 s, writing 4.08 GB at **47.5 MB/s** with **349 MB**
  peak RSS (P's region proof: 1.39 GB); 149,698 tiles, 37 leaf directories, 30 overview tiles.
- **R2, checked from the laptop**: the index served `Content-Encoding: gzip`, `Content-Type:
  application/json`, `Cache-Control: public, max-age=31536000, immutable`, 808 bytes — and decoded for
  a client that doesn't accept gzip; CORS answers `https://skating-app-eight.vercel.app` and
  `http://localhost:3000` (preflight for `range` too) and nobody else; the archive answers ranges with
  206 at its head and mid-file, and exposes `ETag` (`…-31`, the 31 parts of a 128 MiB multipart); the
  whole archive streamed from the public URL hashed to the manifest's SHA-256, byte for byte.
- **The look** (`report/shots/`): the joins register — roads cross Champlain's NY 2024 | VT 2025 edge,
  the NY 2024 | 2019 edge and the Maine edges without a visible offset — and **72°W is invisible**, at
  z16 and z12. What shows is **season and flight, not geometry**: a hard tone step at every join of two
  flights (VT's August 2025 land beside NY's July 2024; NY's 16 September 2024, already browning,
  beside its green 17 September 2019), and over open water a patchwork of tone between quarter-quads
  of one flight. No holes, no black edges, no cloud in the pilot's cells. The photograph stops at a
  straight edge at the last quarter-quads, 45.0625°N, about 7 km into Québec.
- **Maine's September is autumn.** The six October cells look like their "summer" neighbors, because
  those neighbors were flown on 27 September 2023 and are in full color too; what stands out is the
  **ME 2018 cells, flown in July and bright green** among them. And one 2018 cell (`4407012se`) holds
  an orange strip with a ragged edge on its west side: most likely USDA's own seamline within the
  quarter-quad, a part flown on another (autumn) day — which the date index can't see, since an item
  carries one date. Unverified; for the founder's eye with §5.5's revisit.
- **A first view in about a second**: headless Chromium on the laptop, a cold context each time, three
  places at z15 — MapLibre idle at 906, 906 and 1,072 ms after navigation; the first archive range at
  350–415 ms, the last answered by 760–930 ms (13–16 ranges).

**The foliage review (2026-11-27, D319).** Built on the analyst's uncommitted study of 2026-11-26 (the
greenness score and several rules re-run on the real catalog); the founder ruled the same day (§1.2).

- **The score is the analyst's, exactly.** Ported to exact integer tests (`49·G > 51·R` is GRVI over
  0.02), it reproduces his Python scores and turned verdicts on all 35,247 cached thumbnails, frame for
  frame. His no-verdict cut read a rounded vegetation share; the port reads the exact one, and no frame
  on this catalog differs.
- **The proposal matches his figures but for the cloud review's kept frames.** His measured rule changed
  1,076 cells (NY 425); the proposal changes **1,074** (NY 423): New York City's `4007438ne` and
  `4007439nw` keep their 13 September 2024 frames, which the cloud review kept on purpose and the screen
  never proposes. Every other cell picks what his run picked (9,166 of 9,168); 0.3 m → 0.6 m is 264 in
  both. He counted 86 picks still turned; here 88, the same two.
- **Not every kept-turned cell is 27 September 2023.** Of the 80 `allTurned` cells, 76 keep 27 September
  2023 at 0.3 m; `4507035nw`/`sw` keep 30 September 2023 at 0.3 m, and `4407047ne`/`nw` keep Maine's
  19 September 2021 at 0.6 m (no 2023 frame there; no green frame at 0.6 m or better).
- **A struck frame is demoted, not dropped** (the builder's reading of "strike", D319): it shows only
  where nothing green has pixels. In **105 cells** the new green pick is partial and a demoted frame is
  among the frames cut under it — 34 in the Catskills (41.x°N, 74–75°W), 39 along the Vermont–New
  Hampshire line (44.x°N, 71–72°W), the rest scattered; dropped, that part of each cell could be
  empty. The
  date index dates such a strip by its own frame. Partial picks stay at 140, as before.
- **The six-cell list is gone, and with it the refusal of a seventh** (ruling 3: a rule, not a hand
  list). The off-season step now names its cells, with why, in every run's log and the manifest.
- **The proposal's shape:** 16 whole flight days and 508 frame entries. Most frame entries are days where
  turned frames are a minority of the day: New Hampshire's 20 September 2025 0.6 m flight (186, all
  fallbacks under 2023's 0.3 m frames), New York's 19 September 2021 (90) and 13 September 2024 (59),
  and so on, 23 days in all. Fifteen proposed days change no pick at all.
- **Borderline (0.6–0.7):** 203 picks over 24 days stay; New York's 14 September 2024 holds the most (34),
  visibly yellowing in the analyst's sheet.
- **One new pick crosses the cloud threshold**, unreviewed: `4606701se` falls from ME 2021 to ME
  2018-07-21 at 4.7% white — Loring's runways and bare fields, a false positive by the builder's
  pre-screen. The applied run's cloud sheet holds it.
- **Rule 2, manifest 2.** `NAIP_RULE_VERSION` and `NAIP_MANIFEST_VERSION` are 2; the pilot's archive and
  manifest (rule 1) stay as built, and no `--from-current` build is ever based on a pilot.


**The independent review (2026-11-27)**, before the PR, of the whole branch and the foliage commits
in particular. Each fix landed with a test (commits on the branch):

- **`spawn.sh` spawned past the Machine cap.** Its wait for room gave up after twenty minutes and
  spawned the batch anyway (fan-out.sh's shape), so a `fly machine list` that kept failing — read as
  the cap — or an app the winter pump kept full got work-tile Machines on top of `MAX_PARALLEL`. A
  round now fails and spawns nothing more; the assembler's Machine waits under the same cap.
- **Cleanup read only `apps/web/.env`**, while the checkouts keep their URLs in `.env.local`: it
  refused every run, and with an `.env` lacking the variable it would have read "nothing is live" and
  deleted the archive `.env.local` points at. It reads every env file Vite does, by archive name.
- **`--from-current` built on any manifest it was handed.** A version-1 one (the pilot's) went
  through with its off-season cells misread, a narrowed build kept rule-1 picks under a rule-2
  stamp, and a production build could base itself on a pilot. It now refuses another format, a
  narrowed build on another rule, and the other kind of build.
- **A re-cut left the old done record over the new pack** until its own landed: a death between
  pack and index, then a manifest returning to the old hash, would have the assembler range-copy the
  wrong bytes. The worker drops the done record first.
- Smaller: verify left its row running when it threw; an assembly that stopped before its manifest
  refused every re-run as "already exists" (it now says what to delete; deleting by hand stays the
  answer, a ruling, §2.5); `--keep` kept the rclone config holding the R2 secrets; the foliage sheet
  told the founder a struck frame never shows; and D314 and §5.1 promised the aerial "can never show
  ice", which the off-season step can break (D312, D147's record, `04` and the older imagery docs
  said the same and now read "never evidence about ice").
- **The reviewer's open calls, ruled by the governor (2026-11-27):** the wording above; a struck
  flight day also strikes frames the catalog adds to that day later, accepted and said on the sheet
  (§2.1.4); and an archive orphaned by an assembly that died before its manifest is deleted by hand
  (§2.5).
- A property test now holds the proposal's flight-day entries to the selection's reading of them.

**The PR's review (2026-11-27)**, three comments on #188, each checked against the code and the data
before anything changed; each fix landed with a test (commits on the branch):

- **Verify read an item id's date with its own pattern**, which wanted a three-digit resolution
  token. The walked catalog's tokens: `060` 29,424, `1` 27,191, `030` 5,856, `.5` 3,876, `h` 1,587,
  `.6` 1,273 — and the `.5`, `.6` and `h` ids are 0.5–0.6 m frames of 2015–2016, so candidates: 5,156
  of the manifest's 28,566 frames, all in fallback stacks, 555 of them in the 319 cells whose
  fallbacks are cut. The pilot cut 42 and none showed; in the full build any that did would have
  refused the whole assembly after the tiles were paid for. Verify now reads core's
  `parseNaipItemId`, the one reader of an id (walk, select, verify), and **the select stage holds the
  manifest to verify's date rule before writing it** (`checkManifestFrames`), so a date problem never
  reaches a Machine.
- **Cleanup's week counted from the replacement's upload**, not its publication, which nothing
  records: `--live-since` now states it, and cleanup refuses without it, with one in the future or
  before the upload, and while no web env file points at the replacement (§2.5).
- **A strip narrower than a z16 pixel could stay transparent** (§2.2 step 4): fixed under tiling 2.
  Re-running the warp proof on its three windows of real frames: no check fired, the same frames show
  from the same reads (142.0, 320.7 and 135.2 MB), every assertion held.
- **Checked and left:** the catalog reader against every downstream reading of an id (the walk
  checks `datetime` against the id's first date; a kept walk's rows match their ids on all 69,207;
  the date index and the foliage strikes read the manifest's frames, never an id; the worker resolves
  a COG through STAC by id; `aerialImagery.ts`' scene-name resolution belongs to the USGS path B05-2
  deletes); and every other z18 fact taken from a coarser sample — `partial`, from the 200-px
  thumbnail, decides whether a cell's fallbacks are cut at all (the pilot's 286 pick-only cell and
  work tile pairs had the pick at every counted pixel; a sub-pixel strip in such a cell would have no
  fallback to fill it in any design short of cutting every stack), verify's coverage reads the same
  counts (a report, and now counts the strips), and a cell with z18 pixels but no z16 pixel in a
  window, which the real grid never has (0 of 18,225 pairs) and the unit now refuses rather than
  dropping silently.
- **Work tiles spawn on `performance-4x`** by default (the governor's ruling, §6.1).
- **The strip check's reads went uncounted** (a fourth comment): the worker's source bytes are the
  network statistics each `gdal_read` captures, and the counts helper ran outside it, so a check's
  remote reads (its in-memory warp of a 100 m box of a served, tiled 0.3 m GeoTIFF of noise: 803,080
  bytes, measured on GDAL 3.13.2 over a local range server) never reached the total. The same rule caught two older opens:
  a warp to VRT and the mosaic's open of each warped layer read the source's header, 16,384 bytes
  each. All three now run under `gdal_read`, so "bytes read from the source" has one counter; the
  helper's Python GDAL prints its statistics on stdout at exit like the CLI does (a real-GDAL test
  over HTTP holds that; a stand-in test on CI holds the sum). No check fired in the warp proof's
  three windows, so their totals above were short only by those header reads. Nothing drawn changed;
  tiling stays 2.
- **An empty stats file stopped the worker before its upload** (a fifth comment, on the fix above):
  real. The collector ended its loop on `[[ -s "$f" ]] && awk …`, so when the glob's last file was
  empty the loop returned 1, and `pipefail` with `set -e` stopped the worker after the pack, before
  the upload, silently and on every retry. A counts helper that runs no strip check prints nothing
  — the common case — and with 10–89 stats files the glob ends at `9.txt`, which is a counts file
  for three single-frame cells or a four-frame one. Reproduced on real frames (three single-frame
  cells at Champlain's 44.9375°N corner, work tile 11/606/737: the old worker packed 64 tiles and
  exited 1 with nothing uploaded; the fixed one landed them, 51.2 MB read). The stand-in tests had
  missed it twice over: their `gdal_translate` printed no statistics, where the real one reads the
  source, and their two cells put a deepest-zoom warp, never empty, at `9.txt`. The test is an `if`
  now, so the loop's status is 0 whatever comes last; the stand-ins print what GDAL prints, and new
  tests run three single-frame cells and a sweep of cell counts and depths (to 138 files, where
  `99.txt` sorts last).
- **The same audit, the whole worker and every script the pipeline ships**, for a failure `set -e`
  can't see. Two more were real and are fixed, each with a test: the mosaic's layers were read
  through a process substitution, so a `layers` that refused the counts read as no frame showing and
  an empty shard would land (the packer doesn't read the windows); and most reads of the unit sit in
  word lists, process substitutions and functions run under `||`, where a field jq can't read comes
  back as nothing — no `settings.bands` would warp every band with the red as alpha, no chunk
  `cells` would skip the chunk — so the unit's shape is now checked once, before any read. Checked
  and fine: every other `[[ … ]] && …` and `(( … )) && …` (none is a loop's, function's or stage's
  last statement where its status counts), the counters (`x=$((x + 1))`, never `((x++))`), the
  SAS, resolve and upload steps (every failure reaches a `|| return 1` or `|| die`), rclone's
  "not found" on the old done record, the redactor's drain; `spawn.sh` (a spawn failure is logged,
  not fatal, by design; `seq 1 0` and an unset `live` bite only at zero tries), `run-aerial.sh` (a
  stage's own status, tested), `assemble-aerial.sh`, `bundle.sh` and the warp proof's driver.
  `shellcheck` is not installed here and wasn't run. Nothing drawn changed; tiling stays 2.

**The PR's fifth review, and the sweep for what a pilot can't show (2026-11-27).** Greptile (4/5):
a healthy assembly times out. Real. Each fix landed with a test that failed first (commits on the
branch); nothing drawn changed, tiling stays 2.

- **The laptop called a long zoom dead.** The assembler reported progress once per zoom (when the
  zoom's first run finished), and the laptop failed the row after 60 minutes without a new event.
  At the pilot's per-zoom tile sizes (z11 49.7 … z16 36.4, z17 21.0 KB), each level a quarter of
  the one below, tile zoom 17 is **59%** of the bytes — **~154 GB of a ~260 GB region** (130–178 GB
  over 220–300), **~54 minutes** at the pilot's 47.5 MB/s (46–62), with z16 another 25.7%, ~23
  minutes. The quiet window was all of z17 plus the index and manifest: inside the hour by ~10% at
  the central figure, past it from ~289 GB or below ~43 MB/s (the pilot's whole z17 was ~50 s).
  Now the assembler beats at least every five minutes within a zoom (`HEARTBEAT_MS`, riding the runs,
  which are one work tile's zoom each, seconds apiece); the laptop's quiet limit is 30 minutes
  (`FOLLOW_QUIET_MS`); and the Machine stops itself after 20 minutes with no progress
  (`MACHINE_STALL_MS`, writing its error object), so a stuck read or upload frees its Machine and
  the laptop learns why. A test assembles six work tiles whose deepest zoom takes two hours of the
  Machine's clock and follows it from a simulated laptop with the defaults: it failed with "no
  progress … for 60 minutes" before the fix.
- **Losing the event stream never fails a live assembly.** The follower counts quiet only while it
  is awake and can read the bucket: a read that can't reach R2 (rclone's exit other than 3 or 4,
  "not found") or a gap between polls past two minutes (the laptop asleep) adds nothing, and
  whether the Machine is up is `spawn.sh`'s answer from Fly's list, which reads a failed list as "up".
  Only a Machine Fly lists as up whose readable progress hasn't moved for 30 minutes is called stuck,
  and the message says to stop it. Once the Machine has gone, the record is read through a blip (ten
  tries) before anything is called failed. **A re-run attaches**: `spawn.sh assemble` follows an
  assembler already running rather than start a second (two would stream the same archive past each
  other's "never overwrite" check), and starts nothing when the list can't be read; the laptop takes
  a finished assembly from its record (a run that lost its stream at the end is closed by the next
  as succeeded, never assembled twice); an earlier attempt's error object is never read as this
  run's. `spawn.sh`'s wait is 12 h and exits 3 when it gives up on a live Machine, which the laptop
  no longer reads as "stopped without a record". The Machine's progress writes are bookkeeping: a
  failed one (a transient R2 error on a tiny `rcat`) used to fail the assembly, and the stream waited
  on each; now neither (~100 writes at region scale, ~16 in the pilot).

**The sweep: every assumption sized by a 65-cell pilot, against the region** (9,168 cells, 1,764 work
tiles, ~8.7 M tiles, ~260 GB, 7–9 h on 25 Machines from a laptop). Fixed, each with a failing test
first:

- **A hung worker was never killed.** No deadline on a work tile, and GDAL bounds no stalled read
  (no `GDAL_HTTP_TIMEOUT` or low-speed limit): a Machine whose worker never exits holds a slot and
  bills `performance-4x` until someone looks. The pilot's 28 tiles took 178–356 s; the region's
  1,764 are 63× the chances. Every worker now runs under coreutils' `timeout --kill-after=60 3600`
  (`AERIAL_TILE_DEADLINE`; ~10× the mean, ~5× a border tile's estimated ~12 minutes), which signals
  the worker's whole process group — a test holds the real tool to it, children included — and the
  next round re-cuts it. The drain now waits 90 minutes, past the deadline.
- **A re-run doubled live work tiles.** A round whose capacity wait failed, a drain that gave up, a
  `fly machine run` that timed out after creating its Machine, or a laptop that lost the stage, and
  the next round spawned every outstanding work tile again beside its live Machine. `spawn.sh` now
  waits for a work tile whose Machine is up, and spawns nothing when the list can't be read ("can't
  tell" is never "none").
- **The tiles row was silent for a whole round.** §2.6 promised a beat every 25 work tiles; the
  reconcile ran only after a round drained — 9 minutes in the pilot, ~5 h for the region. A round
  now reads the done records every ten minutes (`ROUND_BEAT_MS`; ~1,764 GETs a read, ~$0.02 over the
  run), a failed read skipping a beat, never the round.
- **No read was retried.** The assembly's `httpStore` (and verify's) failed on the first network
  error or 5xx: ~270 requests in the pilot's assembly, ~17,600 in the region's (1,764 done records
  and indexes, their top tiles, ~12,300 runs). Now three retries at 1, 4 and 16 s for a network
  error, a 5xx or a 429, never a 404, another 4xx or a short read, and a stream only before its first
  byte.

Checked and fine, with the numbers:

- **Timeouts and retries.** `SPAWN_TIMEOUT` 120 s per `fly machine run` (per call, scale-free);
  the capacity wait, 240 polls (20 min) per batch of six against work tiles of 3–6 minutes; the
  follower's 30-s poll; the worker's SAS margin (180 s) against its longest single run — a z13 chunk,
  ~13 s in the pilot (213 s of tiling over 16 chunks), ~40 s on a border tile reading 2.5 GB — and the
  counts helper's 37 s; GDAL's 5 retries, curl's 3 (429 among them) for SAS and STAC, the chunk's one
  retry with a fresh token, rclone's 3 for uploads: per work tile, and a failed tile is re-cut by the
  next round. Planetary Computer's and Fly's rates sustained for hours are H1 and H2 (§7.6).
- **Listings.** The done records are one `rclone copy --include '*.done.json'` a reconcile: rclone
  pages S3's list at 1,000 and follows the continuation (~5,300 objects under `shards/`, six pages),
  and a failed list exits non-zero — the stage fails, never reads part of a listing as all of it.
  Cleanup's `lsjson --recursive` and `delete` of a prefix are rclone's, paged the same way. `fly
  machine list --json` holds 25 live Machines at most, the winter pump's included.
- **Arrays and arguments.** The run row forwards at most 200 failures (`MAX_FORWARDED_FAILURES`) and
  ~35 counts; a tiles failure's message names every failed work tile, ≤ 1,764 × 13 B ≈ 23 KB in the
  `convex run` argv (macOS's `ARG_MAX` 1 MiB, Linux's 128 KiB an argument). Units go to Machines by
  file: the largest of the region's 1,764 is 12.7 KB (median 9.5 KB, ≤ 16 cells and 68 cell frames;
  measured on the kept region manifest `naip-20261127`); work-tile lists by file; jq reads one unit
  or one machine list.
- **Memory.** The assembler: the scale proof re-run here under a 2 GB heap cap (V8's limit on a 4 GB
  VM): 8.41 M tiles, **1,372 MB peak RSS**, layout 2 s, plan 2 s; beside it `rclone rcat`'s two
  128 MiB parts in flight, `rclone serve http`, the writer's ≤ 128 MiB prefetch, the 5.8 MB manifest
  parsed and ~600 overview tiles (~30 MB): ~2.1 GB of 4 GB. The date index (26 KB gzipped) is built
  before the layout; verify's sample is on the laptop. Verify holds every tile's source in a map:
  ≤ 176 B a tile measured, ~1.5 GB for 8.7 M, under this laptop's 4,192 MB default heap limit (Node sizes it from the machine's memory: on a
  smaller laptop, run verify with `NODE_OPTIONS=--max-old-space-size=4096`).
- **Run-row writes.** Every logger call is swallowed (`@skating/run-log`'s rule 1): a refused write
  never fails a stage. The assembly beats at most once per 30-s poll, ~100–180 flushes over ~1.5 h;
  the tiles row ~30 over 5 h; the aerial kinds have no `RUN_QUIET_MS` entry, so Machinery never calls
  one stalled.
- **The upload.** `--s3-chunk-size 128M`, which rclone's streamed upload uses: 10,000 parts × 128 MiB
  ≈ 1.22 TiB against ~260 GB (~1,940 parts); a part is never near 5 GiB, the object nowhere near
  R2's ~5 TiB. An interrupted one is H5 (§7.6).
- **Disk.** A worker's scratch stayed under 0.5 GB of its 8.35 GB root with shards to 202 MB, and a
  work tile is at most 5,461 tiles, so the region's land tiles are the pilot's size class; the
  assembler spools nothing (the overviews are in memory, each parent's GDAL run in a scratch
  directory it removes).
- **The laptop asleep.** Select is local; the tiles stage's loops count polls, not time, so a sleep
  pauses them while the Machines carry on, and a re-run resumes by done record and now waits for
  live work tiles; verify reads through blips (above) and is read-only, so a re-run is safe; the
  assembly is above.
- **Clocks and order.** Landed is a done record's input hash, never a time; the newest archive is
  the key's date, one campaign a day; cleanup's week counts from `--live-since` (or a pilot's upload
  time); the follower compares the progress object's `at` for identity, never against its own clock.

**The PR's sixth review, and the sweep of every "already done" shortcut (2026-11-27).** Greptile
(4/5) on the fifth review's re-run rule: changed picks never reach the archive. Real. Each fix landed
with a test that failed first (commits on the branch); nothing drawn changed, tiling stays 2.

- **A re-run of `assemble` took any assembly record as "already assembled"** (the fifth review's
  "a re-run attaches"), without reading the build's manifest. Re-run select and tiles under the same
  campaign after the founder strikes a frame, and the tiles stage replaced the bucket's manifest and
  re-cut the changed work tiles, while `assemble` reported success on the old record and the archive
  kept the earlier selection; verify then said the re-cut work tiles "had not landed" — or passed,
  when the change moved no pick (a strike on a frame that never shows). A test assembles a campaign,
  changes one cell's pick, re-cuts its work tile and re-runs: before the fix the laptop answered
  "already assembled". **One identity** now says what an archive was built from — core's
  `naipBuildInputsHash` (§2.1.3) — and every stage holds a campaign to it (§2.4): the record carries
  it; the laptop compares it before it spawns and again on the record that lands; the assembler
  refuses a published campaign before it reads a shard (the same inputs as done, others as a new
  campaign's: what differs, and `--from-current` from the published one); verify holds the record,
  the published manifest and the build's to one value (§2.5); and **the door upstream is closed** —
  the select stage (not a dry run) and the tiles stage read the campaign's published manifest
  first, so other inputs never replace the manifest a published archive was built from (the tiles
  stage, with the same inputs, has nothing to cut and uploads nothing). Measured on the kept region
  manifest (`naip-20261127`, 5.8 MB, 9,168 cells, 1,764 work tiles): the hash takes 94 ms, a diff
  37 ms. The pilot's record (version 1) names no inputs and is never taken as a build's.
- **The work unit's geometry drew pixels nothing pinned** (the sweep): which pixels each frame is cut
  to (`pixelExtent`, core's outlines), the counts' window and ring, the chunks and the overview pass
  are computed in `tiles.ts`, and neither the input hash nor the worker's fingerprint saw them. The
  tests hold their properties, so a rounding rule changed from "centers inside" to "left edges
  inside" — other pixels, the same partition — passed all 537 tests, and a `--from-current` build
  would have copied the old tiles beside the new: a half-pixel seam at every join of a copied and a
  re-cut work tile. Real work tiles' units are now fingerprinted per tiling version beside the
  drawing (recorded under 2; the same mutation fails it).
- **Re-reading the fifth review's three commits**, two more were real: a progress write that hung
  (an upload R2 accepted, then stalled) held every later one behind it, so the laptop read an
  unmoving progress object while the archive streamed on and, after 30 minutes, told the operator
  to stop a healthy Machine — each write is now abandoned after two minutes (`PROGRESS_WRITE_MS`),
  the watchdog still fed by the events, never their writes, and the Machine exits once its record is
  written; and `readObject` read any "not found" in rclone's output as an absent object, so a laptop
  whose rclone has no config (`Config file "…" not found - using defaults`, then a failure to reach
  the bucket) read the record, the build manifest and a published manifest as absent — only exit 3
  or 4, or "object/file/directory not found", is absent now. Smaller: the earlier attempt's error
  object is read before the row opens and a failed read starts nothing (it was swallowed, so a blip
  could read an old message as this run's), and a Machine's refusal stays "refused" on the laptop.

Checked and sound, each "already done, skip" shortcut by what identifies its inputs and who compares
it:

- **The tiles stage's done records.** Landed is campaign, work tile and input hash, compared by the
  reconcile, the assembler and verify (`shardLanded`); the hash covers the rule's version, the tiling
  version, zooms and tile size, the work tile and each cell's pick, stack, `partial` and the frames
  cut (`naipFramesToCut`, which reads the states); `TILE_SETTINGS`, the worker's GDAL lines, the
  counts helper and now the unit's geometry are fingerprinted per tiling version. A cloud score
  changes no pixel and is outside the hash; a frame's COG is read by item id through STAC.
- **The kept catalog walk** is the campaign's by design (§2.1: a campaign reads one snapshot, its
  per-state counts checked against `walk.json`); its day is in the manifest and so in the identity.
  A change after publication is a new campaign, which walks afresh — or reads a walk copied in by
  hand (the README's recipe).
- **The score caches** (`scores.json`, `foliage-scores.json`) are by item id; a thumbnail is
  immutable by id, and neither measure has changed since it was written (`git log` on both). The
  measure itself is not in the key: a future change to `scorePixels`' or `foliagePixels`' constants
  must move its cache aside by hand. Not guarded; noted for the founder.
- **The date index** is built by every assembly from the manifest and the counts — the cut's, or a
  copied work tile's from the current manifest under the same input hash — never kept; verify checks
  its hash against the published manifest, and the client refuses one naming another archive.
- **Verify's report** is written afresh on each run; files a run doesn't write stay in the directory
  but nothing links them.
- **Cleanup's replacement** is `<campaign>`'s archive key, which must be in the bucket, newer than
  `--old` and the one the web's env files name, live a week by `--live-since`. What it copied is in
  its own archive by then (a `--from-current` build range-copies, never links).
- **`--from-current`'s copies**: each copied work tile's input hash is the current manifest's, read
  from the bucket by the name `basedOn` gives and the archive the manifest names; the assembler
  re-checks both, so a stale local `NAIP_MANIFEST_URL` copy only refuses.
- **The fifth review's other changes**: the retry wrapper repeats only reads (GET, HEAD, ranges), a
  404 is "absent", any other 4xx and a short read fail at once, and a stream only before its first
  byte; a programming `TypeError` is retried as a network one and then thrown unchanged (21 s, never
  masked). The tiles row's beats skip a failed read and never outlive their round. `spawn.sh`'s
  listing failures start nothing; its give-up reads a list that keeps failing as "still up" (exit 3),
  the conservative way.

Open, for the founder:

- **A campaign's keys after cleanup.** Cleanup deletes an old campaign's published three and its
  build prefix; nothing then stops the old campaign id being selected and published again, at keys
  CDNs may still hold for a year. One-line guard: the select stage refuses a production campaign not
  newer than the newest archive its prefix has held (cleanup would need to leave a marker for that).
  Not built; rare by hand.
- **An assembly that dies between its manifest and its record** leaves a published campaign with
  no record: the stage then refuses as "already assembled from these inputs", and verify refuses
  without the record. Rebuilding the record from the published manifest and the plan is possible;
  not built (two tiny uploads a second apart).
- **Two pilots on one day share Machine names** (`spawn.sh`'s stamp drops the pilot's name), so a
  re-run could attach to, or wait for, the other pilot's Machines. Pilots are run one at a time.

**The independent review of the last two rounds (2026-11-27)**, `b4dbfa253..053f9eea9`, read code
first and tried against the real tools where they are installed. Two defects, each fixed with a test
that failed first; nothing drawn changed, tiling stays 2.

- **The select stage decided a build on a thumbnail read that failed this time.** A failed read (a
  network error, a 5xx, a 429, an expired token's 403) was an unscored frame, never cached, and an
  unscored pick is cut as partial — so `partial`, its work tiles' input hashes and the build's
  identity all hung on that one read, and the next run, reading it again, could decide another
  build. Running the same command again is the README's resume, so: a resume during the assembly
  re-cut those work tiles (the tiles stage saw "outstanding" against the new hashes) and overwrote
  the packs the assembler was range-reading, into keys never overwritten; a resume after
  publication was refused as "other inputs" and sent the operator to a needless new campaign. (A
  laptop asleep during scoring makes it likely, not rare.) Reproduced in `selectStage.test.ts`: a
  pick unread, then read — before the fix the published campaign's re-run was refused, `cells: 1
  changed; work tiles: 2 changed`. Now `scoreFrames` names the reads a re-run may answer
  (`unreadable`), and anything but a dry run refuses while a **pick** is among them (its re-run reads
  only those, the rest cached); a fallback's failed read only thins the cloud sheet and is logged.
  No thumbnail, a 404 or 410, and a kept image GDAL can't decode stay unscored for good. The region's
  dry run (`naip-20261127`) had no unscored pick, so this refuses nothing on today's catalog.
- **The tiles stage re-cut work tiles under a live assembler.** Nothing stopped `spawn.sh tiles`
  while the campaign's assembler streamed (a resume like the one above, or a pick changed by hand
  before publication, the sixth review's case): a re-cut drops the done record and overwrites the
  pack and index at the keys the assembler reads, so it would stream the new pack's bytes at the old
  offsets into the archive — at best a short read that fails it, at worst wrong bytes published.
  `spawn.sh tiles` now spawns nothing while `aerial-asm-<stamp>` is up and something is left to cut,
  from the same one listing (`tilesScripts.test.ts`; another campaign's assembler doesn't count).

Checked and sound, each against the code (and the real tool where named):

- **The happy path from nothing, and every resume.** Real R2 (read-only, the pilot's prefix):
  `rclone cat` of a missing key exits **0 with nothing**, not 3 or 4, and `readObject` reads that as
  absent; a missing config exits 1 (`didn't find section`) and network or credential failures exit
  1, read as "can't tell"; `rclone copy` of a prefix that doesn't exist yet exits 0, so a first
  reconcile reads nothing landed; `rclone deletefile` of a missing done record exits 4, as the worker
  expects; `fly machine list --json` of an empty app prints `[]`, as the stand-in does. Select,
  tiles, assemble, verify and cleanup were traced from nothing and resumed at each boundary; the
  strike change before any build (same campaign, changed work tiles re-cut) and after one
  (`--from-current`, a new id) do what §2.4 says. **Verify against the real pilot** (`--dry-run`, its
  report put back after): one problem, "the assembly record names no inputs", every other check
  passed — the version-1 record and manifest are refused loudly, never misread. `--from-current` on
  the pilot's manifest is refused by format and kind; cleanup reads no record or manifest.
- **The identity.** Canonical JSON in fixed sections, keyed tables sorted, `perState` sorted, numbers
  as ECMAScript prints them (the same on any Node), `undefined` and missing alike; the assembler's
  additions are outside it and a JSON round trip changes nothing. Pixel-relevant inputs are in it or
  fingerprinted (rule, tiling, zooms, tile size, picks, stacks, `partial`, frames cut, the strike and
  exclusion hashes, the catalog read; GDAL lines, `TILE_SETTINGS`, the unit's geometry); the overview
  zooms are rebuilt by every assembly. Volatile: only the thumbnail scores, fixed above. Not in it,
  by design: the image digest (a rebuilt image under the same tiling version mixes encoders — the
  base and GDAL are pinned).
- **Timers.** The beat (5 min) < the Machine's stall (20 min) < the laptop's quiet (30 min); the quiet
  clock pauses only while reads fail or the laptop slept, and is bounded then by `spawn.sh`'s 12-h
  wait (exit 3, handled by its one caller) and, once the Machine has gone, ten late reads. GNU
  `timeout` is in the Ubuntu base (coreutils is essential there) and the deadline test runs the real
  one; a killed worker leaves no done record (it is dropped first, uploaded last, one PUT), and a
  killed work tile is re-cut at most three rounds.
- **Retries and best-effort writes.** Only reads are retried, a stream only before its first byte;
  404 and other 4xx fail at once. An abandoned progress write can land late and move the row's
  counts back — cosmetic: the follower acts only on the record and on Fly's list. Every abandoned
  promise is handled (`withDeadline`, `rcatSink`'s `exited`/`died`).
- **Shell.** `spawn.sh` refuses bash 3; `cut-aerial.sh` needs 5 and runs only in the image;
  `run-aerial.sh` runs on macOS's 3.2 (checked by hand: its argument and empty-array forms pass under
  `set -u`), except that 3.2 can't `wait` for the logger, so the log's last lines land a moment after
  the exit — cosmetic. `proofs/warp-proof.sh` uses `mapfile` (bash 4), a proof, not the pipeline.
  No `local x=$(…)`, `((x++))`, `sed -i`, `stat`, `date -d` or `sort -V` in a shipped script.
  `shellcheck` is still not installed.
- **The real-tool tests**, run here: `cutAerialServed` (3) and `aerialCounts` (4) pass on GDAL 3.13.2
  and Homebrew's Python 3.14; P's stream proof re-run through the changed assembler: 1.78 GB in 15
  parts, 121,122 tiles, byte-equal, `pmtiles verify` clean, 96 MB/s.

Open, for the founder (the three left at the sixth review, read again):

- **A campaign id reused after cleanup** can't happen in the planned sequence (each build is dated
  the day it runs), and would mix bytes only for a client that cached the old archive at that URL.
  The guard needs no marker: cleanup never deletes the newest archive, so the select stage could
  refuse a production campaign dated no later than the newest archive under `dev/naip/` unless it is
  that campaign. Not built.
- **An assembly dying between its manifest and its record** is a second's window; every re-run then
  spawns a Machine that refuses "already assembled from these inputs" (misleading: there is no
  record). Recovery as for an orphaned archive: delete the three published keys by hand (nothing has
  served them — but run verify first and it fetches the manifest through the public URL) and assemble
  again. Smallest guard: the laptop, finding no record but a published manifest, refuses before it
  spawns and says exactly that. Not built.
- **Two pilots on one day** share Machine names; with the guard above, a pilot's assembler now also
  stops the other pilot's tiles stage from spawning (conservative). Pilots are run one at a time;
  not in the plan. Not built.

**The PR's seventh review, and decide before you write (2026-11-27).** Greptile (4/5) on
`spawn.sh`'s live-assembler check: a refused re-run changes the active build. Real, and reproduced
(`operatorSequences.test.ts`; `refusals.test.ts`' `tiles.assembling`): re-run select with changed
picks and then tiles while the campaign's assembler streams, and `cli/tiles.ts` uploaded the new
manifest over the build key before `spawn.sh` refused; the assembler finished from the one before,
verify rejected the mismatch, and restoring the selection didn't repair it (tiles saw the matching
published manifest and uploaded nothing). The last four findings had one shape — a write, then the
check that refuses — so the fix is the rule and the test of it (§2.8), not one moved line. Nothing
drawn changed; tiling stays 2.

- **Every stage is a preflight and a body** (§2.8). The tiles stage now reads whether the campaign
  is published, what the bucket's build manifest names, and whether its assembler is up
  (`spawn.sh status`, new and read-only) before it writes a unit, a manifest or a Machine; under a
  live assembler it writes nothing unless the assembler is reading exactly this selection with
  every work tile landed (then there is nothing to write). A published campaign whose build manifest
  drifted is put back by the next tiles run, never while the assembler is up.
- **The inventory, as data**: 95 refusals, each with an id; the scan and the typed table make a new
  refusal without a case fail the suite. **Before this change, 39 of them broke the rule**: the
  seventh review's (`spawn.sh`'s live-assembler refusal, after the manifest and snapshot uploads —
  now two, `tiles.assembling` and `tiles.recutUnderAssembler`) and `spawn.sh`'s can't-list refusal
  the same way; every tiles refusal after the units were
  rewritten (the three run-target ones, `R2_BUCKET` and `AERIAL_IMAGE` unset, a published campaign
  of other inputs, the snapshot's three); every select refusal decided after the walk, which had
  already beaten the row once a state (the holes, the invariants, `--cells` uncovered, a pick
  unread, an undatable frame, a published campaign of other inputs, `R2_BUCKET` unset, the four
  `--from-current` checks, which ran only once the manifest was built); every assemble refusal the
  Machine decided that the laptop could have — published with or without other inputs, the orphans,
  a work tile not landed, the manifest's pilot, no work tiles, the base's three — each started a
  Machine to refuse (the published one now `assemble.publishedNoRecord`); the Machine's own refusals after its first progress write (the date index, an
  empty archive or zoom, a key that appeared, and the index and copy refusals past the first 25 work
  tiles); and the foliage review, whose proposal and sheet were written before the applied dry run
  that could still refuse.
- **What an interruption leaves** (§2.8's table). Two were unrecoverable by a re-run and are fixed:
  **cleanup deleted the archive first**, and the archive is what its plan reads, so a cleanup stopped
  after it refused every re-run (`… is not in the bucket`) with the index, the manifest and the build
  prefix left — it now deletes the archive last; and **the foliage review's** order, above. One is new
  as a refusal: an assembly that stopped between its manifest and its record (the sixth review's
  open item) is refused on the laptop before any Machine, saying to delete the three published keys
  by hand — the smallest guard that item named. The orphaned archive stays the ruling's by-hand
  delete.
- **Two terminals**: nothing was exclusive. Two tiles stages rewrote one units directory under each
  other's `spawn.sh`, two selects one kept walk; worse, a tiles stage's upload could land while the
  other terminal's assembler started. Built: **a campaign lock** (`src/campaignLock.ts`), a file
  created with `O_EXCL` in the scratch root before a stage reads anything, removed when it ends
  (and on Ctrl-C), naming its holder; a second stage refuses `lock.held`, and one left by a crash
  refuses `lock.stale` with the path to remove. Its reach is one checkout's scratch — see the open
  item below.
- **`--from-current` while its base assembles** is already refused (`select.fromCurrentUnpublished`:
  the base's manifest names no archive until it is published).
- **Small changes in what an operator sees**: the select row no longer beats once a state during the
  walk (its counts arrive with its close); a refused assemble opens no row (it opened one and failed
  it); every CLI says `refused:` for every refusal (a missing variable said `failed:`); a malformed
  `--live-since` is refused as `cleanup.liveSinceDay`/`Format`, in the same words, not re-wrapped.
- **The image must be rebuilt before the next build**: the assembler's progress gating and its
  earlier key checks are in `assemble.ts`, which the image bundles (as the fifth and sixth reviews'
  changes already require).

Open, for the founder:

- **The lock's reach.** It lives in the scratch root, so it covers one checkout. Two worktrees of
  this laptop running one campaign each have their own scratch (their own manifest and lock) and
  share the bucket. Options: (a) keep it per checkout — a campaign run from two checkouts already
  diverges in its scratch, and the full build runs from one; (b) move it to one per-user directory
  (`~/.cache/skating-aerial/locks/`), which covers every checkout on this laptop for one more path
  outside the repo; (c) a lock in the bucket, which would cover two machines but needs a conditional
  write `rclone` can't make (R2's `If-None-Match` through `--header-upload` is unverified, and
  verifying it is an R2 write). Recommendation: (b), a two-line change, if worktrees will ever run
  stages; otherwise (a) as built. **Ruled (the governor, 2026-11-28): (b)**, built at the independent
  pass below.

**The independent pass over the eighth review (2026-11-28).** A reviewer who didn't write the
restructuring read it against the pushed code (`ef1d0470f`), stage by stage, before the commit
messages. Three findings, each confirmed first, and the governor's ruling built:

- **The lock was left by two of the ways a stage's process ends.** It was released in the body's
  `finally` and on SIGINT, SIGTERM and SIGHUP — but `process.exit` and an uncaught exception or
  rejection skip every `finally`. The first is the run logger's own answer to Machinery's *Stop*
  (B01-8a, #189): it closes the row and calls `process.exit(130)` from inside the stage, so every
  stage stopped from the console left its lock, and the campaign's next stage refused `lock.stale`
  until the operator removed it by hand. Reproduced in a real process (`tsx`, the real world, a
  temporary lock directory): `process.exit(130)` and an uncaught throw each left the lock; SIGTERM
  didn't. Fixed: the release also runs on the process's `exit` event (`releaseOnExit`,
  `campaignLock.ts`), and `campaignLock.test.ts` runs eight endings in a real process — returns,
  throws, `process.exit`, uncaught, unhandled rejection, SIGTERM, SIGINT, SIGHUP — none leaving a
  lock. `kill -9` and a power loss still leave one, refused as stale.
- **The governor's ruling: one lock directory for the machine.** The lock sat in each checkout's
  scratch, so two worktrees took "the" lock of one campaign at once (reproduced). It is now
  `${XDG_CACHE_HOME:-$HOME/.cache}/skating-aerial/locks/<campaign>.lock`, created on demand
  (`lockDir`; `AERIAL_LOCK_DIR` overrides it — every test points it at a temporary directory, never
  home); the holder records its checkout's scratch, so `lock.held` names the checkout and
  `lock.stale` names the full lock path and the holder's own log. The recording world gives each
  test its own lock directory and holds it byte-identical with the bucket and the scratch.
- **Fly unlisted read as a verdict.** `tiles.flyUnlisted` and `assemble.flyUnlisted` were, before
  the restructuring, a failed `spawn.sh` listing (`failed: … exited 1`, retry); as refusals they said
  only that nothing was started. The message now says to run the stage again once `fly machine
  list` answers.
- **Doc drift fixed** (§2.6): the select row no longer beats per state (its counts come with its
  close; Machinery has no `RUN_QUIET_MS` entry for an aerial kind, so a silent row is never called
  late or stalled — nothing misreads it), and the assembler's row beats only once it has decided
  (index reads, overviews and layout are behind it; its counts for those arrive with the record).

Checked and sound: every stage's happy path against `ef1d0470f` (arguments, variables read, writes
and their order, exit codes, `run-aerial.sh`'s stage loop — nothing greps a message); each late
guard (`spawn.sh tiles`' live-assembler check before any `fly machine run`; the record that lands
held to the build manifest again; the Machine's own key checks at step 0 and before the first byte);
the fake world against the real one (`rclone cat` of a missing key exits 0 with nothing; a done-record
copy and an `lsjson` of a missing prefix are empty — read from R2 here; a missing config throws;
`spawn.sh status` on an app with no aerial Machine prints nothing and exits 0, read from Fly here);
cleanup's order — no partly cleaned campaign is ever the newest archive or a base `--from-current`
can take wrongly (its published manifest goes before its archive, and a base is read by that
manifest); `spawn.sh status` is read-only and its bash guard intact. Mutations, each caught: the
tiles upload, the select manifest, the cleanup prefix delete each moved above its refusal; the
assemble landed check and the tiles live-assembler check each removed; a catalog id and a case
each deleted (`check-types`). One weakness, not changed: the property test's 300 random worlds over
thirteen facts reach the dangerous combination (a live assembler, a changed selection, every
cheap fact passing) about once in 500, so the case tests are what hold it. The real-tool tests
(`cutAerialServed`, `aerialCounts`, GDAL 3.13.2) and the stream proof (1.8 GB through real `rclone
rcat`, 15 parts, `pmtiles verify` clean) pass on this branch.

**The PR's ninth review (2026-11-28).** Greptile (3/5) on `a51faa299`, four comments. All four real;
each reproduced by a test that failed first, then fixed. Nothing drawn changed; tiling stays 2.

- **Assembly overlapped running re-cuts** (`preflight.ts`). Cut selection A, start re-cutting B,
  lose the laptop with B's Machines up, put A back: a worker drops its done record only at the end
  of its cut, so A's records stood; the tiles stage's first reconcile found every work tile landed
  and succeeded without waiting (it waited for live work tiles only when it spawned), and the
  assemble preflight ignored `live.workTiles` — an assembler started then would take A's records
  and range-read B's packs at A's offsets. Reproduced in `operatorSequences.test.ts` (tiles returned
  0 with B's Machines up). Fixed in three places: assemble refuses while any of the campaign's
  work-tile Machines is up (`assemble.workTilesRunning`; can't list is still `assemble.flyUnlisted`);
  the tiles stage waits before **every** reconcile until none is (`spawn.sh drain`, read-only, and
  `runTileRounds`' `settle`), so the first and last reconciles read the records that stay against
  the current manifest's hashes, and a wait that gives up fails the stage; and the assembler, which
  can't see Fly, re-reads every cut work tile's done record after its last pack read and before its
  upload completes — a changed one abandons the upload (`ByteSink.abort`) and refuses
  (`assemble.shardReplaced`). The residual window, §2.8: none for the archive's bytes, resting on
  R2's read-after-write consistency and the worker's drop-first order. Tests: the two operator
  sequences; `assemble.workTilesRunning` and `assemble.shardReplaced` cases (the latter re-cuts a
  work tile on disk mid-stream; the bucket ends with no published key; a mutation that drops the
  re-read fails it); `runTileRounds`' order (`settle` before each read); `spawn.sh drain`'s own
  (which Machines count, the give-up, a failing listing read as "still up"); the property test now
  draws live workers.
- **A pilot rebuild cut the region** (`selectManifest.ts`). `--from-current` on a pilot took every
  work tile any cell touches and found no saved hash outside the pilot's area, so it marked them all
  `retile` — with `--cells` repeated too; and the `published.otherInputs` advice for a pilot was that
  very command. Reproduced in `selectManifest.test.ts`. Fixed the smallest sound way: a pilot is
  never a base (`select.fromCurrentPilot`: a changed pilot is a new pilot from nothing); the advice
  (`newCampaignAdvice`, used by `published.otherInputs` and verify) and `tiles.assembling`'s message
  say `--from-current` only for production; and the outcome is guarded whatever its cause — a pilot
  with no `--cells`/`--states` is refused before the walk, one whose plan would cut every work tile
  its cells touch at select (`select.pilotUnbounded`), and a pilot manifest built on a build (a
  scratch from before this fix, a hand edit) at tiles before any write (`tiles.pilotBased`).
- **Concurrent decodes lost scores** (`score.ts`). Every decode wrote `<jpeg>.ppm` beside the shared
  thumbnail, and a failure was a bare `return null`: two campaigns decoding one frame removed each
  other's output, and the loser read as unscored — not unreadable — so a select could cut a pick as
  partial and a foliage review omit a strike. Reproduced with two concurrent `scoreFrames` over one
  thumbnail (one came back null). Fixed: a private `fs.mkdtemp` directory per decode; a failure is
  unscored for good only when the decoder read the image and refused it (`UndecodableImage`: GDAL's
  own exit naming the file, its words checked against GDAL 3.13.2 here) or its output doesn't parse —
  anything else (not installed, killed, a disk error, its output gone) is unreadable, for a re-run;
  and every file two campaigns share is written whole (`atomicFile.ts`). **The sweep for the class**
  — every path a stage writes that isn't keyed by campaign: `.scratch/thumbs/<item>.jpg` (select,
  foliage: now atomic), the decode's output (now private), `.scratch/scores.json` (select, foliage)
  and `.scratch/foliage-scores.json` (foliage: atomic, and merged with what another campaign saved
  since they were read, which was dropped), the lock directory (`O_EXCL` per campaign, created with
  `recursive`: sound), and the done-record copies (`mkdtemp`: sound). Keyed by campaign and under
  its lock: the kept walk (now written atomically too, so a crash leaves no torn state file), the
  units and round lists, the scratch manifest, the report, and `run-<campaign>.log` (append-only).
  Off the laptop: the Machines' own disks.
- **The runbook deleted what later steps read** (`README.md`). It said to delete the build prefix
  once verify passed — the build manifest and the assembly record a re-run of assemble, verify and
  tiles read, and the shards verify spot-compares. Now: keep it until a later campaign's cleanup
  removes it with the old archive, as `cleanup.ts` always said (§2.5 corrected too). **The walk of
  every operator instruction**, command by command against the code (the README, §2.4–§2.5, §2.8,
  §7.4, §7.6's H1–H5, §10.7, the roadmap's after-merge list, every refusal that instructs): the
  `publishedNoRecord` recovery now names exactly the three published keys and says it applies only
  while nothing has served them (the governor's ruling), its loop uses `${R2_REMOTE:-r2}` rather than
  a fixed remote, and the build prefix stays; H5's `rclone backend cleanup … -o max-age=1h` aborts
  every upload older than an hour, a running assembly's included, so it now says to run it only
  while no assembler is up; the pilot advice above; the Machine's `assemble.noManifest` said "run
  the select stage" where the laptop's says "run the tiles stage" (the tiles stage uploads it); and
  the full run's steps (README step 3, the roadmap's) now say the image is rebuilt from main first.
  Every other command, flag, variable and key path was found to exist and do what it says —
  `fly deploy`'s flags and rclone's `list-multipart-uploads`/`cleanup` read from their own help
  here. Pinned by `readme.test.ts`: each `run-aerial.sh` command the README gives parses; a pilot
  command names its area; every `--flag` it names is placed with its tool (a stage's parses, a
  script's is in its usage); every variable it names is read by the package, is a core constant, or
  is named as another tool's; the by-hand keys are the key helpers' own; the lock path is
  `lockDir`'s; and the `publishedNoRecord` refusal carries the README's words.

Open, for the governor:

- **How big a pilot may be.** As built, a pilot must name an area and may not cut every work tile
  its cells touch — but `--states NY` (about a third of the region, ~550 work tiles, ~$12) passes.
  Options: (a) as built; (b) cap a pilot's cut (say 100 work tiles; the pilot was 28); (c) a pilot
  takes `--cells` only. Recommendation: (c) — the only pilot the plan runs is by `--cells`, and a
  state is no pilot — a three-line refusal at the argument check. **Ruled (c) by the governor**;
  applied in the independent pass below.

**The independent pass over the ninth review's fixes (2026-11-28)**, before Greptile's tenth: each
of the four fixes read against `a51faa299`, its siblings looked for, every finding reproduced by a
test that failed first. Nothing drawn changed; tiling stays 2.

- **A failed or stopped assembly completed its upload with the bytes so far** (`writer.ts`,
  `upload.ts`, `cli/assemble.ts`). The ninth review's `ByteSink.abort` was used only when the
  re-read refused; every other failure mid-stream — a read that failed past its retries, the byte
  count, the watchdog's `process.exit` after twenty quiet minutes, an operator's `fly machine stop`,
  a crash — left `rclone rcat`'s stdin open, and the process's exit closed it: **rcat completes its
  upload on the end of its input**. Measured here with rclone 1.74.4 against `rclone serve s3`
  (300 MB, three 128 MiB parts): a parent that exited without ending left a completed 300 MB object
  at the key; `abort` (SIGKILL before the end) left no object and one unfinished multipart upload.
  On a Machine the completion races the VM's teardown, but locally and in any case where rclone wins
  it published a truncated archive at a key the pipeline never overwrites (`assemble.orphans` next
  run, a hand delete). Fixed: `writeArchive` abandons the sink on any failure before the end (the
  byte count is now checked before it, not after); `rcatSink` SIGKILLs its rclone on the process's
  `exit` (an ended upload is complete already); and the Machine turns SIGINT/SIGTERM into an exit so
  a stop runs that too. Tests: `writer.test.ts` (a failed read, a wrong count and a refusal at the
  end each abandon and never end; a write that got through ends) and `upload.test.ts` (a stand-in
  `rclone` that lands its object only on the end of its input: an ended upload lands; a parent that
  exits, throws or is stopped mid-stream lands nothing — both fail on the commit before). The scratch
  proof after the fix: exit, uncaught throw and SIGTERM each left no object; `end` landed it whole.
  What it doesn't show: R2's own handling of an unfinished multipart upload (H5's lifecycle rule).
- **A kept thumbnail torn by an earlier writer was unscored for good** (`score.ts`). The ninth
  review's classification calls a decode GDAL refuses the image's own, and GDAL refuses a JPEG cut
  short (`ERROR 1: libjpeg: Premature end of JPEG file`, exit 1) or an empty one (`not recognized as
  being in a supported file format`) exactly as a bad image — read here from GDAL 3.13.2, which
  doesn't localize its messages (the same words under `LANG=de_DE`). A thumbnail an earlier writer
  left torn — before thumbnails were written whole, or a crash mid-write — was kept, so it failed the
  same way every run: a silent permanent null (a pick cut as partial, a turned frame missing from the
  foliage review). Fixed: a kept thumbnail the decoder refuses (or whose output doesn't parse) is
  dropped and the frame is unreadable, so a re-run reads it afresh; only a fresh read refused is the
  image's own — and a refused image is never kept (the first cut of this fix kept it, so the next run
  read it as torn: a pick unreadable every other run, caught by its own test's fourth run). Text GDAL
  might word otherwise (another version) reads as unreadable, never as a permanent null — the safe
  side. Test: `score.test.ts` (a torn and a garbled kept thumbnail are dropped and unreadable; the
  re-run fetches and scores both; a fresh read refused is unscored, not unreadable, on every run).
- **The tiles stage's wait was silent** (`spawn.sh drain`). Before the first reconcile it can wait
  up to ~90 minutes (`DRAIN_TRIES` × `POLL_SECONDS`) on an earlier selection's workers with nothing
  on the terminal, and its give-up line counted a failing listing as 25 Machines "still alive".
  Fixed: it says how many of the campaign's work-tile Machines are up and how long it will wait at
  most (or that the listing can't be read yet), and the give-up line says a failing listing counts
  as the cap. Tests: `tilesScripts.test.ts` (the line, and a first run — `fly machine list --json`
  answering `[]`, as it does today on `skating-imagery` — passing through silently).
- **A pilot takes `--cells` only** (the governor's ruling, above): `--states` on any stage of a
  pilot is `args.pilotStates`, and a pilot's select — alone or in `all` — without `--cells` is
  `args.pilotNoCells`, both refused by `parseStageArgs` before anything is read (zero-write cases in
  `refusals.test.ts`); a pilot's later stages take no `--cells`. The select stage's pre-walk check,
  now unreachable, is gone; `select.pilotUnbounded` stays for a `--cells` file reaching every work
  tile. The operator sequences and the refusal cases now give pilots a `--cells` file over the
  fixture (`stageHarness.ts`' `fixtureCellsFile`: one state's picked cells, what `--states` reached).
  The README's pilot command, `--cells scripts/aerial/pilots/champlain-nhma-me-ny.txt` (65 cells),
  parses and reads.

Found sound, against the code: `spawn.sh drain` is read-only (it lists, never starts or stops),
bounded (~90 min, then exit 3, and the stage fails rather than succeeding), counts only
`aerial-<stamp>-*` (not the assembler `aerial-asm-<stamp>`, another campaign's stamp — a pilot's is
`p<date>` — or the winter pump's `granule-*`), and reads a listing that keeps failing as "still up";
the bash-4 guard precedes it. The Machine's re-read: every cut work tile's record, after the last
pack byte and before the archive's upload ends; copied tiles are read from the base's published
archive, whose keys never change, so they need none; each read rides `httpStore`'s retries (a
failure past them fails the assembly, its upload abandoned — not a refusal, and not a publish); it
feeds the watchdog and should take seconds at the region's 1,764 work tiles (an estimate: 16 GETs in
flight), inside the five-minute beat; the index, manifest and record are written only after it. Read
through `rclone serve http`'s directory cache (five minutes by default), a record replaced in the
last minutes can make the re-read fail rather than refuse — the safe side; it can never read the old
bytes, since every read is a GET of the key. `atomicFile.ts` writes beside its target (one
filesystem); a `.part` left by a crash is never read (every reader opens a named file: the
thumbnails by item id, the caches and the walk by name, the snapshot upload by state). The score
caches merge another campaign's new entries and no code deletes one, so nothing is resurrected; two
saves at once are last-writer-wins on the merged map, which can drop a memo but never a score's
truth (a dropped one is scored again). `readme.test.ts` reads only its own package's files (the
README, `spawn.sh`, `cut-aerial.sh`, the pilot list), which Turbo hashes. Mutations: a scratch write
moved above `tiles.pilotBased`'s preflight and a Machine started above `assemble.workTilesRunning`'s
each failed its case; so did removing either `args.pilot*` check, the writer's abandon, the exit
kill, and the kept-thumbnail drop.

Residual, not fixed (small, recorded): two pilots of one campaign date share Machine names
(`aerial-p<date>-*`, `aerial-asm-p<date>`), so one's live assembler reads as the other's — a tiles
stage refuses or a laptop follows the wrong Machine and then finds no record; nothing is
overwritten, and the plan runs one pilot. And a `--from-current` campaign based on an *older*
archive than the newest could have that archive deleted by cleanup under its assembler — the read
fails and nothing is published.
