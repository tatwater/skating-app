/**
 * The state-agency source registry (N6b) — every dataset we fetch, declared as data.
 *
 * Adding a state is an entry here plus (for a sounding lane) a density threshold. Nothing about a
 * state's identity lives in a code path, which is the property that keeps five agencies from becoming
 * five special cases.
 *
 * **Every field below was verified against the live service on 2026-07-31**, and doing so corrected
 * the phase plan four times — see `plans/phase-N6b-bathymetry-layer.md` §"What the build found in the
 * plan". The corrections are recorded in `notes` rather than only in the plan, because the person who
 * next re-runs this will be standing here, not in a plan doc.
 */

import type { BathymetrySource } from './types';

/**
 * Depth values that mean "the shoreline", not "a depth".
 *
 * MassGIS ships the shoreline as a `SHORE = 1` row at `DEPTH = 0`, and NH's set carries `depth = 0`
 * lines too. We already draw the shoreline — it is the water-body polygon's own outline — so keeping
 * these would double-stroke every lake edge with a line in the contour palette, at exactly the place
 * where D82 says the contour must lose against anything else competing for legibility.
 */
export const SHORELINE_DEPTH = 0;

export const SOURCES: BathymetrySource[] = [
  {
    key: 'nh-granit-contours',
    state: 'NH',
    agency: 'NH GRANIT',
    kind: 'contours',
    unit: 'ft',
    fetch: {
      type: 'arcgis',
      url: 'https://nhgeodata.unh.edu/hosting/rest/services/Hosted/EDP_Bathymetry_Lakes/FeatureServer/0',
    },
    attribution: 'NH Department of Environmental Services · NH Fish and Game (NH GRANIT)',
    sourceUrl: 'https://granit.unh.edu/',
    datum: 'depth below surface at survey time',
    notes:
      '9,285 contour lines over 558 lakes, surveyed since 2000. The strongest source in the set and ' +
      'the one the whole chain was proved on. Carries both `depth` (ft) and `meters`. ' +
      'CAUTION: `depth` has been round-tripped through metres, so it holds 1.00000003 alongside 1 — ' +
      'a naive DISTINCT returns 116 values where ~60 exist. Round before grouping or labelling. ' +
      'Interval is per lake, not per state (the plan assumed "10 ft"; the real set spans 1–180 ft).',
  },
  {
    key: 'vt-vcgi-champlain-soundings',
    state: 'VT',
    agency: 'VCGI / NOAA',
    kind: 'soundings',
    unit: 'ft',
    fetch: {
      type: 'arcgis',
      url: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Elevation_LKCHDEM_point_SP_v1/FeatureServer/0',
    },
    // **Checked against the archived service metadata and NOAA's own terms, 2026-08-01.** Three
    // things had to change from the placeholder "NOAA · VCGI · VT ANR · VT DEC":
    //
    // 1. VCGI's `copyrightText` names **University of Vermont** and VCGI. The placeholder omitted UVM,
    //    the actual named copyright holder, and added VT ANR / VT DEC, who are not in it.
    // 2. NOAA asks that attribution not "state or imply endorsement by or affiliation with NOAA", and
    //    that modified data not be presented as unaltered NOAA data. Our Champlain surface is doubly
    //    derived — NOAA chart, digitised by UVM/VCGI, then interpolated by us — so the credit says
    //    where the soundings came from and stops short of implying NOAA drew any of this.
    // 3. Our licence relationship runs to **VCGI**, not to NOAA: we take the data from VCGI's service.
    //    NOAA's terms govern the character of the underlying survey, not our redistribution chain.
    attribution: 'Soundings digitised from NOAA nautical charts by University of Vermont and VCGI',
    notice: 'Not for navigation.',
    sourceUrl: 'https://geodata.vermont.gov/datasets/7f451335fc6644e7a7376adbcd6282df_2/about',
    datum: 'NGVD 1929',
    notes:
      '104,910 POINTS with a single DEPTH_FT column — not isobaths. Digitised from 1:40,000 NOAA ' +
      'charts; VCGI added the Mallets Bay–north and Crown Point–south gaps in 2003 and replaced the ' +
      'shoreline points in 2010. Covers the whole lake, so it is also our only New York coverage. ' +
      'NGVD 1929 does NOT share a datum with the VT ANR set below — never union the two into one ramp. ' +
      'COUNT TRAP: only **20,345** of the 104,910 points are depth readings. The other 84,565 (80.6%) ' +
      'are DEPTH_FT = 0 — that 2010 shoreline replacement. They are not soundings and must not be ' +
      'counted as coverage, but they are not junk either: they are the depth-0 boundary constraint ' +
      'that keeps an interpolated surface from running deep at the shore. Dropped by the normalizer, ' +
      're-added deliberately by the gridder.',
  },
  {
    key: 'vt-anr-biobase-soundings',
    state: 'VT',
    agency: 'VT ANR',
    kind: 'soundings',
    unit: 'ft',
    fetch: {
      type: 'file',
      url: 'https://anrmaps.vermont.gov/websites/OpenData/Items/BathymetricData/BiobaseLakeBathymetry_08122020.zip',
      filename: 'BiobaseLakeBathymetry_08122020.zip',
    },
    attribution: 'Vermont Agency of Natural Resources',
    sourceUrl: 'https://geodata.vermont.gov/datasets/VTANR::bathymetric-data/about',
    datum: 'pool elevation at time of collection',
    notes:
      '2,442,512 sounding POINTS over 66 lakes (Longitude,Latitude,DepthInFeet,LakeName) from BioBase ' +
      "sonar logs, compiled 2020-08-12 — not isobaths, contrary to the plan's source table. " +
      'Density is not a concern here: the sparsest lake carries 5,034 points and the densest 136,856, ' +
      'so every VT lake clears any defensible gate by an order of magnitude. This is the opposite of ' +
      "Maine's problem despite being the same shape of data.",
  },
  {
    key: 'ma-massgis-contours',
    state: 'MA',
    agency: 'MassGIS / MassWildlife',
    kind: 'contours',
    unit: 'ft',
    fetch: {
      type: 'arcgis',
      url: 'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/MassWildlife_Inland_Bathymetry/FeatureServer/0',
      // The service advertises maxRecordCount 2000 and 500s on anything above ~500. This is exactly
      // the case `pageSize` exists for: an advertised capacity the server cannot actually honour.
      // (Odder still, `resultRecordCount=250` is ignored outright and streams the entire layer, so
      // "smaller is safer" does not hold here — 500 is a measured value, not a conservative guess.)
      pageSize: 500,
    },
    attribution: 'MassGIS · MassWildlife (Massachusetts Division of Fisheries & Wildlife)',
    sourceUrl:
      'https://www.mass.gov/info-details/massgis-data-masswildlife-inland-water-bathymetry',
    datum: 'depth below surface at survey time',
    notes:
      '27,989 contour lines, integer DEPTH in feet, keyed per lake by NAME + PALIS_ID. Published as a ' +
      'live FeatureServer, so the plan\'s "shapefile-plus-TIFF zip" worry does not apply to the vector ' +
      'half — no download-and-unpack lane needed. Interval varies per lake (2/3/4/5 ft in the ' +
      'shallows, 5 ft steps deeper). `SHORE = 1` rows are the shoreline at DEPTH 0 — drop them.',
  },
  {
    key: 'me-dep-soundings',
    state: 'ME',
    agency: 'Maine DEP / MaineIF&W',
    kind: 'soundings',
    unit: 'ft',
    fetch: {
      type: 'arcgis',
      url: 'https://gis.maine.gov/mapservices/rest/services/dep/MaineDEP_Lakes_Data/MapServer/2',
      // The service advertises 5,000, and honours it.
      pageSize: 5000,
    },
    attribution:
      'Maine Department of Environmental Protection · Maine Dept. of Inland Fisheries & Wildlife',
    sourceUrl: 'https://www.maine.gov/geolib/',
    datum: 'depth below surface; per-point surface elevation carried in SURFELVM/SURFELVF',
    notes:
      "147,755 depth POINTS over 5,000+ lakes, grouped by MIDAS (Maine's lake id) — so the per-lake " +
      'split needs no spatial work. TWO findings that change the plan: (1) the IF&W depth maps the ' +
      'plan calls "PDFs, a digitisation project, not an ETL" HAVE ALREADY BEEN DIGITISED by the ' +
      'state — those are the FMSRC=depthmap rows (FMPROCSS=dig, FMSRCORG=meifw). (2) This layer is ' +
      'TWO datasets wearing one schema, and FMSRC tells them apart: `depthmap` rows are digitised ' +
      'IF&W map soundings, `gpscarrier`/`gpsrec` rows are Maine DEP depth-sounder tracks. ' +
      'UNIT TRAP: DEPTHM was computed with a 3.3 ft/m constant, not 3.28084 — DEPTHM * 3.3 lands on a ' +
      'whole foot for the depthmap rows, DEPTHM * 3.28084 does not. So the published DEPTHF is ' +
      'systematically 0.58% shallow and must NOT be read as-is. Recover feet as DEPTHM * 3.3 for ' +
      'depthmap rows; the GPS rows are genuine metre readings and convert normally. ' +
      "Density IS the concern here: ~29 points per lake on average, against Vermont's ~37,000.",
  },
];

