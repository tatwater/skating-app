# basemap — self-built Vermont `.pmtiles` (Phase 1, PR#5)

The read-only web map (`apps/web`) renders our OSM water bodies over a **Protomaps** vector
basemap (D6). Phase 1 shipped against Protomaps' **hosted demo** tiles (a whole-planet
`.pmtiles`) to confirm the data renders; Protomaps asks that the demo bucket **not** be used in
production. This directory is the manual, run-on-demand pipeline that **builds a Vermont-only
`.pmtiles` and self-hosts it**, so we stop depending on the demo bucket.

Like [`scripts/etl`](../etl/README.md), this is **not** built or deployed with the apps — you
run it by hand when (re)building the basemap. There is no logic to test here: the build is one
`pmtiles` command and the host step is `upload.sh` (thin glue over the Convex CLI + `curl`).

> **Why this stays a config swap.** The web map reads the tile URL from `VITE_PMTILES_URL`
> (falling back to the demo). So "swap the basemap" is: build the file → upload it → set that
> env var. No app-code change (see `apps/web/src/lib/waterMap.ts`).

---

## Prerequisites

| Tool | Install | Role |
| ---- | ------- | ---- |
| [`pmtiles`](https://docs.protomaps.com/pmtiles/cli) | `brew install pmtiles` | Extract a bbox subset from a source `.pmtiles` over HTTP range reads. |
| Convex CLI | already in the workspace (`pnpm exec convex`) | Mint an upload URL + resolve the serving URL. |

---

## 1. Build — extract Vermont from a Protomaps planet build

`pmtiles extract` reads **only the tiles inside the bbox** from a remote source over HTTP range
requests (no full download, no API key), writing a small regional `.pmtiles` in the **same
Protomaps v4 schema** the web style (`@protomaps/basemaps`) already targets — so the tiles are
identical to what the demo renders, just self-hostable.

```bash
mkdir -p scripts/basemap/.scratch
pmtiles extract https://demo-bucket.protomaps.com/v4.pmtiles \
  scripts/basemap/.scratch/vermont-basemap.pmtiles \
  --bbox=-74.5,42.0,-70.5,45.9 \
  --maxzoom=14
pmtiles verify scripts/basemap/.scratch/vermont-basemap.pmtiles
```

- **`--bbox` matches `VERMONT_MAX_BOUNDS`** in `apps/web/src/lib/waterMap.ts` (the area the map
  lets you pan to — Vermont + Lake Champlain's NY shore + a margin). Keep the two in sync so the
  basemap covers everywhere the user can pan; anything tighter shows blank tiles at the corners.
- **`--maxzoom=14`** is the fidelity/size trade: crisp through street + town-label detail, and
  MapLibre **overzooms** past 14 so you can still zoom to a single lake (the water polygons are
  our own layer and stay crisp regardless). z15 roughly doubled the file for building/label
  detail we don't need on a lake map. Result ≈ **280 MB** at z0–14.
- **Source.** The demo bucket `v4.pmtiles` is a whole-planet Protomaps build (what the app
  already renders), so extracting from it guarantees a visual match. For a *fresh/current*
  basemap instead, point `--bbox` extract at a dated Protomaps planet build, or build one
  locally with the [protomaps/basemaps](https://github.com/protomaps/basemaps) planetiler
  profile (heavier: it also pulls Natural Earth + water-polygon data). The demo-bucket extract
  is the pragmatic pilot choice.

The `.scratch/` dir is gitignored — the `.pmtiles` is **not committed** (too large; it lives in
Convex storage, below).

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
scripts/basemap/upload-r2.sh .scratch/northeast-basemap.pmtiles dev/northeast-YYYYMMDD.pmtiles
```
One bucket serves both environments via a `dev/` or `prod/` **key prefix**; dating the key makes a
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

## 3. Wire — set `VITE_PMTILES_URL`

The serving URL is **deployment-specific** (dev vs prod differ) — so it's an env var, not code:

- **Local dev:** put the *dev* serving URL in `apps/web/.env` (`VITE_PMTILES_URL=…`).
- **Production:** upload with `--prod`, then set `VITE_PMTILES_URL` to the *prod* serving URL in
  the Vercel project env (see `apps/web/README.md`). Unset → the app falls back to the demo
  bucket, which must not ship to prod.

Then reload the web map: the basemap is now served from Convex, identical tiles, no demo-bucket
dependency. Attribution ("© OpenStreetMap contributors") is unchanged — it's driven by the
water source + the always-on `AttributionControl`, independent of the tile host.

---

## Last build (record yours here)

**Northeast 5-state (Phase 2.5) — current:**

| Field | Value |
| ----- | ----- |
| Built | 2026-07-15 |
| Source | `https://build.protomaps.com/20251215.pmtiles` (Protomaps whole-planet, live dated build) |
| bbox / maxzoom | `-79.9,41.2,-66.8,47.5` / `14` (matches `NORTHEAST_MAX_BOUNDS`) |
| Size | ≈ 948 MB (993,960,944 bytes), 275,750 tiles, z0–14 |
| Hosted | Cloudflare **R2** `skating-basemap/dev/northeast-20260715.pmtiles` (dev) — prod pending |

**Vermont-only (Phase 1) — superseded by the above:**

| Field | Value |
| ----- | ----- |
| Built | 2026-07-13 |
| Source | `https://demo-bucket.protomaps.com/v4.pmtiles` (Protomaps whole-planet v4) |
| bbox / maxzoom | `-74.5,42.0,-70.5,45.9` / `14` |
| Size | ≈ 280 MB (293,673,672 bytes), z0–14 |
| Hosted | Convex **dev** storage (`agile-bee-397`) |
