# HANDOFF — N7: the master list, and everything building it exposed

> **Rewritten 2026-08-05, re-measured 2026-08-06, and the campaign RAN on 2026-08-07.** The numbers
> below are from the run that was loaded; earlier ones are kept only where they are the comparison.
>
> Branch **`phase-n7-unified-corpus`**, three commits for the audit and the load, nothing pushed.
> Full suite green: 11 packages, **3,772 tests**, lint and typecheck clean.
>
> **✅ The corpus is live on dev.** `waterBodies` holds **25,136** rows and `waterBodySubAreas` **120**,
> under campaign `n7-2026-08-07`. Prod remains untouched and has never been deployed.

---

## Read this first

> **⚠ Two intake audits and a live load changed the code under this document** — 2026-08-05
> (D113–D117), 2026-08-06 (D118–D125) and the campaign itself on 2026-08-07. Everything below
> describes the shape of the pipeline correctly. What changed is that **thirteen defects were found
> and fixed**, every number was re-measured against a run that was actually loaded, and the merge now
> **refuses to finish** if its own arithmetic does not balance.
>
> **The lesson worth carrying out of it:** static review found the wire contracts; *everything else
> came from interrogating artifacts.* `dropped.ndjson`, the manifest run-to-run delta and
> `geometry-review.ndjson` were built as bookkeeping and turned out to be the bug-finders — the last
> of them caught a fragment stored as a whole lake on its first run.

### The audit, in one screen (D113–D117)

**Nothing has been upserted yet**, and that is now a good thing: the load would have failed. `states`
was emitted by the ETL, declared on `CanonicalBody`, and **absent from Convex's `canonicalBody`
validator** — and Convex object validators are exact, so every batch of a merged load would have been
rejected. Adding the field alone would have been worse: the handler read a `--state` CLI flag that a
single-pass merged load does not have, so it would have written 27,000 rows with no state and silently
emptied every regional filter in the app. Fixed both halves (D116).

Four more that were silent rather than fatal:

- **The review queue was computed and thrown away.** `confidence.ts` — a fully tested core module — had
  no consumer: the merge tallied D110's scores into three lines of terminal output and stored nothing,
  so 1,388 flagged bodies could never reach a human. Now on the row (D115).
- **Step 6 had no implementation.** `importCanonical` never deletes, so a re-import leaves the corpus
  as the union of the master list and whatever was there before. `pruneNotInCampaign` + a
  `lastCampaignId` stamp (D115).
- **Beau Lake was wrong, and the fix had no producer.** 2,457 ac from OSM against Maine's published
  1,788; D92's per-lake override was a documented field that nothing wrote. `GEOMETRY_OVERRIDES` now
  exists and Beau Lake is its first entry, drawn by NHD at 1,876.6 ac (D117).
- **The merge kept no ledger and wrote no run row**, in a campaign whose D99 says every pass does.
  Eight exits dropped records uncounted — the largest being the one-acre floor, ~64% of raw OSM, with
  no number at all (D113).

**"Every number balances" is now enforced rather than claimed.** It balanced from the *grouping stage
onward*; upstream and downstream of it were the eight silent exits. Two equations now run before
anything is written, and they throw:

```
seen == kept + dropped        (per lane)
kept == emitted + emitFailed  (the two artifacts)
```

**Three numbers below will move on the next run**, and that is the point: the ocean veto now catches
Great Lakes NHD publishes as `LakePond`, an explicit refusal now beats another source's silence
(`unclassified` was letting 3DHP rivers in), and `inRegion` no longer drops a body because eight
sampled vertices missed the mask. Re-run before quoting any figure in this file.

---

**The merge runs end to end.** ✅ **Run 6, 2026-08-07 — the numbers to quote.** Six runs, because each
one found something the last could not; the changes between them are D118–D125.

