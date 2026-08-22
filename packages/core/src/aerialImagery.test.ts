import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  AERIAL_MAX_EXPORT_PX,
  aerialBoundsFor,
  aerialExportUrl,
  aerialIdentifyUrl,
  formatAerialCaptureDate,
  parseAerialScene,
  resolutionFromSceneName,
} from './aerialImagery';

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

describe('aerialExportUrl', () => {
  const BOX = { minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 };

  it('sends a Web Mercator bbox, because the mask is traced in the same projection', () => {
    const url = new URL(aerialExportUrl(BOX, 512, 512));
    const [minX, minY, maxX, maxY] = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    // Projected metres, not degrees — a degrees bbox here is the units bug that misregisters the mask.
    expect(Math.abs(minX as number)).toBeGreaterThan(1e6);
    expect(maxX as number).toBeGreaterThan(minX as number);
    expect(maxY as number).toBeGreaterThan(minY as number);
    expect(url.searchParams.get('bboxSR')).toBe('3857');
    expect(url.searchParams.get('imageSR')).toBe('3857');
  });

  it('targets the 0.3 m ImageServer, not the z16 tile cache', () => {
    const url = aerialExportUrl(BOX, 256, 256);
    expect(url).toContain('USGSNAIPPlus/ImageServer');
    expect(url).not.toContain('USGSImageryOnly');
    // The cache's endpoint shape — if this ever appears we are back on 1.7 m/px.
    expect(url).not.toContain('/tile/');
  });

  it('clamps to what the service will render', () => {
    // Past the cap the ImageServer returns a *smaller* image than asked for, silently rescaling the
    // alpha mask against it — so the clamp belongs here rather than at the call site.
    const url = new URL(aerialExportUrl(BOX, 9000, 9000));
    expect(url.searchParams.get('size')).toBe(`${AERIAL_MAX_EXPORT_PX},${AERIAL_MAX_EXPORT_PX}`);
  });

  it('asks for jpg — the alpha is punched in on our side, so a PNG would be bytes we overwrite', () => {
    expect(new URL(aerialExportUrl(BOX, 256, 256)).searchParams.get('format')).toBe('jpg');
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
    const geometry = JSON.parse(
      decodeURIComponent(url.split('geometry=')[1]?.split('&')[0] ?? '{}'),
    );
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

describe('aerialBoundsFor', () => {
  const POND_SHAPE: Polygon = POND;

  it('is the plain bbox when nothing is asked for', () => {
    expect(aerialBoundsFor(POND_SHAPE)).toEqual({
      minLat: 44.45,
      minLng: -73.2,
      maxLat: 44.46,
      maxLng: -73.19,
    });
  });

  it('grows by the feather, because the fade runs outside the shape', () => {
    // Cropping to the shape's own bbox slices the gradient with a straight line at the north and
    // south extremes of every lake — a hard cut through the middle of a soft edge.
    const padded = aerialBoundsFor(POND_SHAPE, 80);
    expect(padded.maxLat).toBeGreaterThan(44.46);
    expect(padded.minLat).toBeLessThan(44.45);
    expect(padded.maxLng).toBeGreaterThan(-73.19);
    expect(padded.minLng).toBeLessThan(-73.2);
    // 80 m is ~0.0007° of latitude; a sanity bound so a unit slip shows up here.
    expect(padded.maxLat - 44.46).toBeLessThan(0.002);
  });
});
