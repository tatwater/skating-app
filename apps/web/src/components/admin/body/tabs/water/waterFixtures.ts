/**
 * Board 5.4.5's Mascoma Lake (dev relation/4056603), as the Water tab draws it: the depth ladder
 * the board shows (the record keeps only the two winners; the rest are the candidates read the
 * server owes), the interior point, and the bathymetry gap. Constants only — stories and tests.
 */
import type { WaterData } from './waterModel';

export const MASCOMA_BBOX = {
  maxLat: 43.6497901,
  maxLng: -72.1206902,
  minLat: 43.6061979,
  minLng: -72.1819521,
};

export const MASCOMA_WATER: WaterData = {
  name: 'Mascoma Lake',
  state: 'NH',
  depth: {
    rungs: [
      { source: 'state_agency', mean: 9.4, max: 24 },
      { source: 'lagos_us', mean: null, max: 23 },
      { source: 'hydrolakes_modeled', mean: 8.1, max: null },
      { source: 'osm_tag', mean: null, max: 22 },
    ],
    meanFrom: 'state_agency',
    maxFrom: 'state_agency',
  },
  sampling: {
    interior: { lat: 43.617368284786984, lng: -72.136005675 },
    points: null,
    acrossKm: 4.9,
    wide: false,
  },
  bathymetry: {
    searched: { source: 'NH GRANIT lake contours', when: '12 Sep, with the depth load' },
    found: 'Depth bands, no contour lines',
    missing: true,
  },
  box: MASCOMA_BBOX,
};

/** As the app reads it today: the two winners only, and no bathymetry read. */
export const MASCOMA_WATER_AS_READ: WaterData = {
  ...MASCOMA_WATER,
  depth: {
    rungs: [{ source: 'state_agency', mean: 9.4, max: 24 }],
    meanFrom: 'state_agency',
    maxFrom: 'state_agency',
  },
  bathymetry: null,
};

/** A wide body with a grid of points set by hand. */
export const CHAMPLAIN_WATER: WaterData = {
  name: 'Lake Champlain',
  state: 'VT',
  depth: { rungs: [], meanFrom: null, maxFrom: null },
  sampling: {
    interior: { lat: 44.5, lng: -73.3 },
    points: [
      { lat: 44.95, lng: -73.3 },
      { lat: 44.5, lng: -73.3 },
      { lat: 44.05, lng: -73.4 },
    ],
    acrossKm: 172.4,
    wide: true,
  },
  bathymetry: { searched: null, found: 'Contour lines', missing: false },
  box: { minLat: 43.5, minLng: -73.5, maxLat: 45.05, maxLng: -73.2 },
};