```
groups            178,456  =  25,133 bodies + 112 sub-areas + 153,211 dropped   (asserted, not claimed)

dropped   62,295 unnamed wetland <50ac · 35,620 out of region · 35,192 unnamed 1–5ac
          11,491 no-class · 6,988 NY below I-84 · 942 SALT WATER · 482 named wetland under floor
             134 vetoed · 66 refused-over-silence · 1 vetoed-area (a 132,333-ac 3DHP river)
class     lakePond 17,622 · wetland 3,836 · reservoir 2,462 · unclassified 1,187 · river 26
source    osm 19,224 · nhd 5,909      sources/body  1: 5,657 · 2: 5,750 · 3: 13,649 · 4: 77
gnis      1,206 named · 921 ADMITTED by that name alone
queue     2,010   duplicate-candidate 812 · class-conflict 652 · name-conflict 463 ·
                  same-source-duplicate 93 · bay-without-parent 43
name lane   234 pairs the area-ratio ceiling refused, at the 0.3 bar
duplicates  416 overlapping pairs flagged after it
dissent     314 bodies one catalogue refused outright and another classed
matcher     0.02% disagreement (7 NHD-only, 4 3DHP-only, over dual-published features)
```

**Pre-load checks, all clean:** 0 bodies with no state · 0 duplicate `externalId` / `osmId` / `nhdId`
— so the load cannot silently collapse two bodies into one row · every balance equation asserted.

**Every named fixture verified in the output:** Beau Lake **1,871 ac from NHD** · `Lake Superior` NY
179 ac and `Little Lake Erie` 4 ac **kept** · **Nequasset Lake 449 ac and Winnegance Lake 187 ac
restored** · Braddock Bay kept · Great Bay / Saco Bay / Cobscook Bay / Merrymeeting Bay refused as
salt · Champlain 276,374 ac on the allow-list · Indian Lake's largest body at 3,743 ac.

### What run 6 changed, and why the deltas are the interesting part

| | run 3 → run 6 | |
| --- | --- | --- |
| **`gnisRescued`** | **1,771 → 921** | **850 bodies were being admitted on a neighbour's name.** The single largest data-quality find of the audit. |
| GNIS ids on >1 body | 963 → 761 | and the residue is **not ours**: only **one** of the 761 groups contains an unnamed body, and the gazetteer can only name a body no catalogue did. The rest is OSM tagging six `Fowl Meadow` polygons with one id — the documented "GNIS names places" case. |
| groups | 178,321 → 178,456 | +135, exactly the name-lane pairs the 0.3 bar declined (369 → 234). The arithmetic closes. |
| duplicate pairs | 497 → 416 | fewer wrong merges to detect |
| review queue | 2,185 → 2,010 | |

**And raising the name bar created no duplicates**, which was the risk. Indian Lake's ten bodies have
zero overlapping pairs: at 0.1 the 534-ac feature had been chained to the 3,743-ac one *transitively*,
through an NHD feature it merely grazed. `Fowl Meadow`'s six polygons overlap at IoU 0.003 — adjacent,
not duplicated.

**The pre-audit numbers, for comparison.** 178,690 groups = 11,631 refused + 35,637 out of region +
104,348 filtered + 27,074 kept.

---

## What exists now

| | |
| --- | --- |
| `packages/core/src/waterClass.ts` | every OSM / NHD / 3DHP class value → our five-value enum, plus a bilingual name-keyword table |
| `packages/core/src/confidence.ts` | per-attribute agreement scoring + the review-queue predicate |
| `scripts/etl/src/merge.ts` | archives in, artifacts out, and the report — the I/O half |
| `scripts/etl/src/masterList.ts` | **the master list itself** — four matching lanes, the filter order, the sweep, the emit stage. Pure, and covered end to end |
| `scripts/etl/src/classifyDryRun.ts` | the read-only classification funnel over all three corpora |
| `scripts/etl/src/gnisArchive.ts` | the GNIS gazetteer **fetcher** (D105) — runs `main()` at import, so import nothing from it |
| `scripts/etl/src/gnisSource.ts` | the gazetteer's constants, header rules and water classes — the importable half |
| `scripts/etl/src/mergeRules.ts` | every individual rule the master list applies, at 100% coverage |
| `scripts/etl/src/loadSubAreas.ts` | the bays → `subAreas.importBaySubAreas`, run after the body load |
| `scripts/etl/src/extract.ts` | the `osmium` / `ogr2ogr` argv, stated once for all four callers |
| `scripts/admin-areas/src/fetchStates.ts` | Census TIGER boundaries, all three levels |
| `scripts/admin-areas/src/regionRules.ts` | the bleed box, the downstate county list, coordinate rounding |

