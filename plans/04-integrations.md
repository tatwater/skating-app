# Data sources & integrations

What the app **reads from and writes to**: every third-party dataset and API, grouped by what it
feeds, with the license, the quota, where the raw copy is archived, and the alternatives that were
considered beside it. The stack itself (frameworks, vendors we run on) is
[`03-tech-stack-options.md`](./03-tech-stack-options.md); account setup and keys are
[`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md); the story of how the sources
become one record per water body is [`docs/water-body-data.md`](../docs/water-body-data.md); the
runbooks are each `scripts/*/README.md`.

One idea governs the whole register: **a source makes a claim; the record is ours.** We mint the
identifier, every catalog attaches a claim to it, and every claim carries its provenance — which is
why the drawer can say "state survey" or "estimated" next to a number instead of just the number.

---

## Attribution register

Attribution is a build-time acceptance criterion, the same class of obligation as a test. Each row
is rendered where the data appears; the legal side is `08-legal-feasibility-checklist.md` (L7, L10,
L13).

| Source | Obligation | Rendered |
| --- | --- | --- |
| OpenStreetMap (outlines, boundaries, access features, the basemap) | **ODbL** — "© OpenStreetMap contributors", linked; share-alike bites only if we *publish* the derived database (L10) | every map view, as plain text — the copyright link is owed (register: *Data credits the apps don't render*) |
| Open-Meteo | attribution; free tier is **non-commercial** (L13, D158) | every weather strip and panel |
| Copernicus Sentinel data | free, full and open **with attribution** ("Contains modified Copernicus Sentinel data") | the imagery reveal and scrubber |
| Each bathymetry agency | the credit line in its service descriptor (`copyrightText`), captured in the manifest and re-verified by `bathymetry verify`; VCGI's "Soundings digitised from NOAA nautical charts…" is an agreed wording | the contour layer's credit |
| ALSC, NYSDEC CSLAP | **no published terms** — credited, never assumed permissive (L16) | the depth line's source |
| Strava | brand guidelines wherever Strava is named: "Powered by Strava", the official "Connect with Strava" asset, approved marks (L7) | the connect / push surfaces |
| US federal (NHD, 3DHP, GNIS, 3DEP, NAIP, NWS, TIGER), Natural Earth, GLOBathy (CC0) | public domain — credit as courtesy | NAIP and NWS rendered; GLOBathy as the depth label; NHD / 3DHP / GNIS / TIGER / Natural Earth / 3DEP not yet (courtesy; register) |
| HydroLAKES, LAGOS-US | CC-BY 4.0 | the depth line names the dataset; the CC BY credit (`requiredDepthCredits`) is not rendered yet (register) |
| NREL WIND Toolkit | open data, API key; credit as courtesy | not yet — the wind rose names the grid cell, not NREL (register) |

---

## What feeds what

### Water body outlines, names, classification

| Source | Role | Refresh | Archive |
| --- | --- | --- | --- |
| **OpenStreetMap** via per-state [Geofabrik](https://download.geofabrik.de/) extracts | outlines (draws the body by default), local names, tags → our `type` | any time; `osmium` + GDAL, `scripts/etl` | `.scratch/` + R2 mirror |
| **USGS NHD** (National Hydrography Dataset) | authoritative classification, federal IDs, completeness | **frozen since 2023** — never refreshed | `prd-tnm.s3.amazonaws.com` snapshots, mirrored |
| **USGS 3DHP** | NHD's successor; measured as *the same data* (7,878 lakes, zero disagreements) so it gets one vote, not two | annual | as NHD; also queried **live** (`hydro.nationalmap.gov`) to resolve an A07b *admit* request against the catalog |
| **USGS GNIS** | the official name and the ID that ties spellings together; points, not shapes | annual | as NHD |

Merged by `scripts/etl` into one record per body with our own key (D93), best-of-both per field (D94),
one admission floor applied once (D109/D110); every loader replays the merge's path from
`merge-manifest.json` (provenance is the default). Refused bodies are logged, never silently dropped.

*Considered:* **Overpass API** for OSM — rejected for extracts, which are reproducible, archivable
and don't rate-limit a five-state pull. **NHD as the outline** — the D92 bake-off against OSM over
2,359 lakes with real depth soundings was a dead heat (63% ties); OSM stays by the cheaper-pipeline
tie-break, chosen *per lake* where one catalog contains a named bay the other excludes.

### Boundaries, the region, and the basemap

| Source | Role |
| --- | --- |
| **OpenStreetMap** `boundary=administrative` relations (same Geofabrik extracts) | `adminAreas` — the town / county / state a report's point resolves to (`scripts/admin-areas`) |
| **US Census TIGER** state polygons (`www2.census.gov`) | the five-state region polygon the basemap is clipped to, and the out-of-region mask |
| **Natural Earth** 10 m countries + lakes (`naciscdn.org`) | the sea / land / big-lake layers of the mask, so the map has an ocean beyond the region |
| **Protomaps** whole-planet builds (`build.protomaps.com`, dated) | the two self-extracted `.pmtiles` archives — world z0–6 and the region at full detail (`scripts/basemap`) |

*Considered:* the Protomaps hosted demo bucket — dev-only, rotates and 404s; never in production.

### Elevation

| Source | Role | Coverage |
| --- | --- | --- |
| **USGS 3DEP** via the Elevation Point Query Service (`epqs.nationalmap.gov`) | one reading per body at its interior point; keyed on the rounded coordinate so it survives a corpus rebuild | 99.5% of the corpus, **98.2% at 1 m LiDAR**; no key, no documented cap, ~1.5 h for the corpus |

*Replaced (D127):* **Open-Meteo's elevation endpoint** (Copernicus GLO-90, 90 m) — it shared a
quota with the app's own weather calls, and it was 90× coarser. The archive on R2 means re-deriving
anything from it costs minutes and zero requests.

### Depth — a ranked ladder (D68)

Every depth carries its source, and the drawer says *measured* or *estimated* accordingly.
`scripts/lake-depth` is the runbook; 81% of the depths shown are measured.

| Rung | Source | Basis | Gives | License |
| --- | --- | --- | --- | --- |
| 1 | operator entry (`/admin/water/:id`) | a published chart or local knowledge | mean + max | — |
| 2 | **state agency surveys** (the bathymetry sources below, read as soundings) | a boat and a depth sounder — 3,033 measurements | max (+ mean where surveyed) | per agency |
| 3 | **NYSDEC CSLAP** (Citizens Statewide Lake Assessment Program) | volunteer sampling through 2024; 278 lakes | mean only | no published terms |
| 4 | **LAGOS-US DEPTH v1.0** (EDI) | ~65 compiled monitoring programs; > 1 ha | 17,675 max · 6,137 mean | CC BY 4.0 — the fetcher refuses to run if the served rights statement differs (L16) |
| 5 | **Adirondack Lakes Survey** 1984–87 | one survey, 1,345 ponds, pre-GPS coordinates (depth only — the coordinates are ±340 m) | max + mean | no published terms; scraped once, serially, archived |
| 6 | **HydroLAKES v1.0** `Depth_avg` | volume / area; ≥ 10 ha | mean | CC-BY 4.0 |
| 7 | **GLOBathy** `Dmax` | a random forest over shoreline / area / elevation; validated on 1,503 lakes globally | max | CC0 |

**The floor is the sources', not ours.** Every global dataset stops near 25 acres; below that nobody
surveyed the pond, and our stored coverage tracks the sources to within 1–2 points per size band.

### Bathymetry contours (A06b)

Five agency sources across four states, archived byte-for-byte with a manifest each
(`scripts/bathymetry`, [`PROVENANCE.md`](../scripts/bathymetry/PROVENANCE.md) is the committed
record). Published isobaths are drawn as the agency's; where only soundings exist we interpolate,
and those render and are labeled as ours.

| State | Source | Lane |
| --- | --- | --- |
| MA | MassGIS / MassWildlife inland bathymetry (FeatureServer) | contours |
| ME | Maine DEP / IF&W lake soundings (MapServer) — two datasets in one schema, and a 3.3 ft/m unit trap | soundings |
| NH | NH GRANIT | contours |
| VT | VCGI / NOAA Lake Champlain soundings (covers the whole lake, New York shore included) | soundings |
| VT | VT ANR BioBase soundings | soundings |
| NY | **no statewide source exists** — a checked finding, not a gap to close by working harder | — |

*Considered:* contours from **GLOBathy rasters** — ruled out; the modeled surface has no bottom
detail to contour. Massachusetts' archive turned out to hold 265 lakes, all already used.

### Wind (A06c)

| Source | Role |
| --- | --- |
| **NREL WIND Toolkit** (2 km WRF, hourly, 10 m) — Dec–Mar of 2010–2014, five winters, `developer.nlr.gov` API key | a 16-sector winter rose per body plus strong-wind hours per sector; 47,765 cell-years archived on R2, 11,114 roses |

*Considered:* the **Global Wind Atlas** — 250 m and sees more terrain, but its public API paths
return the site's HTML shell, its climatology is annual (December wind is not July wind), and its
downloadable layers are combined *across* sectors — there is no directional layer to build a rose
from.

### Access — put-ins, parking, the walk in (A06d)

| Source | Role |
| --- | --- |
| **OpenStreetMap** `leisure=slipway` / `waterway=slipway`, `amenity=parking` (+ `parking=*`, `access=*`, `fee=*`, `capacity=*`), `highway=path` / `route=hiking` — a second `osmium` pass over the same extracts | put-in candidates, parking areas, trails; 3,588 put-ins, 11,375 lots |
| **OpenRouteService** `foot-hiking` (the Phase 04 account; ETL-time, once per put-in, cached on the row with geometry since A06e §0) | routed distance and ascent from the lot to the water; straight-line is the flagged fallback |
| **Operator-drawn approaches** | where routing can't reach |

*Considered:* **GraphHopper** (a second vendor and key for nothing ORS lacks), **Valhalla**
self-hosted (a server), **Mapbox Directions** (`walking` only, tuned for sidewalks), **AllTrails /
Gaia** (licensed trail content, no point-to-point API). A **NYSDEC** scrape of posted rules was sized
and not built (A06e).

### Weather

| Source | Role | Boundary |
| --- | --- | --- |
| **Open-Meteo** forecast API with `past_days` (up to 92 back), hourly; two-tier grid cache key (D152), durable past-weather archive (D153); a corpus-wide daily cron on 3,043 cells | the weather-since strip, the D56 decay multiplier, the bounty gate, the past panel, the hourly timeline, the seven-day planner, weather-first discovery (D159); the short forward forecast rides the same call (D140) | **the single source for anything that feeds a calculation** — one deterministic, re-fetchable input |
| **NWS** `api.weather.gov` active alerts, polled per state every 15 min | the advisory strip — winter-storm, ice-storm, wind-chill warnings | **informs, never computes** (D74); never blended with Open-Meteo. US-only |

The *past_days* endpoint, not the historical archive: the archive is ERA5-backed with a ~5-day lag,
and every window we need is recent. The hourly variable set and the reducer that both consumers read
are in [`phases/10-weather.md`](./phases/10-weather.md) § 2 and
[`docs/weather-since.md`](../docs/weather-since.md).

*Considered:* **OpenWeatherMap**, **Tomorrow.io** — keyed and paid-leaning for data Open-Meteo gives
away. **MerrySky** — a frontend over Pirate Weather and Open-Meteo; the same data with no API to buy.
**Windy** — its Map Forecast API is Leaflet-only and can't overlay MapLibre, so we open
`windy.com/?lat,lng,zoom` in the in-app browser (D75/D76) for €0. **Radar** — MRMS with its Radar
Quality Index, cut on the Fly→R2 pattern (D157), is A06h's deferred Workstream 6; RainViewer and the
Iowa Environmental Mesonet were evaluated for it (their terms are in L13). **Paying Open-Meteo** is a
season-two decision with a written trigger (D158).

### Imagery (A06e)

| Source | Role | Terms |
| --- | --- | --- |
| **Sentinel-2 L2A** and **Sentinel-1 GRD** via **AWS Earth Search** (`earth-search.aws.element84.com`, anonymous STAC; S1 from the AWS open-data bucket) | a season of passes per body, cut to its outline on Fly, published as masked raster PMTiles on R2; the freeze-up scrubber | Copernicus: free, full, open, with attribution; AWS open data: no account |
| **USGS / The National Map — NAIP** (`imagery.nationalmap.gov`, `USGSNAIPPlus` `exportImage`, behind CloudFront) | the aerial reveal — 0.3 m summer orthoimagery (D147), for reading *access*, never ice; web only — mobile has no aerial tier (register) | public domain, no key, no quota; grid-snap every URL (a 29 s cold render otherwise) |

*Considered:* **Copernicus Data Space (CDSE)** — serves both missions from one place, but needs an
account, sits in Europe, and Earth Search needed neither; the Sentinel Hub–compatible API's 10k
requests/month only works with server-side caching, which is what R2 is. **Planet** — same free
catalog; only PlanetScope (~3 m, near-daily) is new. **Its price is not public** — quote-based via
sales, scoped per area of interest as an annual subscription, not per capture; the smallest
commercial tiers are understood to start in the low thousands of dollars a year (⚠ unverified —
get the quote before treating that as a number). The case for it is real (a body can go from open
water to skateable in 48 h, and a 5-day revisit can miss the whole onset), so it's *deferred*, not
rejected: the trigger is the free imagery seeing real use **and** a freeze event the revisit
demonstrably missed. Full entry: [`research/imagery-and-weather-vendors.md`](./research/imagery-and-weather-vendors.md)
§ 16. **Esri World Imagery**
(off-platform use restricted), **Mapbox / Maxar** (metered per tile), **state orthoimagery** (five
integrations for a marginal gain over 0.3 m), **tasked commercial imagery** (~$200–400 per body per
capture). The physics is the real limit (D147): NAIP will never show ice, and 10 m Sentinel can't show
a 1–3 m ridge.

### Drive time (Phase 04)

**OpenRouteService** isochrones, hosted, cached per user (D18) — three bands, with 60 → 90 min as a
radius because hosted ORS caps the isochrone. Quotas are per endpoint (~2,000 directions/day, 40/min;
out-of-quota is a 403), so an ETL can't starve the app. Self-hosting is a backlog item
(`backlog/self-hosted-ors.md`).

### Geocoding — wanted, not yet chosen

Nothing geocodes today: home is set from device geolocation, report location from the map or the
GPS path. The **location anchor** ([`backlog/location-anchor.md`](./backlog/location-anchor.md),
Q17) — search from home, from an address you'll be at, or from here — is the first feature that
needs an address → coordinate step, and the volume is tiny: once per anchor a skater sets, never per
view.

| Option | Shape | Terms / notes |
| --- | --- | --- |
| **Photon** (komoot's public instance) | OSM-backed, typo-tolerant, no key | public instance asks for fair use, no hard published quota; self-hostable if it ever matters |
| **Nominatim** (OSM public) | OSM-backed, no key | usage policy: ≤ 1 req/s, identifying User-Agent, **no autocomplete** against the public instance — fine for "geocode this address once" |
| **MapTiler / Stadia / Geoapify** geocoding | hosted, keyed | free tiers well above our volume; a key in the client; the same vendors we declined for tiles |
| **Mapbox / Google** | hosted, keyed | metered and proprietary; Google's terms also restrict displaying results on a non-Google map |
| **OpenRouteService** `/geocode` (Pelias) | the account we already have | Pelias-backed, keyed, in the existing quota family |

**Leaning:** a Pelias/Photon-class OSM geocoder, keyed, called from a Convex action (never the
client), result cached on the anchor; **ORS's `/geocode`** is the zero-new-vendor option and is
probably where to start. Autocomplete-as-you-type is a different product (and a different quota) from
geocode-on-submit; the anchor needs the latter. *Considered and out:* Google Places (terms +
metering).

### Community references (D70/D71)

Not data we ingest — links we generate at render time, so every body has them: the **Nordic Skater**
and **Lake Ice** sites, the **Catamount Hardware atlas**, and a pre-canned search into the regional
community's own archive for the body you're looking at. The skater lands on their site under their
terms; we store nothing.

---

## Outbound and user-facing integrations

### Strava — push only (`activity:write`), D24 as amended, L7

The Strava API Agreement was read on 2026-07-24 and settled the shape: **displaying one athlete's
data to any other user is forbidden, even public data, and AI/ML use is banned.** So Strava can never
feed the map. What it can do is receive: a skater records here (or imports a GPX), the track is ours
to draw and aggregate under our own privacy model (D58), and the app **pushes** it to the skater's own
Strava so recording here costs them nothing they already had. Built in Phase 08 — OAuth via
`convex/http.ts` and `oauthStates`, the upload action, a sandbox upload still owed.

**Brand checklist** (build-time acceptance criteria; re-verify against current guidelines before launch):
- [ ] "Connect with Strava" uses Strava's official button asset — never hand-rolled. *(Still a
      text button in brand orange; register: *Data credits the apps don't render*.)*
- [x] "Powered by Strava" wherever Strava is named as the destination (`StravaConnect.tsx`).
- [x] Marks in approved colors and clear space; no implied endorsement (`STRAVA_BRAND_COLOR`).
- [x] No competing segment / leaderboard features; respect storage and retention limits; delete on
      termination — N/A by construction (no Strava data is displayed); tokens are deleted on
      disconnect, though `/oauth/deauthorize` is not yet called (register).

**Cross-user display, the stance:** display comes from tracks *we own* — the native recorder, a GPX
the skater imported, or (later) a watch provider whose terms permit it — gated by D58
(publish-is-consent, minors out, put-in-gated endpoint clipping, opt-out; *not* k-anonymity, L14).
A native report never requires a path at all, so a missing one never stops anyone posting. Full
reasoning: [`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md).

### GPX import

A skater who already records with a watch or another app picks the file and files the report from
it. Unbuilt, pitched in the vision; scoped in
[`backlog/low-urgency-items.md`](./backlog/low-urgency-items.md). It's clean under L7 because the
*file* is the skater's own export, not a platform's API.

### Watch and health-platform adapters — deferred behind partner applications

Garmin, COROS, Polar, Apple HealthKit, Google Health Connect: all v1-scoped in principle (D24),
each an input adapter into the same track store, each integrated individually once its approval
lands — HealthKit first, since it needs none. The applications haven't been confirmed submitted; the
reminder, the per-provider setup notes, and the activity-type mapping are in
[`backlog/partnerships.md`](./backlog/partnerships.md). Fitbit is not a provider (Health Connect
doesn't reliably expose its routes; many Fitbit users already sync to Strava).

### Forum / Facebook bridging — Q8, L5

Turning the community's Google Group and Facebook posts into in-app reports is the most heavily
gated idea in the plan (no clean APIs, members-only groups, and a consent question before an access
one). The data model holds `imported` as a source; nothing is built. What *did* happen: a one-time
private corpus extraction as design input (L5a — vocabulary, the boost seed, the access and sub-area
signals), and the D71 search link above. Status and direction: [`02-open-questions.md`](./02-open-questions.md) § Q8.

**The bridge runs both ways.** The *outbound* half is Gli posting back to the email group(s) the
lake's region belongs to on behalf of the skater – so they keep contributing to the members of the
community who haven't switched, without writing it twice. It's a different legal shape: the skater's
own words, sent with their consent, under their name, to a list they're a member of. It's also the
network-effect lever: the most detailed, best-organized reports on the list arrive with *"posted from
Gli"* and a link to the water body, and people come to see where they came from. Unbuilt; belongs with
the inbound half in Q8 so the two are designed as one bridge. The mechanics are sketched in
[`backlog/email-group-bridge.md`](./backlog/email-group-bridge.md).

---

## Beyond the US

Almost every row above stops at the border: NHD, 3DHP, GNIS, 3DEP, NAIP, NWS and TIGER are US
federal. OSM, Open-Meteo, Sentinel and HydroLAKES are global. What a Québec expansion needs, and the
leaning, is [`02-open-questions.md`](./02-open-questions.md) § Q16.
