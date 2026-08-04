# HANDOFF — N7, where it stands and the classification proposal

> **Written 2026-08-04**, at the end of a long build thread. Companion to
> [`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md), which holds the decisions; this holds
> **state, the open proposal, and the things it would be expensive to re-learn**.
>
> Branch: **`phase-n7-unified-corpus`**, 23 commits, nothing pushed. Working tree clean at the last
> commit; full suite green (11 packages).
>
> Campaign id: **`n7-20260803`**. `/admin/imports` is the source of truth for what ran, not this doc.

---

## Read this first

**Convex data has been written.** Unlike the N6c handoff, this campaign is past the read-only stage:
the prune deleted 3,282 bodies and three backfills wrote to every remaining row. **The corpus is
18,383 bodies**, down from 21,665.

**Nothing is deployed to prod.** Everything is dev (`agile-bee-397`).

---

## Campaign state

| step | state | detail |
| --- | --- | --- |
| 0 · wipe the run ledger | ⬜ **never done** | the three orphaned `running` rows from N6c are still there |
| 1 · acquire NHD | ✅ | 924 MiB, 5 states → `skating-raw-nhd` |
| 1b · acquire 3DHP | ✅ | 409 MiB clip → `skating-raw-3dhp`; the 11.9 GB source was hashed and deleted per D102 |
| 2 · reconcile OSM ↔ NHD | ✅ | 12,081 `nhdId` written · 100 bodies flagged `near_certain` |
| 2b · reconcile ↔ 3DHP | ⬜ | **never run — see §The 3DHP lane** |
| 3 · D92 bake-off | ⬜ | |
| 4 · identity | ✅ | 18,383 `waterBodyKey` minted · `osmId` + `geometrySource` backfilled |
| 5 · unified re-import | ⬜ | **the gap-fill; the phase's original point. See §What step 5 actually needs** |
| 6 · prune | ✅ | 21,665 → 18,383 (moved early per D100) |
| 7 · D97 audit report | ⬜ | partially done ad hoc; `listForClassificationAudit` is its data source |
| 8 · admin areas | ⬜ | |
| 9 · depth + elevation | ⬜ | elevation should move to 3DEP/EPQS per D101 |
| 10 · bathymetry | ⬜ | |
| 11 · wind climate | ⬜ | archive rebuild is a hard prerequisite; mirror is stood up, `.raw/` is not |
| 12 · regionStats | ⬜ | **still zero rows** — this is a first computation, not a refresh |

**Corpus today:** 18,383 — `other` 10,033 · pond 3,756 · reservoir 2,393 · lake 1,376 · marsh 572 ·
bay 253. By state: NY 7,282 · ME 4,230 · MA 3,823 · NH 2,254 · VT 878.

---

## The open proposal: classification

`other` is **55% of the corpus** and the largest unknown in it. Measured 2026-08-04.

### What `other` actually means

Traced through `waterBodyTypeFromOsmTags` and counted against the Vermont extract:

| why a feature lands in `other` | count | reading |
| --- | --- | --- |
| `natural=water` with **no** `water=*` subtag | **3,326 (81%)** | *not yet categorised* — OSM didn't say |
| `water=<value we don't map>` | 780 (19%) | *not in one of our classes* |

So it is overwhelmingly **"not yet categorised"**, which by the founder's stated criterion means the
wetland rules must **not** be applied to it wholesale.

### 1. Borrow NHD's own class — the biggest win, and free

**67% of `other` (6,756 of 10,033) carries an `nhdId` we can look up**, and NHD's own FTYPE says:

| | count |
| --- | --- |
| **390 LakePond** | **6,584** |
| 466 SwampMarsh | 127 |
| 436 Reservoir | 40 |
| 493 Estuary | 5 |

Authoritative rather than inferred, no new data, and it resolves two thirds of the corpus's biggest
unknown. **Do this first.**

The FTYPE→our-enum mapping is D96's parity question and is already reasoned about in the phase doc.

### 2. Name keywords — safe for two words, catastrophic for the rest

**Tested against NHD's own class over 8,604 named bodies rather than assumed:**

| keyword | n | agrees with NHD |
| --- | --- | --- |
| `lake` | 2,305 | **99.5%** ✅ |
| `pond` | 5,737 | **99.1%** ✅ |
| `reservoir` | 500 | **7.0%** ⛔ |
| `marsh` | 28 | 32.1% ⛔ |
| `swamp` | 15 | 46.7% ⛔ |
| `bog` | 19 | **0.0%** ⛔ |

**"Reservoir" is the trap.** Sugar Hill Reservoir, Gulf Brook Reservoir and Therman W. Dix Reservoir
are all NHD `LakePond` — a named reservoir is usually a lake that was dammed, and NHD classes it by
what it *is*. Shipping keyword classification without this test would have mis-typed ~465 bodies with
total confidence.

**Proposal:** keyword fallback for **`lake` and `pond` only**, only where no `nhdId` exists, and
**into a moderator queue as a suggestion** rather than applied silently (founder's framing: *"a mod
just says 'yep, that's what that is'"*). Never keyword-classify reservoir or wetland.

> ⚠️ **A finding this raises about our existing data.** Moose Bog, Great Swamp and McDaniels Marsh are
> all `LakePond` in NHD. That suggests **our own `marsh` class may be over-assigned**, which matters
> because D96 now deletes unnamed wetland under 50 acres. Worth checking before leaning harder on the
> class. Nothing has been deleted on a *name* basis — the prune used `type`, which comes from OSM's
> `wetland=marsh` tag — but if that tag is unreliable, some of the 3,282 may have been lakes.

### 3. Drop at the filter step

Values seen in the VT extract that reach `other` through `water=<value>`:

```
basin 358 · wastewater 268 · oxbow 122 · pool 10 · stream_pool 8
quarry_lake 2 · swamp 2 · waterfall 2 · fountain 2 · faucet 2 · high 2 · rapids 1
```

**Drop:** `wastewater`, `basin`, `waterfall`, `fountain`, `faucet`, `pool`, `stream_pool`.
`pool` in OSM is usually a swimming pool; `stream_pool` is a widening in a stream, i.e. flowing water
we already defer. **Keep:** `oxbow`, `quarry_lake`. **`swamp` follows the wetland rule** (named, or
≥ 50 acres).

Put this in the **main filter step**, beside the class and area filters, so nothing downstream ever
trips over a sewage lagoon. The corpus already contains `Rochester Sewage Lagoons`, `Lincoln Sewage
Lagoons`, `Lagoon 1`, `Lagoon 2` and `Lagoon 3`.

---

## The Meadow Lake class — solved, not yet built

The one plan fixture that did not reproduce. It is **not one body and not a manual fix**.

Same name + overlapping geometry + area ratio under the 0.30 skip floor, across the whole corpus:

| pair | small | large | small-inside-large |
| --- | --- | --- | --- |
| **meadow lake** | 5 ac | 24 ac | **0.999** |
| **washburn pond** | 2 ac | 8 ac | **1.000** |
| great east lake | 59 ac | 1,764 ac | 0.000 |
| melvin bay | 1 ac | 287 ac | 0.002 |
| higley flow | 24 ac | 349 ac | 0.000 |

**Two are real duplicates; three merely share a name — and containment separates them perfectly.**

**Why IoU cannot catch these, ever:** a 5× area disagreement is indistinguishable from a bay inside
its parent, which is precisely what `RECONCILE_MIN_IOU` exists to refuse. Containment is the
complementary test, not a tuning of the same one.

**Proposed rule:** *same name + smaller body ≥ 95% contained in the larger → duplicate → dedup
queue.* Catches 2/2, rejects 3/3. **Queue it, never auto-merge** — same principle as the 55 groups
already flagged.

---

## The 3DHP lane

**Never run.** `threeDhpId` is empty on every row, and there is no schema field for it yet.

3DHP was measured *against NHD* — 7,878 lakes across ME/VT/NY, **zero disagreements ≥ 0.1%** — so it
adds nothing as a geometry source today. But the founder's call stands and is right:

> *"We should do that before we re-import, no? Prove all the lanes & deduping work as intended, even
> though the work is duplicative (this year)?"*

Building a three-lane pipeline and only ever exercising two leaves the third untested until the year
it matters. **The reconciler is already source-agnostic** — `reconcileOne` takes candidates, not "NHD
candidates" — so the lane is cheap, and it re-validates the 3DHP≡NHD claim end-to-end rather than by
area comparison alone.

---

## What step 5 actually needs

**"A named NHD lake with no body" means no row in our `waterBodies` table** — never that the NHD
feature lacks geometry. Beau Lake is a complete 7.594 km² polygon sitting in the archive on disk; we
know its size and its Québec span *because* we have it. What is missing is our row, because
Geofabrik's OSM extract clips the border.

**The gap:** `importCanonical` and the schema already support `source: 'nhd'`, and `catalogueIds`
handles it — **but the transform only reads OSM.** There is no NHD → canonical lane. That is the
substance of step 5, and it is what finally delivers the phase's original motivation:

**~1,926 named NHD features in-region have no body.** (An earlier figure of 3,552 was wrong — it
counted the state geodatabases' bleed into NJ/PA/Québec/New Brunswick, which we would never import.)

---

## Things it would be expensive to re-learn

**Every identifier has more than one spelling, and every wrong rule fails silently.** Four found:
NHD `permanent_identifier` is a GUID *or* a plain numeric (84.4% numeric — a GUID-only rule would
have dropped five sixths of the join keys); GNIS is zero-padded in NHD and a bare int in 3DHP (joined
raw: **0 of 3,031** matched); NHD field names are lower-case in the geodatabase and upper-case from
REST; `ogr2ogr -spat` reads its envelope in the **source** SRS, so a degrees box against 3DHP's
Albers metres clips an empty file and exits 0. The mechanism against this is **`DropLedger` +
`expectAcceptance`** in `@skating/run-log`, and `pnpm --filter @skating/etl audit-archives`.

**NHD writes `gnis_id = -1` to mean "no GNIS entry"** — 1,032 rows, cross-border Québec lakes. Treated
as an id it would collapse **855 unrelated lakes onto one body**. It is in `GNIS_SENTINELS`.

**Do not extrapolate from a slice of the corpus.** Pagination is by creation order, which is import
order, which is **by state**. A 6,000-row sample put marsh at 12.1% where the first page has 20.6%,
and the first projection of the prune came out **40% low**. Scan the whole thing.

**A predicate and a deleter want opposite answers on missing data.** An import must refuse what it
cannot prove; a prune must keep it. Any rule needing a derived statistic carries that split — which
is why D96's long-axis clause was dropped in favour of a plain area bar.

**Convex limits that bit:** 16 MB read cap per function (not just 4,096 docs) — a full-corpus scan
needs paging; 64 MB memory — an 8,000-row `paginate` with polygons blows it; only **one** `paginate`
per function.

**rclone issues a `CreateBucket` before its first upload**, which R2 refuses for any Object Read &
Write token. Only bites an *empty* bucket. `--s3-no-check-bucket` is now in `scripts/lib/mirror-r2.sh`.

**Prefer `Edit` against read content over scripted string-replace.** Three separate misses this
thread: a doc section landed under the wrong heading, a runbook edit asserted and left the code
committed without it, and a `sed`-generated mirror script pointed at the wrong bucket's `.env`.

---

## Commands

```bash
pnpm --filter @skating/etl archive-nhd            # 5 state geodatabases → .raw-nhd/
pnpm --filter @skating/etl archive-3dhp           # CONUS → clip → .raw-3dhp/waterbody/
pnpm --filter @skating/etl measure-3dhp           # EDH coverage → /admin panel
pnpm --filter @skating/etl audit-archives         # re-derive every id rule, fail loudly on drift
pnpm --filter @skating/etl reconcile              # export + match + audit (read-only)
pnpm --filter @skating/etl load-reconciliation    # write nhdId + dedup flags
pnpm --filter @skating/etl prune-floor            # DRY by default; --apply to delete
scripts/etl/mirror-nhd-r2.sh push
scripts/etl/mirror-3dhp-r2.sh push
```

**Local artifacts** (gitignored, regenerable): `scripts/etl/.raw-nhd/`, `.raw-3dhp/waterbody/`,
`.scratch/corpus.ndjson` (**pre-prune**, 21,665 rows), `.scratch/nhd-postfloor.ndjson` (40,928),
`.scratch/reconcile.ndjson` (the mapping — now partly stale, 452 of its bodies were pruned).

**R2:** 4.31 GiB of 10 GB across seven buckets.

---

## Related

[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) · [`phase-N7b-corpus-by-request.md`](./phase-N7b-corpus-by-request.md) ·
[`HANDOFF-wind-climate-archive.md`](./HANDOFF-wind-climate-archive.md) · [`01-decisions.md`](./01-decisions.md) (D91–D105)
