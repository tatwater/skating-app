# basemap — the two self-built `.pmtiles` archives the map draws from

The map (`apps/web` and `apps/mobile`) renders our water bodies over a **Protomaps** vector basemap
(D6). Phase 1 shipped against Protomaps' **hosted demo** tiles to confirm the data rendered;
Protomaps asks that the demo bucket not be used in production. This directory is the manual,
run-on-demand pipeline that builds our own and self-hosts it.

It builds **two** archives, and the split is the point:

- a **regional** archive, clipped to the five states, carrying every level of detail;
- a **world overview** at z0–6, carrying oceans, continents, borders and a handful of names —
  everywhere, so the map does not simply end where our coverage does.

Between them the apps draw a **mask**: the neighbourhood around us that is not ours — sea, land over
it, then the big lakes — painted flat, which is what makes New Jersey an empty white shape with a
border and a name rather than a fully rendered state we have nothing to say about. It covers water as
well as land, and it is drawn a thousandth short of opaque; both are load-bearing, and
`packages/core/src/basemapLayers.ts` says why. The mask and the region polygon are generated together by
`pnpm --filter @skating/admin-areas build-region`; the draw order and zoom policy live in
`packages/core/src/basemapLayers.ts`.

Like [`scripts/etl`](../etl/README.md), none of this is built or deployed with the apps — you run it
by hand when (re)building the basemap.

> **Why this stays a config swap.** Both apps read both tile URLs from env vars, so "rebuild the
> basemap" is: generate the shapes → extract → upload → set four env vars. No app-code change.

---

## 1. Build — two archives, and the shape that separates them

The map draws from **two** `.pmtiles` archives, and has since 2026-08-05. Before then there was one,
extracted with `--bbox`, and a rectangle cannot know where Connecticut starts: the map rendered
Ottawa, Toronto and Hartford in full detail while cutting the *world* off in a straight line at
41.2°N — the bbox floor, which runs just above Manhattan. Both halves of that are fixed by splitting
the job in two.

**First, the shapes.** `pmtiles extract` takes `--region=<geojson>` as well as `--bbox`, and the
region polygon is generated rather than typed:

```bash
pnpm --filter @skating/admin-areas build-region
```

That writes `scripts/basemap/.scratch/region.geojson` (the union of the five TIGER states) along with
the out-of-region mask both apps ship and the downstate-New-York polygons the ETL refuses. See
`scripts/admin-areas/src/buildRegion.ts` — it is the file to read before changing any of this, and it
explains why the mask is cut the way it is.

**Then the two extracts.** Both read only the tiles they need from a remote source over HTTP range
requests — no full download, no API key — and both land in the **same Protomaps v4 schema** the app
style (`@protomaps/basemaps`) already targets.

```bash
cd scripts/basemap/.scratch
SRC=https://build.protomaps.com/20251215.pmtiles   # a live dated build; see the note below

# The world overview: whole planet, low zoom only. Oceans, continents, borders, a few names.
pmtiles extract "$SRC" world-z6-$(date +%Y%m%d).pmtiles --maxzoom=6

# The region: everything, but only where we have something to say.
pmtiles extract "$SRC" northeast-$(date +%Y%m%d).pmtiles --region=region.geojson --maxzoom=14

pmtiles verify world-z6-*.pmtiles && pmtiles verify northeast-*.pmtiles
```

- **Why an overview archive at all.** The regional archive has no tiles outside the five states, so
  on its own the map ends wherever its coverage does — that straight line above Manhattan. 45 MB of
  whole-planet z0–6 buys an ocean everywhere and a world you can zoom out to. `REGION_MIN_ZOOM` in
  `packages/core/src/basemapLayers.ts` is where the two hand over, and that module owns the whole
  draw order; the apps only supply the URLs.
- **`--maxzoom=6` for the world** is the smallest thing that still draws recognisable coastlines and
  carries country and state labels. Each further level roughly quadruples it, and MapLibre overzooms
  past the archive's own maximum, so z6 keeps rendering at z14 — generalised, which is why
  `ADMIN_MAX_ZOOM` fades the admin lines out at z10 rather than letting them wander.
- **`--region` rather than `--bbox`** roughly halves the regional archive (948 MB → 458 MB) *and* is
  what stops Ontario rendering. It clips by **tile**, not by polygon, so a fringe of Connecticut
  survives along the border; the mask in `regionMask.ts` is what hides that, at every zoom. Neither
  half works alone.
- **`--maxzoom=14`** is the fidelity/size trade: crisp through street and town-label detail, and
  MapLibre overzooms past 14 so you can still zoom to a single lake (the water polygons are our own
  layer and stay crisp regardless). z15 roughly doubled the file for building detail a lake map does
  not need.
