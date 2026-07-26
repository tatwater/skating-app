# Phase 2.5 build plan — Regional expansion (Northeast skating states)

> **✅ COMPLETE on dev (2026-07-15, PR #14); prod deferred** (Convex prod uninitialized by decision).
> All workstreams executed — see "Progress" below. The prod pass (re-run the loader + tiles + env
> against a prod deployment) waits until prod exists.

The execution runbook for **Workstream H** of [`phase-2-map-and-reports.md`](./phase-2-map-and-reports.md)
(§H) and **Phase 2.5** of [`07-roadmap.md`](./07-roadmap.md). Design rationale lives in those docs
and the decisions log (D5/D6/D48/D49); this doc is the *how* — the ordered ops runbook, the small
code changes, and the tuning knobs.

> **Goal.** Widen the pilot's **single-state Vermont** corpus + basemap to the Northeast
> **lake-skating** states — **NY (north of the NYC/Long Island metro), VT, NH, ME, MA** — with **no
> new app features**. Pure data + infra: re-run the Phase 1 ETL per state, build one multi-state
> `.pmtiles` and host it on **Cloudflare R2**, then (last) widen the map bounds so a skater anywhere
> in the region opens the app onto their lakes.

## Progress — executed 2026-07-15

- **§1 Water data — ✅ DONE (dev).** Per-state Geofabrik extracts (dated 2026-07-14 builds) → NY clip
  at lat 41.3 (`osmium extract --bbox=-79.9,41.3,-71.8,45.1`, dropped 481→272 MB) → filter/transform/
  load. Inserted (dev `agile-bee-397`): **NH 15,458 · ME 25,541 · MA 30,219 · NY 34,885** (+ VT's
  ~9,970 from Phase 1) ≈ **116k bodies**, ~452 border-dedup updates (Champlain etc., idempotent on
  `source+externalId`). **Zero read-cap errors** across the whole import. *(Redownload note: the
  `-latest` URLs now 302-redirect to dated builds — fetch needs `curl -L`.)*
- **Lake search box — ✅ DONE (decided 2026-07-15, folded into 2.5).** The 116k corpus made
  name-search near-essential. Backend: a `search_name` search index + `waterBodies.searchByName`
  query (typo-tolerant; JS-refines out unlisted; 4 convex-tests) — deployed to dev, verified live
  (George/Winnipesaukee/Sebago/Champlain). Web: shadcn/Base-UI `Combobox` primitive + `LakeSearch`
  (container + testable `LakeSearchBox`), 4 tests, build green. Mobile: Tamagui `LakeSearch` overlay
  (RN-render tests deferred — same infra gap F1 flagged). Shared gate `searchQueryArg` lives in
  `@skating/core`. Select → `/water/:id` (reuses the existing fly-to).
- **§2/§3 Basemap → R2 — ✅ DONE (dev).** `pmtiles extract` from `build.protomaps.com/20251215.pmtiles`
  over the `-79.9,41.2,-66.8,47.5` bbox, z0–14 → **948 MB** (275,750 tiles), verified. Uploaded via
  `upload-r2.sh` to `r2:skating-basemap/dev/northeast-20260715.pmtiles`; serving
  `https://pub-9cd145bf729f4c2d9c219ece527fccd9.r2.dev/dev/northeast-20260715.pmtiles` (public,
  range-verified). **Still yours:** the bucket **CORS policy** (web only) + the custom-domain
  hardening (documented, deferred).
- **§4 Env — ✅ DONE (dev/local).** `VITE_PMTILES_URL` (`apps/web/.env.local`) +
  `EXPO_PUBLIC_PMTILES_URL` (`apps/mobile/.env.local`) point at the R2 object.
- **§6 Bounds — ✅ DONE.** `VERMONT_MAX_BOUNDS` → `NORTHEAST_MAX_BOUNDS` (`[-79.9,41.2]..[-66.8,47.5]`)
  + `INITIAL_ZOOM` 8.5→6.5 in both apps' `waterMap.ts`, kept in sync with the tile bbox; `waterMap.test.ts`
  updated in both (web 16, mobile 9 green).
- **§5 `curatedBoost` re-seed — ✅ mechanism DONE + seed applied (2026-07-15).** Added an internal
  `waterBodies.applyCuratedBoostSeed` (auth-free; match by name via the search index → disambiguate a
  repeat by optional state hint else largest area → set boost + rescore + re-index). Ran the VT seed
  CSV at a flat **+0.3**: **21 bodies boosted**, 12 not-found. The wins are correct — **Lake Morey
  VT → minVisibleZoom 9→7** (now draws at regional zoom, the marquee criterion), Lake Champlain,
  Lake George **(NY, correctly picked over the MA/ME namesakes)**, Placid, Willoughby, Moore
  Reservoir (NH,VT), etc. **Known imperfection (expected):** several seed rows are Champlain/Lake
  George *bays* that aren't distinct OSM bodies (Malletts/Northwest/Burlington/Shelburne/Outer Bay,
  Dillenbeck, Saranac Lake → not-found), and a few (South Bay, Button Bay, Half Moon Cove, Foster
  Pond → matched Maine namesakes; Mill Pond → a NY namesake) **mis-matched a same-named body
  elsewhere** — the seed has no coordinates, so the name→body map isn't clean. This is exactly the
  curation the **Phase 7 admin water-body UI** owns (set/adjust/remove per-body boost with the map in
  front of you). Mechanism proven; data curation is Phase 7.
