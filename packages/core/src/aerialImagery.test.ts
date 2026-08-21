import { describe, expect, it } from 'vitest';
import {
  AERIAL_ATTRIBUTION,
  AERIAL_TILE_SIZE,
  aerialBoundsFor,
  aerialIdentifyUrl,
  aerialSourceSpec,
  aerialTileTemplate,
  formatAerialCaptureDate,
  parseAerialScene,
  resolutionFromSceneName,
} from './aerialImagery';
import type { Polygon } from 'geojson';

const POND: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.2, 44.45],
      [-73.19, 44.45],
      [-73.19, 44.46],
      [-73.2, 44.46],
      [-73.2, 44.45],
    ],
  ],
};

/**
 * Trimmed from the real `identify` response over Burlington, 2026-08-21 — including the overview
 * rasters, because they are the thing this parser exists to skip.
 */
const IDENTIFY_RESPONSE = {
  catalogItems: {
    features: [
      {
        attributes: {
          Name: 'm_4407339_ne_18_030_20230621',
          Year: 2023,
          raster_name: 'm_4407339_ne_18_030_20230621',
          acquisition_date: 1687305600000,
        },
      },
      {
        attributes: {
          Name: 'Ov_i02_L01_R0000016D_C00000079.tif',
          Year: 2023,
          raster_name: null,
          acquisition_date: null,
        },
      },
      {
        attributes: {
          Name: 'Ov_i02_L02_R000000B6_C0000003C.tif',
          Year: null,
          raster_name: null,
          acquisition_date: null,
        },
      },
    ],
  },
};

describe('aerialTileTemplate', () => {
  it('leaves the bbox token unencoded — MapLibre matches it literally', () => {
    const url = aerialTileTemplate();
    expect(url).toContain('bbox={bbox-epsg-3857}');
    expect(url).not.toContain('%7Bbbox');
  });

  it('pins both spatial references to 3857, so nothing reprojects mid-round-trip', () => {
    const url = aerialTileTemplate();
    expect(url).toContain('bboxSR=3857');
    expect(url).toContain('imageSR=3857');
  });

  it('asks for exactly the tile size it declares', () => {
    expect(aerialTileTemplate()).toContain(`size=${AERIAL_TILE_SIZE}%2C${AERIAL_TILE_SIZE}`);
  });

  it('targets the 0.3 m ImageServer, not the z16 tile cache', () => {
    const url = aerialTileTemplate();
    expect(url).toContain('USGSNAIPPlus/ImageServer');
    expect(url).not.toContain('USGSImageryOnly');
    // The cache's endpoint shape — if this ever appears we are back on 1.7 m/px.
    expect(url).not.toContain('/tile/');
  });
});

describe('aerialSourceSpec', () => {
  it('bounds the source to the reveal, so panning never fires a render outside the lake', () => {
    const spec = aerialSourceSpec(aerialBoundsFor(POND));
    expect(spec.bounds).toEqual([-73.2, 44.45, -73.19, 44.46]);
  });

  it('carries the imagery credit on the source, so attribution composes rather than concatenates', () => {
    expect(aerialSourceSpec(aerialBoundsFor(POND)).attribution).toBe(AERIAL_ATTRIBUTION);
  });

  it('caps zoom so upsampling happens locally rather than on the USGS renderer', () => {
    expect(aerialSourceSpec(aerialBoundsFor(POND)).maxzoom).toBeLessThanOrEqual(22);
  });
});

describe('aerialIdentifyUrl', () => {
  it('asks for catalog items — the plain identify response carries no dates', () => {
    const url = aerialIdentifyUrl({ lat: 44.455, lng: -73.195 });
    expect(url).toContain('returnCatalogItems=true');
    expect(url).toContain('esriGeometryPoint');
  });

  it('sends lng/lat as x/y in 4326, which is the pairing easiest to get backwards', () => {
    const url = aerialIdentifyUrl({ lat: 44.455, lng: -73.195 });
    const geometry = JSON.parse(decodeURIComponent(url.split('geometry=')[1]?.split('&')[0] ?? '{}'));
    expect(geometry.x).toBe(-73.195);
    expect(geometry.y).toBe(44.455);
    expect(geometry.spatialReference.wkid).toBe(4326);
  });
});

describe('parseAerialScene', () => {
  it('skips the overview rasters and finds the real scene', () => {
    const scene = parseAerialScene(IDENTIFY_RESPONSE);
    expect(scene?.sceneName).toBe('m_4407339_ne_18_030_20230621');
    expect(scene?.capturedAt).toBe(1687305600000);
    expect(scene?.resolutionM).toBe(0.3);
  });

  it('takes the newest dated scene rather than the first, so response order cannot decide', () => {
    const reordered = {
      catalogItems: {
        features: [
          { attributes: { raster_name: 'm_old_18_030_20190601', acquisition_date: 1559347200000 } },
          ...IDENTIFY_RESPONSE.catalogItems.features,
        ],
      },
    };
    expect(parseAerialScene(reordered)?.capturedAt).toBe(1687305600000);
  });

  it('returns null outside NAIP coverage, so a caller says nothing rather than guessing', () => {
    const overviewsOnly = {
      catalogItems: {
        features: [{ attributes: { raster_name: null, acquisition_date: null } }],
      },
    };
    expect(parseAerialScene(overviewsOnly)).toBeNull();
    expect(parseAerialScene({})).toBeNull();
    expect(parseAerialScene(null)).toBeNull();
  });
});

describe('resolutionFromSceneName', () => {
  it('reads centimetres out of the quarter-quad name', () => {
    expect(resolutionFromSceneName('m_4407339_ne_18_030_20230621')).toBe(0.3);
    expect(resolutionFromSceneName('m_4407339_ne_18_060_20190612')).toBe(0.6);
    expect(resolutionFromSceneName('m_4407339_ne_18_100_20150801')).toBe(1);
  });

  it('is undefined rather than wrong when the name has no resolution field', () => {
    expect(resolutionFromSceneName('Ov_i02_L01_R00000024_C00000001')).toBeUndefined();
    expect(resolutionFromSceneName('')).toBeUndefined();
  });
});

describe('formatAerialCaptureDate', () => {
  const JUNE_2023 = 1687305600000;

  it('is month and year — a day implies a precision the flight cycle does not have', () => {
    expect(formatAerialCaptureDate(JUNE_2023, Date.parse('2024-01-01'))).toBe('June 2023');
  });

  it('says so out loud once the imagery is older than the flight cycle', () => {
    // "latest", not "oldest": this is the newest flight there is, which is the point of saying it.
    expect(formatAerialCaptureDate(JUNE_2023, Date.parse('2027-01-01'))).toBe(
      'June 2023 · latest available',
    );
  });

  it('is the real Burlington scene, dated from the live service on 2026-08-21', () => {
    // `m_4407339_nw_18_030_20230620` — the summer solstice, which is D147 in one filename.
    expect(formatAerialCaptureDate(1687219200000, Date.parse('2026-08-21'))).toBe(
      'June 2023 · latest available',
    );
  });

  it('is empty rather than "Invalid Date" for a broken timestamp', () => {
    expect(formatAerialCaptureDate(Number.NaN)).toBe('');
  });
});
