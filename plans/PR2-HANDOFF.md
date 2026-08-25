# PR 2 handoff — changes to make before the nine-season backfill

Written 2026-08-24 from the PR 3 worktree (`phase-n6e-pr3-consumer`), after a founder review of the
freeze-up archive's cloud handling. **Everything here is producer-side and belongs on the PR 2
branch.** The PR 3 consumer work is proceeding in parallel and will pull these in.

Founder framing, verbatim, because it sets the budget for every decision below:

> *"Let's always cut & store all imagery regardless of cloud cover? Then we know we have everything
> from Copernicus and we can rerun whatever we want on it without hitting them again. […] a $40
> one-time expense to get everything for all 9 seasons is an acceptable cost for me. What I wouldn't
> want to have to do is run that several times and end up with a bill pushing $100. So let's make sure
> we think this through and test our hypotheses before doing the whole set."*

---

## 0. ⚠ Do this first: the cost estimate does not reconcile, and it is the whole risk

**The plan's arithmetic and the observed run disagree by an order of magnitude, and nobody has
noticed because the two numbers live in different documents.**

- `plans/phase-N6e-satellite-imagery.md` §C5: *"backfill ≈ 8,000 granule jobs ≈ **$43** on Fly."*
- The same doc's Sequencing section: the cloud gate takes nine seasons from *"~6,750 jobs […] closer
  to **1,000**."*
- **Observed:** one season, gated at 60%, cost **~$6**.

If the gate really cuts nine seasons to ~1,000 jobs, one gated season is ~110 jobs, so the observed
run implies **~$0.055/job**. Ungating and extrapolating to 8,000 jobs gives **~$440** — not $43, and
well past the founder's $100 ceiling.

One of those figures is wrong. **Find out which before spending anything on nine seasons.** Candidate
explanations, all checkable from data the completed run already produced:

1. **The $6 includes one-off overhead that does not recur per season** — image builds, failed
   experiments during bring-up, the mask bake. Separate per-job cost from setup cost.
2. **The gated season ran far more than 110 jobs.** The "~1,000 over nine seasons" figure came from a
   *Champlain-only* STAC measurement extrapolated across the region. It may not hold — and if the real
   gated job count is much higher, the $43 estimate is the wrong one rather than the $6.
3. **`shared-cpu-4x` / 8 GB is oversized.** `fly.toml:50-51`, and `README.md:391` already says so:
   *"a guess, not a measurement."* The job is ~83% I/O-bound (9s reading + 6s uploading of 18s), so
   dropping to `1x` or `2x` should cut per-second cost materially while barely moving wall time.

**Required before the nine-season run:**

- Reconcile the numbers from the finished run: real job count (`selectGranules` already reports
  `counts.considered` vs `counts.selected` — the ratio *is* the ungating multiplier), real wall time
  per job, real Fly billing for the window.
- **Then run one season ungated as a metered pilot** and measure it. That is the founder's *"test our
  hypotheses before doing the whole set,"* and it is the only honest input to the nine-season decision.
- Right-size the VM against that pilot before scaling out.
- Write the measured per-job cost into the README so the next person does not re-derive it.

**Storage is not the concern.** Ungated is ~13 GB across nine seasons (~$0.20/mo in R2) — the §C5
figure already assumed the ungated job count. Egress is free. The meter that matters is machine-seconds.

---

## 1. Selection: cut and store everything

**Founder call — remove the cloud gate.** The point is to hit Copernicus once and own the pixels, so
any re-derivation later is free.

In `scripts/imagery/src/granuleSelection.ts`:

- Neutralise the cloud filter by default. Keep `maxCloudPct` as an *option* so it stays available; just
  stop defaulting it to 60. Update `DEFAULT_MAX_CLOUD_PCT` and the module's opening doc comment, which
  currently argues at length for a gate we are deliberately abandoning — leave the reasoning in place
  as history, but say plainly that the founder overrode it and why.
- **⚠ Do NOT touch the `superseded` or `unparseable` filters.** Those are correctness, not cost. The
  superseded-reprocessing dedup is what stops two different pictures of 15 February landing in the
  scrubber, which C4 makes a correctness bug rather than a rendering one. The module doc explains this
  well; do not let a "remove the filtering" change take it out along with the cloud gate.
- Keep the `rejected` / `counts` reporting exactly as-is. It is what makes the ungating multiplier
  measurable for §0.

---

## 2. Extract SCL alongside `visual`

`cut-granule.sh:112-118` already documents `scl` as *"the single most valuable asset here"* and
`asset_href()` is generic — but line 208 only ever resolves `visual`, so SCL is a comment, not a fetch.

- Pull `scl` in the same job, while the granule is already open.
- **⚠ SCL is 20 m native, `visual` is 10 m.** It must be resampled onto the same grid the mask and
  alpha are burned against, or the zonal stats in §3 silently misalign. Use nearest-neighbour, never
  bilinear — SCL values are *class labels*, and interpolating between class 8 and class 10 produces
  class 9, which is a different category entirely.
- Ship it as its own frame with `band: 'scl'`. The index already carries `band` per frame and PR 3's
  reducer already filters on it, so this needs no contract change.

---

## 3. Per-body clear fraction, computed at cut time — **the highest-value change here**

Right now `cut-granule.sh:172` computes `MASK_COUNT` with `ogrinfo -so` — a feature *count* — and the
manifest records `bodies: 12`. Which twelve is never written down.

**Replace the count with a list carrying a per-body clear fraction:**

```
bodies: [{ waterBodyId, clearPct }, …]
```

**One change, two problems solved:**