/**
 * New York is deliberately absent, and that absence is a finding rather than an omission.
 *
 * Checked 2026-07-31, exhaustively: NYSDEC's public ArcGIS server (every folder, every service, every
 * layer) carries exactly two depth layers and both are the Hudson River **estuary**. The NYS GIS
 * Clearinghouse's full DCAT catalogue (385 datasets) holds no statewide lake bathymetry — only a
 * topographic contour download app and a single Seneca Lake document. The one candidate that surfaced,
 * "Bathymetry of the Finger Lakes", is 50 unattributed depth-band polygons for eleven lakes, with no
 * published copyright and no traceable agency — which is exactly the kind of authoritative-looking
 * artifact of unknown provenance that D3 and this phase's GLOBathy finding exist to refuse.
 *
 * **What New York does get anyway:** the whole of Lake Champlain, including its entire NY shore, via
 * `vt-vcgi-champlain-soundings` above — the NOAA chart data covers the lake, not the state. So NY is
 * not blank; it is covered exactly where our corpus's most prominent NY skating water is.
 */
export const NEW_YORK_STATUS = 'no statewide dataset — see the note above' as const;

export function sourceByKey(key: string): BathymetrySource | undefined {
  return SOURCES.find((s) => s.key === key);
}

export function sourcesForState(state: string): BathymetrySource[] {
  return SOURCES.filter((s) => s.state === state.toUpperCase());
}

/** Every state we actually fetch data for. NY is covered only incidentally, via Champlain. */
export function coveredStates(): string[] {
  return [...new Set(SOURCES.map((s) => s.state))].sort();
}
