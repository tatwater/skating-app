# HANDOFF — N6c data campaign, what's left

> **Temporary working doc, written 2026-08-03.** Companion to
> [`HANDOFF-wind-climate-archive.md`](./HANDOFF-wind-climate-archive.md), which covers the wind pass
> specifically. Delete both once the campaign lands and the findings are folded into
> `plans/phase-N6c-expanded-lake-profiles.md` and `plans/phase-N6a-lake-depth.md`.
>
> Campaign id: **`n6c-20260802`**. Every run is on `/admin/imports` (admin-only) — that page is the
> source of truth, not this doc.
>
> Branch: **`phase-n6c-2-rebuild`**, **68 uncommitted files** at time of writing.

---

## Read this first: two things that will bite

**1. Nothing of mine is deployed.** `packages/convex/convex/waterBodies.ts` has uncommitted changes
to `listNeedingElevation` and `listNeedingWindRose` (see §Fixed below). **They do not take effect
until `pnpm convex-dev --once` runs.** I deliberately held the deploy because a redeploy swaps
functions out from under a running loader, and the area-floor prune was in flight.

**2. Do not run `convex dev --once` while any loader or prune is running.** Same reason. The dev
deployment is a single shared resource; a redeploy mid-pass is the one way to break an otherwise
resumable run.

---

## State of each pass

| # | pass | state | evidence |
| --- | --- | --- | --- |
| 1 | canonical water re-import | ✅ **done** | 7,882 inserted · 116,515 updated across VT/NH/ME/MA/NY, zero failed batches |
| 2 | depth join | ✅ **done** | `8,517 / 40,260 source lakes` — see the caveat below |
| 3 | bathymetry coverage | ✅ **done** | `2,022 / 2,022 contoured bodies` |
| 4 | **elevation** | ⏸ **partial — resume this first** | 5,975 stamped, page 86 of ~248, stopped on daily quota |
| 5 | **wind roses** | ⏸ **stopped at ~2%, deliberately** | needs the archive rebuild — see the other handoff |
| 6 | `regionStats:recompute` | ⛔ **blocked on #4** | deciles are computed *from* elevation |
| 7 | `backfillRepresentativePoint` + rename stage 2 | ⬜ **not started** | see §7 below |
| 8 | `backfillCells` (the D2 re-score) | ⛔ **held until after N6d** | founder call, 2026-08-02 |

### Caveat on the depth number

