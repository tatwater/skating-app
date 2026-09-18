# Imagery and weather vendors — the A06c evaluations (2026-07-30)

> **Research — moved verbatim from `05-accounts-and-credentials.md` on 2026-09-17**, when that doc
> became the credentials register. These are the cost / benefit / setup evaluations that fed D75,
> D84 and D147; the decisions they produced are summarized in `04-integrations.md` § Imagery and
> § Weather. Nothing here is current status — for that, read the register.
>
> Two things settled since this was written: A06e reads Sentinel-2/-1 from **AWS Earth Search**
> anonymously, so the Copernicus Data Space account in §14 was never created or needed; and the
> NAIP correction in §14b (`USGSNAIPPlus`, not `USGSImageryOnly`) is what the shipped reveal uses.

## The four evaluations

Founder ask: record cost, benefit and setup for the providers we evaluated during A06c scoping, so the
"why not" is checkable and the "when" has a trigger. All three decisions are D75 unless noted.

### 14. Satellite imagery — **Copernicus Data Space** 🆓 (D75)

**The decision:** deep-link now (no account), integrate later (free account, quota-bound).

- **License — this is the part that unblocked a deferred roadmap item.** Copernicus Sentinel data is
  under the **free, full and open Copernicus license**: reproduce, distribute and adapt, with
  attribution. The roadmap parked the satellite-imagery layer for want of *"an imagery source whose
  terms permit the use"* — that question is now answered, and what remains is cost, not permission.
- **Tier 1 — the deep link (A06c, ships now): 🆓, no account, no quota.**
  <https://browser.dataspace.copernicus.eu/> with lat/lng/zoom + a ~14-day Sentinel-2 L2A window.
  Nothing to set up. ⚠️ Verify the query-param shape against the live browser at build time — it's the
  one URL format we don't control.
- **Tier 2 — imagery in the app (deferred): 🆓 registration**, Sentinel Hub–compatible OGC/Process APIs.
  - **Free-tier quota: 10,000 requests + 10,000 processing units per month; 300/min.**
  - A full-screen tile view is ~10–20 requests ⇒ only **~500–1,000 water body views/month** raw. Not enough
    for general use.
  - **Server-side tile caching is what makes it viable**, and the open license permits it: a popular
    body is viewed many times but only needs fetching once per **~5-day** satellite revisit. That turns
    the quota from per-view into per-body-per-week, which fits comfortably.
  - **Benefit:** 10 m resolution is enough that open water vs. black ice vs. snow-covered ice is
    visually obvious. Cloud cover is the real limiter, not resolution.
  - **Do this when** we know which handful of bodies get real traffic — caching only wins if reads
    concentrate. A06c's proving run (§2.3a) is what starts producing that evidence.
  - **→ Now scoped as [A06e](../phases/A06e-satellite-imagery.md) Workstream 3 (D84, 2026-07-31)**, where it
    is **Tier 2** of a two-tier split. Everything above still holds — but it is no longer what gates the
    satellite toggle, because Tier 1 doesn't need an account at all:

### 14b. Aerial imagery — **USGS / The National Map (NAIP)** 🆓 — **no account** (D84, corrected by D147)

**The tier that actually ships the reveal**, and it needs nothing set up.

> ⚠ **Corrected 2026-08-21, against the live services.** This entry previously named the
> `USGSImageryOnly` tile service at "~0.6 m". Both halves were wrong, and the error was load-bearing —
> it is what let A06e's original scoping promise a skater the gap in the trees and the path to the shore.

- **Use `imagery.nationalmap.gov`'s `USGSNAIPPlus` ImageServer** — `pixelSizeX: 0.3`, CORS `*`, no key.
  It is an **ImageServer, not a tile cache**, so there is no `/tile/` endpoint; MapLibre's
  **`{bbox-epsg-3857}`** token makes `exportImage` a drop-in raster source. Verified returning a 256×256
  JPEG at a z18 extent over Burlington in which individual cars are countable.
- **Not `basemap.nationalmap.gov`'s `USGSImageryOnly`.** Its `maxScale` is 9027.977411 — **ArcGIS level
  16** — and z17+ returns a hard **404** rather than upsampling. At 44.5°N that is **~1.7 m/px on the
  ground**: enough to see that a clearing is a parking lot, not enough to count spaces. Its own service
  description says *"1 meter pixel resolution"* and *"visible to the 1:9,028 zoom scale."* Keep it only
  as a cheap low-zoom floor.
- **NAIP is an airplane, not a satellite,** and this is the fact that shapes the phase: flown on a
  **2–3 year per-state cycle, deliberately in mid-summer** for the USDA's crop program. **No NAIP frame
  will ever show ice.** Burlington's current scene is `m_4407339_ne_18_030_20230621` — the summer
  solstice, 2023.