- **Source.** Protomaps prunes dated builds, so `20251215` will eventually 404 — pick a current one
  from [maps.protomaps.com/builds](https://maps.protomaps.com/builds). Extracting from a planet build
  guarantees a visual match with what the app already renders. Building locally with the
  [protomaps/basemaps](https://github.com/protomaps/basemaps) planetiler profile is the heavier
  alternative, and the only way to clip by polygon rather than by tile if the mask ever stops being
  enough.

The `.scratch/` dir is gitignored — the `.pmtiles` files are **not committed** (too large; they live
on R2, below). `regionMask.ts` *is* committed, into both apps, because it is 180 KB and the map needs
it before the first tile arrives.

## 2. Host — upload to Convex file storage

We colocate the basemap on **Convex file storage**. Its serving URL honors HTTP `Range` *and*
reflects CORS — the two hard requirements for the browser `pmtiles://` protocol (both verified;
see `packages/convex/convex/basemap.ts`). `upload.sh` mints an upload URL via the internal
`basemap:generateUploadUrl` mutation, POSTs the bytes, and prints the **serving URL**:

```bash
scripts/basemap/upload.sh scripts/basemap/.scratch/vermont-basemap.pmtiles          # dev
scripts/basemap/upload.sh scripts/basemap/.scratch/vermont-basemap.pmtiles --prod   # prod
```

Loads the **dev** deployment unless you pass `--prod` (dev first — confirm the map renders
before touching prod, same rule as the ETL loader). It prints the resolved deployment and, at
the end, the `VITE_PMTILES_URL` value to wire in step 3.

> **Cost / scale.** Convex bills file-storage egress, but `pmtiles://` range-reads only the
> viewed tiles per map view (KBs), so pilot bandwidth is negligible and 280 MB sits well under
> the free-tier storage cap. If per-tile egress grows as regions expand, **Cloudflare R2**
> (zero egress, the standard pmtiles host) is the documented scale-out target — a
> `VITE_PMTILES_URL` swap, nothing in the app. See `plans/phase-1-water-bodies.md` open items.

## 2b. Host on Cloudflare R2 (Phase 2.5+ — the scale-out host)

Convex file storage (§2) is fine for the ~280 MB Vermont file, but the multi-state **Phase 2.5**
extract (~1.3–2 GB) overflows the Convex free tier, so the regional basemap hosts on **Cloudflare
R2** (zero egress; the standard pmtiles host). R2 is the primary host going forward; `upload.sh`
(Convex storage) stays for the Vermont-only/legacy path. Full context: the
[Phase 2.5 runbook](../../plans/phase-2.5-regional-expansion.md).

### One-time setup

1. **Bucket** — create an R2 bucket named `skating-basemap`.
2. **API token** — R2 → *Manage API Tokens* → **Object Read & Write**, scoped to that bucket. Note the
   Access Key ID, Secret, and your **account ID** (the hex in the S3 endpoint).
3. **rclone** — `brew install rclone`, then create a remote named `r2`:
   ```bash
   rclone config create r2 s3 provider=Cloudflare \
     access_key_id=… secret_access_key=… \
     endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com region=auto acl=private
   ```
   Verify with **`rclone ls r2:skating-basemap`** (empty output = OK). Note: `rclone lsd r2:` returns
   **403 by design** — `ListBuckets` is account-level and the token is bucket-scoped; that's the
   secure, expected result, not an error to fix. Credentials live in `~/.config/rclone/rclone.conf`,
   **never** in the repo.
4. **Script config** — `cp scripts/basemap/.env.example scripts/basemap/.env.local` and set
   `R2_PUBLIC_BASE_URL` (from public access, below). `.env.local` is gitignored and holds no secrets.

### Upload

```bash
scripts/basemap/upload-r2.sh .scratch/northeast-YYYYMMDD.pmtiles dev/northeast-YYYYMMDD.pmtiles
scripts/basemap/upload-r2.sh .scratch/world-z6-YYYYMMDD.pmtiles dev/world-z6-YYYYMMDD.pmtiles
```
Both archives, each to its own dated key. One bucket serves both environments via a `dev/` or `prod/` **key prefix**; dating the key makes a
rebuild a new object + a one-line env swap, with the previous object as instant rollback. The script
prints the serving URL to wire in §3.

### Public access — start on r2.dev

For the alpha, enable the bucket's zero-config public URL: bucket → **Settings → Public access →
r2.dev subdomain → Allow**. The base URL is `https://pub-<hash>.r2.dev` → put it in
`R2_PUBLIC_BASE_URL`. Good enough for a friends alpha (tile reads are KBs/view); r2.dev is
rate-limited and only lightly cached, so it is **not** for real traffic.

### Custom domain + caching (prod hardening — do before real traffic)

A custom domain fronts R2 with Cloudflare's CDN: no r2.dev rate limit and — the real win — **edge
caching of the `pmtiles://` Range reads** (many users hit the same tiles; served from the edge instead
of re-reading R2, cutting latency + R2 Class-B ops). This is Protomaps' recommended R2 setup.

1. **Add a domain/zone to this Cloudflare account** — register one in Cloudflare, or add an existing
   domain and point its nameservers at Cloudflare. *(This account has no zone yet — this is the
   gating step; everything below is a few minutes once it's here.)*
2. **Attach it to the bucket** — bucket → **Settings → Custom Domains → Connect Domain** →
   e.g. `tiles.<yourdomain>`. Cloudflare auto-creates the DNS record + TLS cert. Disable the r2.dev
   URL once the custom domain resolves.
3. **Cache the tiles** — Rules → **Cache Rules** → new rule matching the `tiles.<yourdomain>` host →
   *Eligible for cache*, with a long **Edge TTL** (tiles are immutable per dated key, so a month+ is
   safe — a rebuild uses a new key). Cloudflare caches Range/partial responses, which is what pmtiles
   needs.
4. **Repoint** `R2_PUBLIC_BASE_URL=https://tiles.<yourdomain>` in `.env.local` and re-run the §3 env
   swap. **No app code change** — same env var.

### CORS (web only)

The browser `pmtiles://` protocol needs CORS + `Range` on the tile host (mobile native does not — it
reads over its own HTTP stack). Add a CORS policy on the bucket (R2 → bucket → **Settings → CORS
Policy**), listing your dev + prod web origins:
```json
[{ "AllowedOrigins": ["http://localhost:3000", "https://<your-web-origin>"],
   "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["Range"],
   "ExposeHeaders": ["Content-Range", "Content-Length", "ETag", "Accept-Ranges"],
   "MaxAgeSeconds": 86400 }]
```
R2 serves `Range` natively; this only authorizes the browser to read it cross-origin.

## 3. Wire — four env vars, two per surface

The serving URLs are **deployment-specific** (dev vs prod differ) and there are now two of them per
app, so they are env vars rather than code:

| Var | Archive | Blank means |
| --- | ------- | ----------- |
| `VITE_PMTILES_URL` / `EXPO_PUBLIC_PMTILES_URL` | regional | web falls back to the Protomaps demo build; **mobile release builds refuse to render**, on purpose |
| `VITE_WORLD_PMTILES_URL` / `EXPO_PUBLIC_WORLD_PMTILES_URL` | world overview | single-source style: the map renders, and stops dead at the regional archive's edge |

- **Local dev:** `apps/web/.env.local` and `apps/mobile/.env.local`.
- **Production:** the Vercel project env (web) and the EAS environment (mobile — env vars live in
  EAS environments, not in `.env.local`).
- **No demo fallback for the overview**, deliberately: the Protomaps demo build *is* a whole planet,
  so falling back to it would render the same archive twice.

Then reload the map. Attribution ("© OpenStreetMap contributors") is unchanged — it rides on both
sources and the always-on `AttributionControl`, independent of the tile host.

---

## Last build (record yours here)

**Two-archive Northeast (2026-08-05) — current:**

| Field | Value |
| ----- | ----- |
| Built | 2026-08-05 |
| Source | `https://build.protomaps.com/20251215.pmtiles` (Protomaps whole-planet, live dated build) |
| Region archive | `--region=region.geojson` / maxzoom `14` — **458 MB**, 129,239 tile entries, z0–14 |
| World archive | no bbox / maxzoom `6` — **43 MB**, 3,380 tile entries, z0–6 |
| Region shape | five TIGER states, whole (New York renders in full; the corpus still stops at I-84) |
| Hosted | R2 `skating-basemap/dev/northeast-20260805.pmtiles` + `dev/world-z6-20260805.pmtiles` (dev) — prod pending |
| Verified | `pmtiles verify` clean on both; z12 probes return 61 KB over Burlington and **0 bytes** over Hartford, Philadelphia and Montréal |

**Single bbox extract (Phase 2.5) — superseded, and the reason the above exists:**

| Field | Value |
| ----- | ----- |
| Built | 2026-07-15 |
| bbox / maxzoom | `-79.9,41.2,-66.8,47.5` / `14` |
| Size | ≈ 948 MB, 275,750 tiles, z0–14 |
| Why replaced | a rectangle rendered Ontario and Connecticut in full, and ended the world at 41.2°N |

**Vermont-only (Phase 1) — superseded:**

| Field | Value |
| ----- | ----- |
| Built | 2026-07-13 |
| bbox / maxzoom | `-74.5,42.0,-70.5,45.9` / `14` |
| Size | ≈ 280 MB, z0–14 |
| Hosted | Convex **dev** storage (`agile-bee-397`) |
