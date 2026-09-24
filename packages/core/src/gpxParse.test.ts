import { describe, expect, it } from 'vitest';
import { parseGpx } from './gpxParse';
import { toGpx } from './track';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Strava"><trk><name>Morning skate</name><trkseg>
<trkpt lat="43.64" lon="-72.13"><ele>140.2</ele><time>2026-01-10T19:05:00Z</time></trkpt>
<trkpt lat="43.641" lon="-72.131"><time>2026-01-10T19:06:00Z</time></trkpt>
<trkpt lat='43.642' lon='-72.132'><time>2026-01-10T19:04:00Z</time></trkpt>
<trkpt lat="x" lon="-72.1"><time>2026-01-10T19:07:00Z</time></trkpt>
<trkpt lat="43.643" lon="-72.133"></trkpt>
</trkseg></trk></gpx>`;

describe('parseGpx', () => {
  it('reads the timed points in time order, keeps elevation, drops what it cannot place', () => {
    const parsed = parseGpx(GPX);
    expect(parsed?.name).toBe('Morning skate');
    expect(parsed?.points.map((p) => p.t)).toEqual([
      Date.UTC(2026, 0, 10, 19, 4),
      Date.UTC(2026, 0, 10, 19, 5),
      Date.UTC(2026, 0, 10, 19, 6),
    ]);
    expect(parsed?.points[1]?.elevation).toBe(140.2);
    expect(parsed?.points[0]?.elevation).toBeUndefined();
  });

  it('refuses what is not a track', () => {
    expect(parseGpx('<html></html>')).toBeNull();
    expect(
      parseGpx(
        '<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>2026-01-10T19:05:00Z</time></trkpt></trkseg></trk></gpx>',
      ),
    ).toBeNull();
  });

  it('round-trips what toGpx writes', () => {
    const points = [
      { lat: 43.64, lng: -72.13, t: Date.UTC(2026, 0, 10, 19, 0) },
      { lat: 43.65, lng: -72.14, t: Date.UTC(2026, 0, 10, 19, 10) },
    ];
    const xml = toGpx(points, { name: 'Skate', type: 'IceSkate' } as Parameters<typeof toGpx>[1]);
    expect(xml).not.toBeNull();
    const back = parseGpx(xml as string);
    expect(back?.points.map((p) => [p.lat, p.lng, p.t])).toEqual(
      points.map((p) => [p.lat, p.lng, p.t]),
    );
  });
});
