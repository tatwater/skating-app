import { describe, expect, it } from 'vitest';
import { GPX_MAX_BYTES, gpxSizeRefusal, parseGpx, planGpxImport } from './gpxParse';
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

  it('does not let a self-closing point swallow the next one', () => {
    const parsed = parseGpx(
      '<gpx><trk><trkseg><trkpt lat="1" lon="2"/>\n' +
        '<trkpt lat="43.64" lon="-72.13"><time>2026-01-10T19:05:00Z</time></trkpt>\n' +
        '<trkpt lat="43.65" lon="-72.14"><time>2026-01-10T19:06:00Z</time></trkpt>' +
        '</trkseg></trk></gpx>',
    );
    expect(parsed?.points.map((p) => [p.lat, p.lng])).toEqual([
      [43.64, -72.13],
      [43.65, -72.14],
    ]);
  });

  it('reads a document that prefixes the GPX namespace, and a prefix must close as it opened', () => {
    const parsed = parseGpx(
      '<?xml version="1.0"?><gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">' +
        '<gpx:trk><gpx:name>Prefixed</gpx:name><gpx:trkseg>' +
        '<gpx:trkpt lat="43.64" lon="-72.13"><gpx:ele>140</gpx:ele><gpx:time>2026-01-10T19:05:00Z</gpx:time></gpx:trkpt>' +
        '<gpx:trkpt lat="43.65" lon="-72.14"><gpx:time>2026-01-10T19:06:00Z</gpx:time></gpx:trkpt>' +
        '</gpx:trkseg></gpx:trk></gpx:gpx>',
    );
    expect(parsed?.name).toBe('Prefixed');
    expect(parsed?.points.map((p) => [p.lat, p.lng, p.elevation])).toEqual([
      [43.64, -72.13, 140],
      [43.65, -72.14, undefined],
    ]);
    // A mismatched close is not an element; the one well-formed point is not a track.
    expect(
      parseGpx(
        '<gpx><trkpt lat="1" lon="2"><a:time>2026-01-10T19:05:00Z</b:time></trkpt>' +
          '<trkpt lat="1" lon="2"><time>2026-01-10T19:06:00Z</time></trkpt></gpx>',
      ),
    ).toBeNull();
    // An extension's element is not the root: `gpxtpx:` is a prefix, not `gpx`.
    const points =
      '<trkpt lat="1" lon="2"><time>2026-01-10T19:05:00Z</time></trkpt>' +
      '<trkpt lat="1" lon="2"><time>2026-01-10T19:06:00Z</time></trkpt>';
    expect(
      parseGpx(`<gpxtpx:TrackPointExtension>${points}</gpxtpx:TrackPointExtension>`),
    ).toBeNull();
    expect(parseGpx(`<ns:gpx>${points}</ns:gpx>`)?.points).toHaveLength(2);
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

describe('planGpxImport', () => {
  it('shapes the ingest call with a key the same file resolves to again', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({
      lat: 43.64 + i * 0.001,
      lng: -72.13 - i * 0.001,
      t: Date.UTC(2026, 0, 10, 19, i),
    }));
    const xml = toGpx(points, { name: 'Skate' }) as string;
    const plan = planGpxImport(xml, 'report-1');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.path.type).toBe('LineString');
    expect(plan.startTime).toBe(points[0]?.t);
    expect(plan.endTime).toBe(points[11]?.t);
    expect(plan.elapsedSeconds).toBeGreaterThan(0);
    expect(planGpxImport(xml, 'report-1')).toEqual(plan);
    expect((planGpxImport(xml, 'report-2') as { idempotencyKey: string }).idempotencyKey).not.toBe(
      plan.idempotencyKey,
    );
  });

  it('says why when it cannot', () => {
    expect(planGpxImport('<html></html>', 'r')).toEqual({
      ok: false,
      message: "That file isn't a GPX track with times in it.",
    });
    // Two timed points on one spot: a track that ends where it starts is no track.
    const still = planGpxImport(
      '<gpx><trk><trkseg>' +
        '<trkpt lat="43.64" lon="-72.13"><time>2026-01-10T19:05:00Z</time></trkpt>' +
        '<trkpt lat="43.64" lon="-72.13"><time>2026-01-10T19:05:00Z</time></trkpt>' +
        '</trkseg></trk></gpx>',
      'r',
    );
    expect(still).toEqual({ ok: false, message: 'That track has too few usable points.' });
  });
});

describe('gpxSizeRefusal', () => {
  it('refuses a file past the cap before it is read, and reads one of unknown size', () => {
    expect(gpxSizeRefusal(GPX_MAX_BYTES)).toBeNull();
    expect(gpxSizeRefusal(GPX_MAX_BYTES + 1)).toMatch(/too big/);
    expect(gpxSizeRefusal(undefined)).toBeNull();
  });
});
