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

| Field | Value |
| ----- | ----- |
| Built | 2026-07-13 |
| Source | `https://demo-bucket.protomaps.com/v4.pmtiles` (Protomaps whole-planet v4) |
| bbox / maxzoom | `-74.5,42.0,-70.5,45.9` / `14` |
| Size | ≈ 280 MB (293,673,672 bytes), z0–14 |
| Hosted | Convex **dev** storage (`agile-bee-397`) — prod pending |