```bash
scripts/etl/run-corpus.sh <campaign-id>            # ← the whole campaign, in order, with provenance
scripts/etl/run-corpus.sh <id> --apply-sub-areas --actor=<profileId>

# …which is these, and they still work individually:
pnpm --filter @skating/admin-areas build-region   # region masks + boundaries.ndjson (TIGER)
pnpm --filter @skating/etl merge --campaign=<id>  # the master list → .scratch/merge/*.ndjson
pnpm --filter @skating/etl load .scratch/merge/bodies.ndjson --campaign=<id>
pnpm --filter @skating/etl load-sub-areas .scratch/merge/sub-areas.ndjson --actor=<profileId> --apply
pnpm --filter @skating/etl classify-dry-run       # classification funnel, read-only
pnpm --filter @skating/etl archive-gnis           # GNIS → .raw-gnis/ (mirrored)
pnpm --filter @skating/admin-areas fetch-states   # TIGER → adminAreas
scripts/etl/mirror-gnis-r2.sh push
```

**Every pass records its path now, without being asked.** The merge reads all seventeen archive
manifests and writes one run stage per file (`osm · vt`, `nhd · VT`, `3dhp · clip`, `gnis · ME`,
`mask · five-state`); `load` and `load-sub-areas` discover `merge-manifest.json` beside their input
and replay it, inheriting the campaign id and label. The 2026-08-07b campaign predates this and
shows an empty Path at `/admin/imports` — re-running the merge is what backfills it.


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

**…and the same rule applies one level up, which the first version missed.** An explicit drop from one
catalogue was losing to *silence* from another: 3DHP saying `featuretype=1 River` lost to OSM's
`natural=water` with no subtag, because `chooseClass` only weighed the non-null classes and a drop
contributes none. The layer below already ranked drop above silent within one source; it now does so
across sources too (D114). **A veto must also not depend on a match succeeding** — the token veto only
fires when the vetoing feature lands in the group, so Erie's exclusion rested on 3DHP matching it
geometrically. A name rule and a 100,000-acre ceiling need no match at all.

**A module with a `main()` exports nothing anybody else needs.** `merge.ts` imported one constant from
`gnisArchive.ts` and thereby re-ran the entire five-state GNIS download on every merge. Same trap
`admin-areas/tiger.ts` was split out to escape, one package over, a year apart.

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

> **Everything through campaign step 6 is done and live on dev** (2026-08-07). Items 1–8 of the old
> list are all closed; the two that were still open — the `WATER_BODY_CLASSES` migration and D92's
> bake-off — both landed, the migration finishing with `backfillWaterBodyClasses` reporting
> `unmappable: 0` against the corpus.

1. **Narrow the schema's `type` union to `WATER_BODY_CLASSES`.** This is the last step of the
   widen→deploy→backfill→narrow order and it is now *available*: the backfill rewrote the final 53
   rows (the prune-protected ones, which the loader can never reach by construction) and reports zero
   unmappable. Check every writer first — `waterBodies.create` takes its value from the mobile
   picker, which is the one path that does not come through the ETL.
2. **Work the 61-row dedup queue.** The prune spared them and they are all the losing halves of OSM
   duplicate pairs — Long Pond, Lovell Lake, Duncan Lake among them. Two independent systems now
   agree they are duplicates, so the merges are pre-answered; until somebody does them the corpus
   renders 61 known duplicates. **Never auto-merge** (D36/D93). See the plan doc's open items.
3. **Surface the review queue in `/admin`.** 2,010 rows — 812 duplicate-candidate, 652
   class-conflict, 463 name-conflict, 93 same-source-duplicate, 43 bay-without-parent — are stored on
   the rows and nothing shows them. `Lake Auburn` stored as `The Basin` is the clearest single
   example of why the name half matters.