- **The acquisition date is queryable per water body**, which is what makes an honest date stamp possible:
  `USGSNAIPPlus/ImageServer/identify?…&returnCatalogItems=true` returns the source scene with
  `acquisition_date` in epoch ms. One cached call per body.
- **Public domain.** USDA/USGS federal imagery: **no account, no key, no quota, no license review.**
- **Cost: €0**, with no tier to outgrow.
- **What it's for:** reading *access*, not ice — which is why it pairs with A06d rather than the weather
  work.
- **The thing to watch is courtesy, and it's sharper than it was:** `USGSNAIPPlus` renders every request
  dynamically with no CDN in front. v1 points at it and measures; the caching proxy is **the same
  infrastructure the Sentinel timeline needs** (D148), so it gets designed once.
- **Attribution string, read off the service:** `USDA, USGS The National Map: Orthoimagery. Data
  refreshed June, 2024.`
- ⚠ **Confirm at build:** ArcGIS tile axis order is `/tile/{z}/{y}/{x}` (**y before x** — a swapped pair
  404'd in testing, but that is luck of the coordinate; elsewhere it returns tiles, just the wrong ones).

### 15. Windy — 💰 **evaluated and declined** (D75)

**The decision: link out (in-app browser on mobile), do not buy the API.**

- **Cost, confirmed against their pricing pages (2026-07-30):**
  | Product | Free "Testing" tier | Professional |
  |---|---|---|
  | **Map Forecast API** | 500 sessions/day, **GFS only**, 3 layers, *"development purpose only, not intended for production"* | **€990/year** (+ **€1,000** for ECMWF), 10,000 sessions/day, 40+ layers |
  | **Point Forecast API** | 500 requests/day, and it **returns randomly shuffled and slightly modified data** | **€990/year**, 10,000 requests/day, ECMWF excluded by license |
  *(Priced per product — using both looks like ~€1,980/yr. Confirm with them before assuming a bundle.)*
- **The blocker is technical, not financial.** The Map Forecast API is, in their words, *"a simple-to-use
  library based on Leaflet 1.4.x"* and is tightly coupled to it. **We render MapLibre.** There is no way
  to overlay Windy's animated layers onto our map — buying it means embedding *their entire map*
  alongside ours, i.e. shipping a second map engine.
- **The free tier cannot be used anyway** — dev-only for the map API, and deliberately corrupted data for
  the point API.
- **What we do instead:** open `windy.com/?<lat>,<lng>,<zoom>` through **`expo-web-browser`** on mobile
  (D76), which delivers the founder's actual goal — Windy's animation, over our app, with a Done button —
  for €0 and one line of code. Web opens a new tab.
- **The Point Forecast API is separately unnecessary**: it duplicates what Open-Meteo already gives us
  for free, and D74 says one physics source regardless.
- **Trigger to revisit:** we want animated weather *inside* our own map canvas AND a MapLibre-compatible
  path exists (their product, or a raster-tile endpoint). Absent that, more money doesn't buy a
  different answer.

### 16. Planet — 💰 **evaluated and deferred** (D75)

**The decision: wait. Revisit only on evidence.**

- **Cost: not publicly listed — quote-based via sales.** Their pricing page carries no figures. Assume a
  commercial subscription scoped per area-of-interest; budget a real conversation, not a signup.
  *(They also run an Education & Research program; we are not academic, so it doesn't apply.)*
- **What money does *not* buy.** Planet's public-data catalog — Sentinel-1, Sentinel-2 L1C/L2A,
  Landsat 4–9, HLS, Copernicus DEM — is **the same free data we can get directly from Copernicus**.
  Paying does not unlock it.
- **What money *does* buy: PlanetScope — ~3 m, near-daily revisit.** For ice this is a genuine product
  difference, not a vanity upgrade: a water body can go from open water to skateable in 48 hours, and a 5-day
  revisit can miss the entire onset. Worth being honest that the case here is real.
- **Why not yet:** it's a commercial imagery subscription against a pilot with no revenue, and **we do not
  yet know whether anyone opens the imagery link at all.**
- **Low-regret detail:** Planet serves its public data from **Sentinel Hub endpoints**
  (`services.sentinel-hub.com`) — the same API surface as the Copernicus Data Space. Building against
  Copernicus now is *not* a lock-out; it's the same client either way.
- **Trigger to revisit:** the free Copernicus link sees real usage **and** we hit a case where the 5-day
  revisit demonstrably missed a freeze event.
