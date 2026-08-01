# Bathymetry source provenance

> **Generated — do not edit by hand.** Run `pnpm --filter @skating/bathymetry provenance`.
>
> This is the committed record of an archive that isn't committed. `.raw/` holds hundreds of MB
> of third-party data and is gitignored; this file is how the repo still knows what we hold, when
> we captured it, and under what terms.

Generated 2026-08-01 · 5/5 sources archived · 312.4 MB total.

## Refreshing

Agencies republish independently, so **staleness is a per-state judgement** and refreshing is a
per-state action. Check first, then refresh only what moved:

```bash
pnpm --filter @skating/bathymetry verify              # two cheap requests per source, no payload
pnpm --filter @skating/bathymetry verify --state=NH   # or just one state

pnpm --filter @skating/bathymetry snapshot --state=NH --refresh   # re-capture that state
scripts/bathymetry/mirror-r2.sh push                              # then mirror it
pnpm --filter @skating/bathymetry provenance                      # then regenerate this file
```

A refresh **replaces** a snapshot. If you need the old one, pull it from the mirror first — the
mirror is `rclone copy`, never `sync`, so a previous push is still there.

## MA

### MassGIS / MassWildlife — `ma-massgis-contours`

| | |
| --- | --- |
| **Lane** | contours (state-surveyed) |
| **Native unit** | ft |
| **Vertical datum** | depth below surface at survey time |
| **Source page** | <https://www.mass.gov/info-details/massgis-data-masswildlife-inland-water-bathymetry> |
| **Endpoint** | `https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/MassWildlife_Inland_Bathymetry/FeatureServer/0` |
| **Credit we render** | MassGIS · MassWildlife (Massachusetts Division of Fisheries & Wildlife) |
| **Captured** | 2026-08-01 |
| **Records** | 27989 |
| **Files** | 57 · 218.9 MB |
| **Fingerprint** | `ca3c2500` |
| **Agency copyright at capture** | *(none published)* |

<details><summary>Field notes (traps found in the real data)</summary>

27,989 contour lines, integer DEPTH in feet, keyed per lake by NAME + PALIS_ID. Published as a live FeatureServer, so the plan's "shapefile-plus-TIFF zip" worry does not apply to the vector half — no download-and-unpack lane needed. Interval varies per lake (2/3/4/5 ft in the shallows, 5 ft steps deeper). `SHORE = 1` rows are the shoreline at DEPTH 0 — drop them.

</details>

## ME

### Maine DEP / MaineIF&W — `me-dep-soundings`

| | |
| --- | --- |
| **Lane** | soundings (we interpolate) |
| **Native unit** | ft |
| **Vertical datum** | depth below surface; per-point surface elevation carried in SURFELVM/SURFELVF |
| **Source page** | <https://www.maine.gov/geolib/> |
| **Endpoint** | `https://gis.maine.gov/mapservices/rest/services/dep/MaineDEP_Lakes_Data/MapServer/2` |
| **Credit we render** | Maine Department of Environmental Protection · Maine Dept. of Inland Fisheries & Wildlife |
| **Captured** | 2026-08-01 |
| **Records** | 147755 |
| **Files** | 31 · 5.5 MB |
| **Fingerprint** | `30011987` |
| **Agency copyright at capture** | *(none published)* |

<details><summary>Field notes (traps found in the real data)</summary>