- **Prod — ⬜ DEFERRED** (Convex prod uninitialized, as planned).

## Status / prerequisites

- **Runs after the mobile MVP.** F1 (online loop) shipped 2026-07-14 (PR #13); F2 (offline queue)
  is **deferred past this** by decision (2026-07-14) — F2 is orthogonal (mobile-only draft queue),
  nothing in H depends on it, so H goes first. This branch (`phase-2.5-regional-expansion`) is
  **stacked on `phase-2-mobile-f1`**, which is stacked on `phase-2-web`; H's PR chains behind #12 → #13.
- **Import target: dev only.** Convex **prod is still uninitialized** (never deployed; blocked on
  Clerk prod env vars), so the whole of H targets the **dev** deployment (`agile-bee-397`). Prod
  import + tile host is a later pass once prod exists.
- **Operator prerequisites (yours to set up before the run):**
  - `osmium-tool`, `GDAL`, `pmtiles` CLIs (already used in Phase 1 — see the ETL/basemap READMEs).
  - A **Cloudflare R2** bucket + credentials, and **`rclone`** configured with an R2 remote (below).

## Settled decisions (2026-07-14)

- **Region = NY (north of ~41.3°N) + VT + NH + ME + MA.** Per-state Geofabrik extracts, **not** the
  `us/northeast` dump (it drags in NJ/PA/CT/RI we don't want). NY clipped by bbox to drop downstate.
- **NY clip = rectangular `osmium extract --bbox`, cut at lat ≈ 41.3°N.** Verified safe against the
  community seed: every skated NY body — Lake George (~43.4), Saranac/Placid (~44.3), Dillenbeck Bay
  (~43.1), the Champlain bays (~43.5–44.9) — sits *far* north of the cut, so a straight line sheds
  only NYC/Long Island/lower-Hudson and can't bisect a destination lake. A polygon clip was rejected
  as not worth the upkeep for the pilot; revisit only if a wanted lake turns up near the line.
- **Basemap tiles → Cloudflare R2**, uploaded via **`rclone`** (Cloudflare's `wrangler r2 object put`
  caps ~300 MiB; the multi-state `.pmtiles` blows past that — rclone does resumable multipart to R2's
  S3 endpoint). **Public URL starts on the zero-config `*.r2.dev` bucket** to unblock the pilot;
  **custom domain is the prod-hardening step** (r2.dev is rate-limited / discouraged for real traffic,
  but tile reads are KBs/view for a friends alpha). The VT tiles migrate to R2 too, so all
  environments serve from one host.
- **Map bounds widen LAST**, after the water data lands — never before, so no pan area is ever empty
  of data.

## Ordering (hard dependency: data before bounds)

1. Water data per state → dev Convex (§1).
2. Build the multi-state `.pmtiles` (§2) + host on R2 (§3) + repoint env (§4). *(§1 and §2/§3 are
   independent — the tiles don't need the data — but do the data first so a mid-run peek renders.)*
3. `curatedBoost` re-seed (§5) — after the NY/NH bodies exist to attach to.
4. **Bounds + framing widening (§6) — the final step**, once §1 confirms the wider corpus renders.

---

## §1 — Water data: per-state ETL into dev Convex

Re-run the Phase 1 pipeline (see [`scripts/etl/README.md`](../scripts/etl/README.md)) **once per
state**. Only NY gets the extra clip step. Record each extract's **download date + md5** in the PR.

Per-state Geofabrik extracts (north-america/us/):
`new-york`, `vermont`, `new-hampshire`, `maine`, `massachusetts` (`*-latest.osm.pbf`).

**NY only — clip downstate before the tags-filter:**
```bash
# in scripts/etl/.scratch, after fetching new-york-latest.osm.pbf
osmium extract --bbox=-79.9,41.3,-71.8,45.1 new-york-latest.osm.pbf \
  -o new-york-upstate.osm.pbf --overwrite --strategy=complete_ways
# then run the normal tags-filter → export → transform → load on new-york-upstate.osm.pbf
```
- `--strategy=complete_ways` keeps border-spanning features whole (so a lake straddling the cut
  isn't torn — though the 41.3 line was chosen to avoid skated lakes entirely).
- VT/NH/ME/MA skip the clip — filter/transform/load their `*-latest.osm.pbf` directly.

**Load order & border dedup.** `waterBodies.importCanonical` upserts on `source + externalId`
(`way/<id>` / `relation/<id>`), so a body appearing in two extracts (Lake Champlain is in both the VT
and NY extracts; Connecticut River bays touch VT/NH) **dedupes automatically** — the second load
upserts the same row. Order is irrelevant; geometry is the same OSM object in each extract
(Geofabrik ships complete features). Each body is D49-scored on insert; the loader paginates under
the 4,096-read cap. Corpus grows from VT's ~9,970 to (est.) tens of thousands of bodies.

**No ETL code change** — this is a runbook. The one addition is documenting the per-state + NY-clip
steps in `scripts/etl/README.md` (§ Code changes).

## §2 — Basemap: build the multi-state `.pmtiles`

One extract over the 5-state envelope (see [`scripts/basemap/README.md`](../scripts/basemap/README.md)).
The `--bbox` **must match the widened `NORTHEAST_MAX_BOUNDS`** (§6) — the basemap has to cover
everywhere the map lets you pan.

```bash
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  scripts/basemap/.scratch/northeast-basemap.pmtiles \
  --bbox=-79.9,41.2,-66.8,47.5 \
  --maxzoom=14
pmtiles verify scripts/basemap/.scratch/northeast-basemap.pmtiles
```
- **Source = a live `build.protomaps.com/<date>.pmtiles`**, not the dead demo `v4.pmtiles` (they
  prune dated builds; F1b already repointed the app default). Pick a current dated build.
- **Size estimate:** the envelope is ~5× VT's area, so expect **~1.3–2 GB** at z0–14 (denser around
  Boston/Albany; a lot of the box is ocean, which costs little). This **overflows Convex free storage**
  → R2. Record the actual size in the README's "Last build" table.
- The rectangular envelope necessarily covers some **CT/RI/northern-NJ/eastern-PA background** land.
  That's harmless — those areas carry **no water pins** (we imported no data there), same as any land.

## §3 — Host on Cloudflare R2

One-time rclone setup (yours):
```bash
rclone config   # new remote, type = s3, provider = Cloudflare,
                # access_key_id / secret_access_key from the R2 API token,
                # endpoint = https://<accountid>.r2.cloudflarestorage.com
```
Then upload via the new sibling script (§ Code changes):
```bash
scripts/basemap/upload-r2.sh scripts/basemap/.scratch/northeast-basemap.pmtiles
```
- The script `rclone copyto`s the file to `<remote>:<bucket>/<key>` with multipart + progress, then
  prints the **public serving URL** (`https://<pub-r2.dev-or-custom-domain>/<key>`).
- **CORS + Range:** R2 serves HTTP `Range` natively (the hard `pmtiles://` requirement); add a bucket
  **CORS rule** allowing `GET` + the `Range` request header from the web origin (mobile native has no
  CORS). The script documents the rule; you apply it once in the R2 dashboard.
- **Migrate VT too:** upload the existing VT `.pmtiles` to R2 as well so dev serves both from one host
  (or just let the multi-state file supersede it — the VT box is a subset of the new one).

## §4 — Repoint the tile env (no app change)

The app reads the tile URL from env, so this is a swap, not code:
- **Web dev:** `VITE_PMTILES_URL=<R2 url>` in `apps/web/.env`.
- **Mobile dev:** `EXPO_PUBLIC_PMTILES_URL=<R2 url>` in `apps/mobile/.env.local`.
- **Prod (later, once prod exists):** the same vars in Vercel / the EAS build env — a `.env.local`
  value does **not** ship in a cloud build, so this must be set in the EAS env for a production build.

## §5 — `curatedBoost` re-seed

The VT seed (`training_data/google_group/curated_boost_seed_vt.csv`) already lists NY/NH destinations
(Lake George, Northwest Bay, Dillenbeck Bay, Saranac Lake, Lake Placid, Broad Lake, South Bay, …) that
were **skipped in Phase 1** for not existing in a VT-only import. Now that those states are loaded,
apply them:
- Match seed rows to imported bodies **by name** (the seed has names + community mention counts, **no
  coordinates** — so it's a name match, disambiguated by region where a name repeats). Champlain-area
  names already matched in Phase 1 stay boosted (idempotent).
- Apply via the existing `waterBodies.setCuratedBoost` admin mutation (recomputes `displayScore` +
  `minVisibleZoom`, re-inserts the geospatial key, writes a `moderationActions` row) — a small
  one-off internal-mutation/script pass, same shape as the Phase 1 VT seed apply.
- **Phase 7** lifts per-body boost editing into the admin water-body surface (don't bury it in a
  script long-term — see §H open items).

## §6 — Bounds + framing widening (LAST)

Only after §1 confirms the wider corpus renders. Edit **both** `apps/web/src/lib/waterMap.ts` and
`apps/mobile/src/lib/waterMap.ts`, kept in sync with each other **and** the §2 `--bbox`:

- **Rename** `VERMONT_MAX_BOUNDS` → `NORTHEAST_MAX_BOUNDS` (a "Vermont" constant spanning 5 states
  misleads) and widen to the envelope:
  ```ts
  export const NORTHEAST_MAX_BOUNDS: [[number, number], [number, number]] = [
    [-79.9, 41.2],  // SW — NY's Lake Erie edge / just below the NY downstate cut
    [-66.8, 47.5],  // NE — Maine's northeast tip
  ]
  ```
- **`INITIAL_CENTER`** barely moves — Burlington `[-73.15, 44.46]` is ~dead-center of the envelope;
  keep it. **Lower `INITIAL_ZOOM`** from `8.5` to ~`6.5` so the fallback framing shows the region, not
  just VT. (Framing is device-geolocation-first; this is only the no-fix fallback.)
- **`frameForCoord`** needs no logic change — its in-region gate defaults to the max-bounds constant,
  so widening the constant widens the gate automatically. Just update the default param name.
- Update `waterMap.test.ts` in **both** apps: the in-region/out-of-region `frameForCoord` cases (a
  coord now in-region that used to be out — e.g. Lake George, the Maine coast), and any hardcoded
  bounds assertions. ODbL attribution assertions unchanged.

**These constants are starting values, tuned during the run** (same approach as the displayScore
curve): confirm the extract `--bbox`, the NY clip lat, and `NORTHEAST_MAX_BOUNDS` all agree, and eyeball
that no wanted lake falls outside the box or south of the clip.

---

## Code changes I own (small; everything else is ops)

1. **`scripts/basemap/upload-r2.sh`** (new) — rclone-based R2 upload sibling to `upload.sh`; prints the
   public serving URL; documents the required CORS rule. `upload.sh` (Convex storage) stays for
   reference but R2 is now the documented host.
2. **`scripts/basemap/README.md`** — multi-state `--bbox`, the live-build source note (demo is dead),
   the R2 host section (rclone setup + CORS), and a fresh "Last build" row.
3. **`scripts/etl/README.md`** — the per-state run list + the NY `osmium extract --bbox` clip step +
   the border-dedup note. (No `.ts` change — transform/load already handle multi-state.)
4. **`apps/{web,mobile}/src/lib/waterMap.ts`** — the §6 bounds rename/widen + `INITIAL_ZOOM`, and both
   `waterMap.test.ts` updates. **Committed last.**
5. **`curatedBoost` re-seed** — a tiny one-off apply (script or internal mutation) per §5.

## Suggested commit breakdown (one PR — Phase 2.5)

1. **docs** — this plan + §H/README/roadmap status (+ the F1-done markers already staged).
2. **basemap infra** — `upload-r2.sh` + basemap README (R2 + multi-state).
3. **etl docs** — per-state + NY-clip runbook.
4. **bounds** — widen `NORTHEAST_MAX_BOUNDS` + framing + tests (both apps). *(Last — after you've run
   the import and confirmed it renders.)*
5. **curatedBoost re-seed** — the apply pass.

## Open / tuning items

- **Exact clip lat + envelope** — start at 41.3 (clip) and the bounds above; eyeball against the loaded
  data before finalizing §6. Keep the ETL clip bbox, the pmtiles `--bbox`, and `NORTHEAST_MAX_BOUNDS`
  mutually consistent.
- **R2 public URL** — `r2.dev` to start; move to a custom domain (+ caching) before real traffic.
- **Prod** — deferred until the Convex prod deployment exists (Clerk prod env vars first). H's prod
  pass = re-run the loader with `--prod`, upload tiles to a prod R2 path, set prod env vars.
- **Actual corpus + tile sizes** — record post-run in the ETL/basemap READMEs and the PR.

## Risks / watch-outs

- **Read-cap at scale (D49).** ⚠️ **This risk landed, and the validation it asks for never happened**
  — caught 2026-07-26 by N1. The 116k corpus did stress `listInViewport`, but nobody re-measured
  wide-zoom read counts after the load, so the `MAX_VIEWPORT_LIMIT = 256` clamp (tuned against VT's
  9,967 bodies) silently stayed put — dropping 257 real lakes from a dense eastern-Maine viewport that
  holds 513. Fixed by the N1 cell index; the read counts this bullet asked for are now recorded in
  [`phase-N1-read-path-durability.md`](./phase-N1-read-path-durability.md) and re-checkable via
  `waterBodies:viewportReadStats`.
- **Border-spanning bodies** — dedupe by `externalId` (verified idempotent), but spot-check Lake
  Champlain and the Connecticut River bays render once, not doubled, after the multi-state load.
- **Bounds/basemap/clip drift** — three places carry the region envelope (ETL NY clip, pmtiles
  `--bbox`, `NORTHEAST_MAX_BOUNDS`); a mismatch shows blank tiles at a corner or lets you pan past the
  data. Keep them in sync (called out in each file).
- **ODbL attribution** unchanged — driven by the water source + always-on attribution control,
  independent of the tile host.
