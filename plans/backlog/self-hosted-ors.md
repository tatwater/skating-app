# Self-hosted OpenRouteService — a true 90-minute isochrone band

> **Backlog — moved out of `07-roadmap.md` in the 2026-09-16 rewrite, verbatim.** Design sketch from the Phase 04 discussion (2026-07-17). A cost/ops decision, not a technical one; Fly is now the settled host for owned infrastructure (A06e, D148).

Phase 04 ships drive-time on the
  **hosted ORS**, whose isochrone API is hardcoded to a **60-min max range** for `driving-car` — so the
  90-min band is a uniform crow-flies radius fallback there. Self-hosting ORS (a memory-hungry JVM/Docker
  service loading an OSM routing graph — **cannot** run on Convex or Vercel; needs a persistent container
  with ~4–8 GB RAM on a small VM: Hetzner/Fly.io/Railway/Render, ~$15–50/mo; Cloudflare **not** required)
  lets us (a) raise the isochrone range for a **real 90-min (and beyond) band**, (b) drop the hosted
  free-tier daily quota + rate limits, and (c) tune the routing profile. Our actual load is trivial
  (isochrones computed only on home-address change, cached per user), so it's a single small **warm**
  instance, not a fleet — the graph build takes minutes, so it stays warm rather than cold-starting per
  request. **Do this when** the 90-min band's accuracy matters or hosted quota bites; until then the
  radius fallback is fine for the outer, aspirational ring. *(Context: Phase 04 discussion 2026-07-17.)*
