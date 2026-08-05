# HANDOFF — N7: the master list, and everything building it exposed

> **Rewritten 2026-08-05.** Supersedes the 2026-08-04 version, whose "open proposal: classification"
> is now built and whose numbers are all superseded.
>
> Branch **`phase-n7-unified-corpus`**, 33 commits, nothing pushed. Ten commits this session
> (`402bd71`…`bcbb108`). Full suite green: 11 packages, 1,522 core tests.
>
> **Convex writes this session were confined to `adminAreas`.** `waterBodies` was not touched — the
> corpus is still the 18,383 rows the prune left. The master list exists only as a local artifact.

---

## Read this first

**The merge is built and runs end to end, but nothing has been upserted.** `master.ndjson` holds
27,074 bodies against a live corpus of 18,383, and the gap between those two numbers is `resolveUpsert`
— which is still wired to nothing. That is the next piece.

**Every number below balances.** 178,690 groups = 11,631 refused + 35,637 out of region + 104,348
filtered + 27,074 kept. The first time the pipeline has been checkable that way.

---

## What exists now

| | |
| --- | --- |
| `packages/core/src/waterClass.ts` | every OSM / NHD / 3DHP class value → our five-value enum, plus a bilingual name-keyword table |
| `packages/core/src/confidence.ts` | per-attribute agreement scoring + the review-queue predicate |
| `scripts/etl/src/merge.ts` | **the master list** — three catalogues, three matching lanes, one filter |
| `scripts/etl/src/classifyDryRun.ts` | the read-only classification funnel over all three corpora |
| `scripts/etl/src/gnisArchive.ts` | the GNIS gazetteer lane (D105) |
| `scripts/admin-areas/src/fetchStates.ts` | Census TIGER boundaries, all three levels |

```bash
pnpm --filter @skating/etl merge                  # the master list → .scratch/merge/master.ndjson
pnpm --filter @skating/etl classify-dry-run       # classification funnel, read-only
pnpm --filter @skating/etl archive-gnis           # GNIS → .raw-gnis/ (mirrored)
pnpm --filter @skating/admin-areas fetch-states   # TIGER → adminAreas
scripts/etl/mirror-gnis-r2.sh push
```

## The master list, as it stands

```
groups            178,690
refused outright   11,631   vetoed as ocean, or every catalogue said drop
outside 5 states   35,637
named by GNIS         526   → 306 ADMITTED by that name alone
kept               27,074

dropped  66,293 unnamed wetland <50ac · 37,896 unnamed 1–5ac · 159 named wetland under floor
class    lakePond 18,794 · wetland 3,884 · reservoir 2,706 · unclassified 1,533 · bay 130 · river 27
sources  1: 6,480 · 2: 6,310 · 3: 14,209 · 4: 75
queue    1,388   class 664 · name 512 · bay-without-parent 159 · same-source-dup 92
```

---

## The rule that governs everything here

**Merge first, filter once.** The campaign as originally built filtered each source *before* anything
merged, which is how OSM's `wetland=marsh` tag deleted **123 bodies NHD calls `LakePond`**, 17 of them
GNIS-named. The only rule safe to apply pre-merge is D96 rule 1 (nothing under an acre), because it is
the only admission rule no other source can overturn.

**That principle recurs at three depths, and each one was a separate near-miss:**

1. **Class** — a body OSM calls wetland and NHD calls LakePond. Merge, then filter.
2. **Region** — the state geodatabases are not clipped to their states. Clip the *merged* body.
3. **Name** — GNIS must be read *before* the floor, because D96 admits a named wetland at 5 acres and
   refuses an unnamed one under 50. **306 bodies exist solely because of that ordering.**

---

## Things it would be expensive to re-learn

**A refusal that survives a merge is worse than no refusal.** `null` means "not water we cover";
`unclassified` means "water, nobody said what kind". Collapsing the first into the second admitted
**Lake Huron and seven polygons of the Atlantic Ocean**. And some refusals must *veto* rather than be
weighed — NHD publishes Lake Erie as FTYPE 390 LakePond and Long Island Sound as 493 Estuary.

**A threshold taken from prose is a guess.** The polygon-agreement bar was set at 0.85 from a sentence
in the phase plan. The measured OSM-vs-NHD median over 12,643 pairs is **0.883** — the bar sat *below*
the median and called 38.6% of all matched pairs a disagreement.

**`unclassified` and `silent` are not votes.** Scoring `unclassified` as a class claim made 6,756
bodies read as "the catalogues conflict" — most of a 3,999-row queue nobody could have worked. Same
for 3DHP, which publishes **no wetland class at all**, so its silence is never dissent.

**One source agreeing with itself is not corroboration.** NHD and 3DHP collapse to one vote (3DHP
re-publishes NHD; 7,878 lakes, zero disagreements ≥ 0.1%). So does GNIS, because **NHD's `gnis_name`
column IS GNIS**.

**A control experiment over features only one source has measures coverage, not error.** The matcher
error rate was reported as 15.53% before it was restricted to features *both* federal catalogues
publish. The real figure is **1.14%**.