- **Per-lake cloud.** A granule 70% clouded over the White Mountains may be perfectly clear over
  Champlain. `granuleSelection.ts:23-26` already names this as the better gate and defers it; with SCL
  on the grid it is a zonal stat over shapes the cutter is already holding.
- **Exact frame membership.** PR 3 cannot build a per-body timeline without knowing which frames
  contain the body. This gives it exactly, with no geometry inference.

The ids are already available — the reveal FlatGeobuf carries `waterBodyId` per feature
(`revealMasks.ts:93-96`), so this is swapping an aggregate for a per-feature dump.

**On the founder's bbox suggestion** — *"use rough bbox math for each body polygon to determine a
max-cloud-percent on a particular body and use that to decide whether to make the real mask"*: that is
the right instinct and both halves have a place. Use cheap bbox math as a **pre-filter to skip work**,
and the SCL zonal stat for **the number that ships in the manifest**. With SCL already resampled onto
the grid, the exact statistic is barely more expensive than the approximation, and it is the one a
skater's scrubber will be gated on.

**⚠ Size constraint — do not fold this into the season index.** ~1,000 frames × ~1,000 bodies per
granule is a million entries in one JSON file. Keep the per-body list in the **per-granule manifest**;
PR 3 fetches manifests lazily for only the handful of frames covering the lake on screen.

---

## 4. Carry the granule footprint into the index

So the season index can filter frames per body *without* fetching every manifest.

- STAC items carry `geometry`. `selectGranules.ts` currently keeps only the *search* bbox (our region)
  and discards the item's own footprint.
- Thread it: STAC item → manifest → `IndexedFrame.footprint`.
- **The field already exists.** I added `footprint?: Polygon | MultiPolygon` to
  `packages/core/src/imageryArchive.ts` on the PR 3 branch, optional so nothing breaks. Match that
  shape.
- **⚠ A polygon, not a bbox.** MGRS tiles are squares in UTM, so in lat/lng they sit rotated. A
  bounding box claims a band of ground along each edge the granule does not cover, and a body in that
  band gets offered a date that renders blank.

---

## 5. Sentinel-1 SAR — settle it now, not later

**Current state:** not merely unbuilt. `granuleSelection.ts:44` matches `^(S2[A-D])_…`, so a Sentinel-1
id is **rejected as `unparseable`**. SAR is absent from the producer end to end.

**⚠ This is the strongest reason to decide before the big run.** The entire justification for ungating
is *"then we know we have everything from Copernicus and we can rerun whatever we want on it without
hitting them again."* Sentinel-1 is Copernicus. Backfilling nine seasons of S2 without S1 means a
second nine-season backfill later — which is precisely the repeated-spend the founder ruled out.

It is real work, not a flag: separate STAC collection, separate id grammar, and a different transform
(VV is single-band — there is no RGB composite to build, so steps 5–6 of `transform_granule` need a
parallel path).

**Either wire it into this backfill or write down explicitly that it is deferred** — and if deferred,
note the `unparseable` rejection behaviour in the module doc so a future reader does not file it as a
bug. Flag the cost delta to the founder either way; this is a budget decision, not an engineering one.

---

## 6. The N6f label is already spent — this needs a founder decision

The founder noticed `plans/` jumps from `N6e` to `N6g`. The diagnosis is sharper than a missing file:

**N6f already shipped.** "No public access" — built and deployed to dev 2026-08-16, PR #44
(`phase-n6e-n6f-access-and-qol`). It added `waterBodies.publicAccess` as a third map state, the first
zoom *penalty* in `display.ts`, and the corroboration-via-`contentFlags` mechanism. `UnreportedSkates`
in the You tab is from the same lane (`plans/phase-N7b-corpus-by-request.md:114-119` credits "N6f" with
removing its blocker). It is real, merged code.

**But three places defer *future* ice-classification work to "N6f"** — a label that phase already holds:

- `plans/01-decisions.md:4688` — D150's title: *"(N6e → N6f)"*
- `plans/07-roadmap.md:1349` — *"Ice classification […] deferred to N6f"*
- `plans/phase-N6e-satellite-imagery.md` — several §C1/§C5 references

**So there are two defects, not one:**

1. **A label collision.** The ice-classification phase needs a free number. `N6g` is taken
   (`phase-N6g-imagery-research.md`), so **`N6h`** is the obvious candidate — founder's call.
2. **The shipped N6f has no plan document**, which is the other half of why the directory skips a
   letter. Worth a short retrospective doc so the phase is not invisible to anyone reading `plans/`.

Fix the references in all three files once the founder picks the new label.

---

## 7. Contract note for PR 3: a split body shows a seam, not one frame

**Founder call:** where a single body is split across two frames from different dates, render **both**,
with a hairline border and each frame's date on its own side.

That is client-side work I will handle in PR 3, but it constrains the producer:

- **Do not assume one frame per body per date.** The per-body membership list in §3 is what makes the
  seam possible — a granule footprint alone cannot tell you a body is split, only that it is partially
  covered.
- It also supersedes a limitation I had documented in `packages/core/src/imageryTimeline.ts`: I
  currently test coverage at the body's interior point, which calls a half-covering pass "not covered."
  Once §3 lands, that becomes exact and the seam becomes renderable. I will update the reducer.

---

## Suggested order

1. **§0 cost reconciliation** — blocks everything downstream and is pure analysis, no spend.
2. **§6 N6f** — documentation only, no code, unblocks nothing but is cheap and easy to lose.
3. **§1 ungate** + **§2 SCL** + **§3 per-body stats** + **§4 footprint** — one coherent producer change;
   they touch the same two files and share a test surface.
4. **§5 SAR decision** — founder input needed on budget.
5. **Metered single-season pilot, ungated**, measured against §0.
6. Nine seasons, only once the pilot's numbers are in.