4. **Decide `classDissent`** — 314 bodies one catalogue refused outright while another classified
   them. Counted rather than queued on purpose, because NHD drops 43% of its reservoirs by FCODE and
   the queue should not be buried before the volume is known. The volume is now known.
5. **Step 7, D97's audit report**, then the metered passes: depth + elevation (9), bathymetry re-key
   → join → build → tile → coverage (10), wind climate (11), `regionStats` (12). All of them now have
   the stable post-prune corpus D100 said they should wait for.
6. **Québec, still deliberately not done.** Three new source lanes — StatCan boundaries, NHN/CanVec
   hydrography, CGNDB names. Only OSM crosses the border. The classifier's French keywords are in,
   and `OCEAN_NAME_VETO_MIN_ACRES` was kept rather than deleted specifically for this.

### What the load itself taught, which no test could

Three limits that only bind on real data, all fixed, all worth remembering as a class:

- **A page size that is safe on the first page is not a safe page size.** `pruneNotInCampaign`
  advertised 500 rows while `bodyAttachmentKind` costs 10 index reads per *candidate* against
  Convex's 4,096 cap. The first real page had 11 candidates and sailed through; the wall is wherever
  the un-reaffirmed rows happen to cluster.
- **A stored polygon is a stored polygon.** The sub-area artifact carried unsimplified source
  geometry, which was wrong under D48 on its own terms and blew the mutation's 1-second budget when
  clipped against Moosehead.
- **A measurement in the file you are mirroring is still a measurement.** `importSeed` says a clip
  against Champlain "is comfortable alone and blows a mutation's 1s budget at a dozen". The bay
  loader shipped at 25, then 4, and the data settled it at 1.

Plus two robustness gaps the failure exposed: the bay loader aborted the whole pass on one bad batch
where `load.ts` survives them, and it had no top-level failure handler — so it left three
`sub_area_seed` rows stuck in `running`, which is the exact D99 signature, produced by the loader
written to honour D99.

---

## The second intake audit, 2026-08-06 — D118–D125

Requested before running the flow against real data. What changed, in one screen:

| | |
| --- | --- |
| **A missed match is a duplicate, not a gap** — and the matcher misses structurally. The name lane closes the named half (overlap always required, so a Mud Pond in Maine can never reach one in New York); `overlapDuplicates` flags the rest. | D118 |
| **No salt water.** ~360 tidal bodies were in the corpus — Great Bay, Waquoit Bay, New Bedford Harbor — because the token veto needs a match to succeed and one estuary against forty coves never matches. The veto is now spatial. The Great Lakes are excluded from the mask: 3DHP files them under the same code as the Atlantic, and Braddock Bay is fresh. | D119 |
| **`Lake Superior`, NY (179 ac) and `Little Lake Erie` (4 ac) were about to be deleted** by a substring name veto. Gated on area, kept for Québec/Alaska. | D120 |
| **Bays with a parent are sub-areas**, not rows overlapping their own lake. New `subAreas.importBaySubAreas` + `load-sub-areas`, run after the body load. | D121 |
| **Cross-border bodies stay whole**, `inRegionFraction` is evidence not a gate — and is now sampled to a total budget so the number means something. | D122 |
| **Every refused group is named** (`dropped.ndjson`), every run is diffed against the last (manifest delta), and D92's override finally has a candidate pool (`geometry-review.ndjson`). The middle of the pipeline asserts: `groups == bodies + subAreas + dropped`. | D123 |
| **A `conflict` no longer becomes a deletion**, and the prune refuses a page that is mostly deletions — the failure mode of a load with skipped batches. | D124 |
| **`masterList.ts`** — the second extraction. `merge.ts` still held the *order* the rules run in, which is where every ordering bug in this phase has lived. 22 end-to-end fixtures. | D123 |

**Also fixed:** `boundaries.ndjson` had no producer (a prose instruction in an error message) and cost
fidelity through Convex's array cap — `build-region` writes it from TIGER now; the merge asserts it
found five state outlines; and the id namespaces are asserted not to collide.