**OSM relation assembly is silently unreliable.** State boundaries are relations whose member ways are
shared with neighbours; a clipped extract cannot close the ring. `adminAreas` had **3 state rows and
105 of 116 counties** for a year, and nothing said so. TIGER needs no assembly — and its vintage is in
the URL, with TIGER2020 still served, which is why it is pinned rather than mirrored. GNIS is the
opposite: **no vintage in the path, overwritten in place**, so it is archived and mirrored.

**OSM maps `admin_level` 7 AND 8 both to `town`.** In New York that is 999 towns plus 574 villages,
and a village sits *inside* a town — so the town layer self-overlapped and containment was
order-dependent.

**`ogr2ogr -overwrite` does not replace a single-file datasource; it APPENDS.** Bit three times this
session — a CSV, a GeoJSONSeq, and ten states from five. `rmSync` first.

**`\b` is ASCII-only in JavaScript**, so `/\bétang\b/` matches nothing, silently. Names are folded
through NFD before matching.

**A drop-word list will delete real water.** `flow` names eight Adirondack impoundments including
Higley Flow, a state park; `deadwater` names Debsconeag and Nesowadnehunk. A keep-word now outranks a
drop-word in the same name.

**Piping a long run through `tail` hides its progress** until the pipeline ends. Log to a file.

---

## What is next, in order

> **Re-ordered 2026-08-05 after an audit against the live deployment and the plan doc.** Two things
> changed: *"`resolveUpsert` → `importCanonical`"* turned out to be five gaps rather than one, and the
> **bake-off moved ahead of the import** because the plan's own ordering (step 3 before step 5) is
> right — `geometrySource` is a field, but the *polygon* moves with it, so deciding after the load
> means loading 27,074 outlines twice.
>
> Also settled by that audit: **campaign steps 2 and 4 have already run.** Every sampled row carries
> `waterBodyKey`, `osmId` and `geometrySource`; ~69% carry `nhdId`. Both the plan doc and this file
> previously implied otherwise. That 69% is what makes the import safe — an NHD-only feature now meets
> a corpus that already knows its NHD ids, so it patches instead of duplicating.

1. ~~**Plan-doc revision.**~~ ✅ Done — `phase-N7-unified-corpus.md` now carries the corrected step
   list, the five step-5 blockers, the post-step-2/4 baseline, and D109's vocabulary amendment.
2. **Harden `merge.ts`.** It is excluded from coverage as "glue" and holds the phase's entire decision
   logic — the veto set, class precedence, the name union, the union-find, the region clip, the GNIS
   lane, the bay rule. Named fixtures, per the plan's verification section. Three specific suspicions:
   the bay-parent test is **bbox containment only**; `inRegion` samples 8 outline vertices per ring
   and could drop an in-state body through a boundary topology gap (35,637 were dropped this way);
   name selection is longest-wins with nothing behind it.
3. **The `WATER_BODY_CLASSES` migration** (D109 amendment, founder-approved 2026-08-05). ~45
   production sites, ~132 test lines. Schema field + `canonicalBody` validator + ETL `CanonicalBody`
   are one wire contract and flip together.
4. **D92's bake-off** — *before* the import, not after. The referee is our 2.4M soundings:
   `containedFraction` (a too-small polygon loses) against D98's body-probed density (a too-big one
   loses). Geometry source is a hardcoded OSM-first placeholder, under which Beau Lake merges at 2,457
   acres against NHD's measured 1,876.6 — a 31% error on the phase's headline fixture.
5. **The emit stage + `resolveUpsert` wiring.** `master.ndjson` has **no geometry** — it is a report,
   not a loadable artifact — so this needs a source-agnostic replacement for `featureToCanonicalBody`
   (which is OSM-only and re-does its own classification). Plus: `threeDhpId`/`gnisId` are missing from
   the schema along with a `by_three_dhp_id` index, `WATER_BODY_SOURCES` has no `3dhp`,
   `catalogueIds()` derives ids instead of carrying them, and the `merge`/`conflict` verdicts have no
   queue path.
6. **A new step-6 prune.** `importCanonical` never deletes, so the 18,383 stored bodies include rows
   the master list does not re-affirm — a vetoed class, an out-of-region body. `pruneBelowAreaFloor`
   only sees area and cannot find them.
7. **A clean merge run against committed code.** The current `master.ndjson` came from a build that
   fetched GNIS inline to `.scratch/`; same 16,310 features, but re-run before trusting it.
8. **The OSM↔NHD match-rate breakdown by class.** 30,283 of 91,315 (33%) and still unexplained.
   Suspicion: wetland, where OSM traces vegetation and NHD traces hydrography, so IoU ≥ 0.5 fails
   honestly. Unproven.

**Deliberately not done:** Québec. It needs three new source lanes — StatCan boundaries, NHN/CanVec
hydrography, CGNDB names. Only OSM crosses the border. The classifier's French keywords are already in.

---

## Related

[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) · [`phase-N7b-corpus-by-request.md`](./phase-N7b-corpus-by-request.md) ·
[`01-decisions.md`](./01-decisions.md) (D91–D110)