`8,517 / 40,260` looks like a 21% match rate and is **not**. The denominator includes ~12,900 LAGOS
rows outside our five states and a HydroLAKES bbox covering Ontario, Québec, PA, NJ, CT and RI.
Corpus-side coverage is the real figure: **~60% of bodies that draw at z ≤ 10**, 74% of bodies over
100 ha, 0% under 1 ha (below every source's floor, by design).

Two known improvements are **built and tested but were never re-run** — a re-run would pick them up:

- `--states=VT,NH,ME,MA,NY` on the transform (honest denominator, ~⅓ faster)
- `Shore_len` added to the `ogr2ogr -select` — **D85's shoreline cross-check has still never
  executed**; the run reported `0 comparable`, which reads exactly like "we agreed everywhere"
- the corroborated proximity fallback (`matchDepthSource`), which recovers the ~40% of prominent
  bodies lost to source points landing just outside our polygons

---

## The order to do things in

```
1. (wait for the area-floor prune to finish)
2. pnpm convex-dev --once                    # deploys the meetsAreaFloor fix
3. resume elevation                          # quota permitting — see below
4. convex run regionStats:recompute          # ONLY after elevation is complete
5. wind roses                                # after the archive rebuild lands
6. backfillRepresentativePoint + rename stage 2
7. backfillCells                             # LAST, and only after N6d
```

### 3. Resume elevation

```bash
pnpm --filter @skating/lake-depth load-elevation --import-floor --campaign=n6c-20260802
```

Resumable by construction — already-stamped rows are skipped server-side, so it continues from ~page
86 with no flags or bookkeeping. **The blocker is Open-Meteo's daily quota**, which reset overnight.

⚠️ **Open-Meteo counts each COORDINATE, not each request.** Batching at 100 saves HTTP overhead and
no quota at all. The free tier is ~10,000/day and ~5,000/hour, so expect the pass to spend most of
its wall clock asleep in backoff. That backoff now honours `Retry-After` and gives a 429 eight
retries at 30 s → 240 s; it survives an hourly window and exits cleanly on a daily one.

⚠️ **The app shares that quota.** `weather.ts` fetches forecasts from `api.open-meteo.com` on crons.
A corpus pass competes with the product for one free-tier allowance.

**After the prune, re-measure how much is actually left** before assuming ~11,000 remain — the prune
removes most of the corpus, and `--import-floor` was already skipping those.

### 4. `regionStats:recompute`

```bash
pnpm --filter @skating/convex exec convex run regionStats:recompute '{"campaignId":"n6c-20260802"}'
```

**Must not run before elevation completes.** Its own docstring: *"Running it early is not harmful,
just wrong: it would describe the corpus as it was."* Same applies to running it mid-prune.

### 7. `backfillRepresentativePoint` + the `centroid` rename

Never started. Two steps:

```bash
pnpm --filter @skating/convex exec convex run waterBodies:backfillRepresentativePoint '{}'
```

Needed for **`waterBodySubAreas` and `adminAreas`** — the water re-import already covered
`waterBodies` itself. Once it's clean, **stage 2 of the `centroid` → `representativePoint` rename**
can land: ~100 read sites, make the field required, drop `centroid`.

⚠️ **Never make it a true centroid.** `centroid` is Turf `pointOnFeature` and lands *on the
shoreline* for any curved lake — Willoughby's is ring vertex 199, Champlain's sits 30.7 km off.
Drive-time bands and the pin-less report's town stamp deliberately want a shoreline-ish point;
`interiorPoint` exists separately for weather sampling.

---

## Fixed but not deployed

`listNeedingElevation` and `listNeedingWindRose` now **import `meetsAreaFloor`** from
`@skating/core` (`osm.ts`) instead of restating it, and take a boolean `--import-floor` rather than
`--min-area-acres=N`.

**Why it matters:** I hand-copied the rule as `named OR >= 5 acres`. It was settled the next day as
`>= 5 acres OR (named AND >= 1 acre)` — stricter — so the copy silently became *more permissive* than
the import it mirrored, and would have spent Open-Meteo and NREL quota on sub-one-acre named bodies
that `pruneBelowAreaFloor` deletes. A parameter invites a caller to invent a floor; a predicate
cannot drift. **Don't reintroduce a threshold argument here.**

---

## Three orphaned `running` rows on /admin/imports

Visible now, and they are **artifacts of me stopping processes**, not incidents:

| kind | when | why |
| --- | --- | --- |
| `wind_climate` | 08-03 03:05 | killed deliberately at ~2% for the archive rebuild |
| `elevation` | 08-03 02:18 | killed to add the `--import-floor` filter |
| `r2_mirror` (osm-extracts) | 08-02 18:49 | the push succeeded; its `finish` call hit the `v.optional` vs explicit-`null` bug, since fixed |

This is the design working as intended — a row is opened *before* the work so a killed process leaves
a record rather than nothing. The UI says *"no finish recorded"* rather than *"in progress"* because
it genuinely cannot tell a live loader from a dead one. **No delete path exists**; if these become
noise, that's a small feature to add rather than a bug to chase.

---

## Gotchas worth not re-learning

- **Convex caps a transaction at 16 MB of reads**, not just 4,096 reads. The depth loader's batch of
  25 was reasoned against the read cap and blew the byte cap at batch 8 of 1,611 — a body averages
  1.8 KB but the N1 cell index files large bodies at coarse rungs, so a lookup near Champlain drags a
  ~300 KB polygon in. Now 8, `--batch=N` tunable. **8 is marginal, not conservative** — five batches
  warned at up to 16.2 MB of 16.8. **Use `--batch=4` for a first run against prod.**
- **Estimate wall clock from a measured sample, never from the pacing delay.** The wind loader's
  "~96 min at 1/s" was off ~5× because WTK takes 5.3 s per request, not 1 s.
- **Every loader continues past an isolated batch failure and aborts on a streak** (5 consecutive;
  10 for wind cells). Skipped items are itemized **by key** on the run row, so a targeted
  `--batch=1` retry is cheap. The depth loader used to rethrow on the first failure and took 1,603
  loadable batches down with it.
- **Denominators lie by default.** Three separate places this session reported a rate against
  everything scanned rather than everything *eligible*. If a pass filters, report `covered/inScope`
  and name what it walked past.
- **`biome check --write --unsafe` mid-edit renamed my new counters** to `_`-prefixed as "unused",
  which silently made a later edit not match. Don't run it on a file you're part-way through.
- **Prefer `Edit` against read content over scripted string-replace.** Two bugs this session came
  from a `python` replace not matching and failing silently — including a filter parameter that was
  computed and then never sent, which produced a plausible-looking wrong result.

---

## Before forking another thread

**68 uncommitted files on `phase-n6c-2-rebuild`**, spanning two threads' work. Committing first turns
any conflict into a normal merge instead of a mystery, and gives every thread a known-good point.
Worth doing before the wind rebuild starts.