147,755 depth POINTS over 5,000+ lakes, grouped by MIDAS (Maine's lake id) — so the per-lake split needs no spatial work. TWO findings that change the plan: (1) the IF&W depth maps the plan calls "PDFs, a digitisation project, not an ETL" HAVE ALREADY BEEN DIGITISED by the state — those are the FMSRC=depthmap rows (FMPROCSS=dig, FMSRCORG=meifw). (2) This layer is TWO datasets wearing one schema, and FMSRC tells them apart: `depthmap` rows are digitised IF&W map soundings, `gpscarrier`/`gpsrec` rows are Maine DEP depth-sounder tracks. UNIT TRAP: DEPTHM was computed with a 3.3 ft/m constant, not 3.28084 — DEPTHM * 3.3 lands on a whole foot for the depthmap rows, DEPTHM * 3.28084 does not. So the published DEPTHF is systematically 0.58% shallow and must NOT be read as-is. Recover feet as DEPTHM * 3.3 for depthmap rows; the GPS rows are genuine metre readings and convert normally. Density IS the concern here: ~29 points per lake on average, against Vermont's ~37,000.

</details>

## NH

### NH GRANIT — `nh-granit-contours`

| | |
| --- | --- |
| **Lane** | contours (state-surveyed) |
| **Native unit** | ft |
| **Vertical datum** | depth below surface at survey time |
| **Source page** | <https://granit.unh.edu/> |
| **Endpoint** | `https://nhgeodata.unh.edu/hosting/rest/services/Hosted/EDP_Bathymetry_Lakes/FeatureServer/0` |
| **Credit we render** | NH Department of Environmental Services · NH Fish and Game (NH GRANIT) |
| **Captured** | 2026-08-01 |
| **Records** | 9285 |
| **Files** | 6 · 63.3 MB |
| **Fingerprint** | `0b2f4523` |
| **Agency copyright at capture** | *New Hampshire Department of Environmental Services New Hampshire Fish and Game* |

<details><summary>Field notes (traps found in the real data)</summary>

9,285 contour lines over 558 lakes, surveyed since 2000. The strongest source in the set and the one the whole chain was proved on. Carries both `depth` (ft) and `meters`. CAUTION: `depth` has been round-tripped through metres, so it holds 1.00000003 alongside 1 — a naive DISTINCT returns 116 values where ~60 exist. Round before grouping or labelling. Interval is per lake, not per state (the plan assumed "10 ft"; the real set spans 1–180 ft).

</details>

## VT

### VCGI / NOAA — `vt-vcgi-champlain-soundings`

| | |
| --- | --- |
| **Lane** | soundings (we interpolate) |
| **Native unit** | ft |
| **Vertical datum** | NGVD 1929 |
| **Source page** | <https://geodata.vermont.gov/datasets/7f451335fc6644e7a7376adbcd6282df_2/about> |
| **Endpoint** | `https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Elevation_LKCHDEM_point_SP_v1/FeatureServer/0` |
| **Credit we render** | NOAA · VCGI · VT ANR · VT DEC |
| **Captured** | 2026-08-01 |
| **Records** | 104910 |
| **Files** | 54 · 2.3 MB |
| **Fingerprint** | `c0d332cb` |
| **Agency copyright at capture** | *University of Vermont (JEFF LAIBLE), VCGI* |

<details><summary>Field notes (traps found in the real data)</summary>

104,910 POINTS with a single DEPTH_FT column — not isobaths. Digitised from 1:40,000 NOAA charts; VCGI added the Mallets Bay–north and Crown Point–south gaps in 2003 and replaced the shoreline points in 2010. Covers the whole lake, so it is also our only New York coverage. NGVD 1929 does NOT share a datum with the VT ANR set below — never union the two into one ramp.

</details>

### VT ANR — `vt-anr-biobase-soundings`

| | |
| --- | --- |
| **Lane** | soundings (we interpolate) |
| **Native unit** | ft |
| **Vertical datum** | pool elevation at time of collection |
| **Source page** | <https://geodata.vermont.gov/datasets/VTANR::bathymetric-data/about> |
| **Endpoint** | `https://anrmaps.vermont.gov/websites/OpenData/Items/BathymetricData/BiobaseLakeBathymetry_08122020.zip` |
| **Credit we render** | Vermont Agency of Natural Resources |
| **Captured** | 2026-08-01 |
| **Records** | — (opaque file) |
| **Files** | 1 · 22.3 MB |
| **Fingerprint** | `2d89df55` |
| **Agency copyright at capture** | *(none published)* |
| **Server last-modified** | Mon, 01 Jun 2026 15:42:58 GMT |

<details><summary>Field notes (traps found in the real data)</summary>

2,442,512 sounding POINTS over 66 lakes (Longitude,Latitude,DepthInFeet,LakeName) from BioBase sonar logs, compiled 2020-08-12 — not isobaths, contrary to the plan's source table. Density is not a concern here: the sparsest lake carries 5,034 points and the densest 136,856, so every VT lake clears any defensible gate by an order of magnitude. This is the opposite of Maine's problem despite being the same shape of data.

</details>

## New York

**No statewide lake bathymetry exists to archive.** This is a checked finding, not a gap — see
`plans/phase-N6b-bathymetry-layer.md` §New York for the search that established it and for the
costed digitisation path if we ever fund it.

New York is nonetheless covered where it matters most: the VCGI/NOAA Champlain source above spans
the whole lake, including its entire New York shore.