### ✅ The 61 the prune spared — resolved, queue empty

All of them are the **losing halves of OSM duplicate pairs** — Long Pond, Lovell Lake and Duncan Lake
among them, i.e. the five pairs §Why this phase exists names. The merge collapsed each pair onto one
body via NHD's shared `Permanent_Identifier`; the winner carries `lastCampaignId` and the loser does
not, and the prune spared the loser because a D36 match-on-create pass had already flagged it
`near_certain` for a human. Two independent systems reached the same verdict, so the queue's items are
pre-answered, so `resolveCampaignDuplicates` took them: **34 deleted outright, 5 more once the
founder confirmed a bathymetry pass was coming, and 22 handed to `pruneOutsideCoverage`** because
they were never a duplicate question — both halves had been refused by the D111 downstate cut, which
is a region rule rather than a queue one.

**The dedup queue is empty**: 0 `near_certain`, 0 `suspected_duplicate`, 0 tombstones, 0 dangling
pointers, 0 orphaned sub-areas. Corpus: **25,136 bodies · 120 sub-areas**. Never auto-merge on a
single system's say-so (D36/D93) — what made this safe is that two independent systems had already
agreed and the pass verifies that agreement per row. Full write-up in the plan doc's open items,
including `Lake Auburn` stored as `The Basin`.

### And four more that only running it could find (D125 + three)

The first full run against the archives found what no fixture could:

| | |
| --- | --- |
| **A fragment was being stored as the whole lake.** `chooseGeometry` took the *first* same-source member, so `Indian Lake` was stored at **534 ac** with a 3,743-ac OSM feature and a 4,296-ac NHD one in the same group. Now the largest, through one helper the three callers share. Surfaced by `geometry-review.ndjson` on its first run. | D125 |
| **The name lane at 0.1 swallowed a lobe** — the same Indian Lake, from the other direction. Pinned to `RECONCILE_MIN_IOU_WITH_GNIS` (0.3), because a name is weaker evidence than a GNIS id and D93 already settled that bar with the words *"accepting those merges a real lake into a fragment"*. | D118 |
| **Nine bodies belonged to no state.** `inRegion` walks every vertex before dropping a body; `statesFor` sampled eight per ring, so a border-straddler admitted on a missed vertex was invisible in every regional filter. Escalates identically now. | D116 |
| **The matcher-error rate measured coverage.** The dual-published restriction was applied to one side only — the giveaway was `7` one way against `512` the other, over two catalogues that are the same data. Symmetric now: **0.02%**. | D113 |

**And the census was auditing a different archive than the pipeline reads.** `auditArchives` used a
**5-acre** floor while `merge.ts` extracts at **one**, so it certified 53,130 rows against the
pipeline's 138,555 and the merge printed both side by side as comparable. The exact drift `extract.ts`
exists to end, in the one file never converted to it. Re-derived at the right floor: **138,555 rows,
107,990 distinct, and still zero ids duplicated within a single file** — the property that makes
deduping on `permanent_identifier` safe, which had only ever been checked at five acres.

**One thing measured rather than fixed, deliberately:** `classDissent` — a body one catalogue refused
outright while another classified it. `chooseClass` lets the class win (that is the 123-body rescue)
and `scoreBody` cannot see it (a refusal contributes no claim), so it resolves silently. The fixture
is **Lac Saint-François**, 87,927 ac of the St. Lawrence: OSM says `water=lake`, 3DHP says
`featuretype = 1 River`. It is now counted and sampled in the report; whether it becomes a review
reason is a call to take on the number, because NHD drops 43% of its reservoirs by FCODE.

**Deliberately not done:** Québec. It needs three new source lanes — StatCan boundaries, NHN/CanVec
hydrography, CGNDB names. Only OSM crosses the border. The classifier's French keywords are already in.

---

## Related

[`phase-N7-unified-corpus.md`](./phase-N7-unified-corpus.md) · [`phase-N7b-corpus-by-request.md`](./phase-N7b-corpus-by-request.md) ·
[`01-decisions.md`](./01-decisions.md) (D91–D110)
