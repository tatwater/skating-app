import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { buildCorpusIndex, type CorpusBody, coveringBody, readCorpusBodies } from './corpusIndex';

/** An axis-aligned square body. */
function body(
  key: string,
  lng: number,
  lat: number,
  side: number,
  areaSqM = side * side,
): CorpusBody {
  return {
    key: `osm:${key}`,
    externalId: key,
    source: 'osm',
    name: key,
    surfaceAreaSqM: areaSqM,
    bbox: { minLng: lng, minLat: lat, maxLng: lng + side, maxLat: lat + side },
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + side, lat],
          [lng + side, lat + side],
          [lng, lat + side],
          [lng, lat],
        ],
      ],
    },
  };
}

describe('coveringBody — what the D95 re-key resolves against', () => {
  it('finds the body a point falls in', () => {
    const index = buildCorpusIndex([body('a', -70, 44, 0.01), body('b', -69, 45, 0.01)]);
    expect(coveringBody(index, { lat: 44.005, lng: -69.995 })?.externalId).toBe('a');
    expect(coveringBody(index, { lat: 45.005, lng: -68.995 })?.externalId).toBe('b');
  });

  it('returns null for a point in no body — the honest answer, not the nearest one', () => {
    // 3.7% of MIDAS 870's soundings land outside every polygon. "Near a lake" is not "in a lake",
    // and rounding that away would attribute a survey to whatever happened to be closest.
    const index = buildCorpusIndex([body('a', -70, 44, 0.01)]);
    expect(coveringBody(index, { lat: 44.5, lng: -70.5 })).toBeNull();
    // Just outside the eastern edge — still null, because there is no buffer.
    expect(coveringBody(index, { lat: 44.005, lng: -69.9899 })).toBeNull();
  });

  it('picks the LARGEST containing body, so a bay does not steal its lake’s survey', () => {
    // The rule that stopped Moosehead Lake arriving as North Bay. The local resolver has to keep it
    // or it would disagree with the server join about nested water.
    const lake = body('moosehead', -69.7, 45.5, 0.2);
    const bay = body('north-bay', -69.65, 45.55, 0.02);
    const index = buildCorpusIndex([bay, lake]); // bay first, so order cannot be what decides it
    expect(coveringBody(index, { lat: 45.56, lng: -69.64 })?.externalId).toBe('moosehead');
  });

  it('honours holes — a point in an island is not in the lake', () => {
    const withIsland: CorpusBody = {
      ...body('donut', -70, 44, 0.1),
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-70, 44],
            [-69.9, 44],
            [-69.9, 44.1],
            [-70, 44.1],
            [-70, 44],
          ],
          [
            [-69.96, 44.04],
            [-69.94, 44.04],
            [-69.94, 44.06],
            [-69.96, 44.06],
            [-69.96, 44.04],
          ],
        ],
      },
    };
    const index = buildCorpusIndex([withIsland]);
    expect(coveringBody(index, { lat: 44.02, lng: -69.98 })?.externalId).toBe('donut'); // water
    expect(coveringBody(index, { lat: 44.05, lng: -69.95 })).toBeNull(); // the island
  });

  it('handles a MultiPolygon body', () => {
    const multi: CorpusBody = {
      ...body('two-lobes', -70, 44, 0.1),
      polygon: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-70, 44],
              [-69.98, 44],
              [-69.98, 44.02],
              [-70, 44.02],
              [-70, 44],
            ],
          ],
          [
            [
              [-69.95, 44.05],
              [-69.93, 44.05],
              [-69.93, 44.07],
              [-69.95, 44.07],
              [-69.95, 44.05],
            ],
          ],
        ],
      },
    };
    const index = buildCorpusIndex([multi]);
    expect(coveringBody(index, { lat: 44.01, lng: -69.99 })?.externalId).toBe('two-lobes');
    expect(coveringBody(index, { lat: 44.06, lng: -69.94 })?.externalId).toBe('two-lobes');
    expect(coveringBody(index, { lat: 44.04, lng: -69.96 })).toBeNull(); // between the lobes
  });

  it('finds a body larger than one grid cell', () => {
    // The cell is ~4 km and Champlain is 200 km long, so a body is filed under every cell its bbox
    // touches. Getting this wrong would make the biggest lakes the ones that resolve worst.
    const big = body('champlain', -73.5, 44.0, 1.0);
    const index = buildCorpusIndex([big]);
    for (const p of [
      { lat: 44.05, lng: -73.45 },
      { lat: 44.5, lng: -73.0 },
      { lat: 44.95, lng: -72.55 },
    ]) {
      expect(coveringBody(index, p)?.externalId).toBe('champlain');
    }
  });

  it('is empty-safe', () => {
    expect(coveringBody(buildCorpusIndex([]), { lat: 44, lng: -70 })).toBeNull();
  });
});

describe('readCorpusBodies', () => {
  const write = (lines: string[]) => {
    const path = join(tmpdir(), `corpus-${process.pid}-${lines.length}.ndjson`);
    writeFileSync(path, lines.join('\n'));
    return path;
  };
  const row = (externalId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      source: 'osm',
      externalId,
      name: 'Some Pond',
      surfaceAreaSqM: 1234,
      bbox: { minLng: -70, minLat: 44, maxLng: -69.99, maxLat: 44.01 },
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-70, 44],
            [-69.99, 44],
            [-69.99, 44.01],
            [-70, 44.01],
            [-70, 44],
          ],
        ],
      },
      ...extra,
    });

  it('reads bodies.ndjson into indexable rows, and the round trip resolves', async () => {
    const path = write([row('way/1'), row('way/2')]);
    const bodies = await readCorpusBodies(path);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.key).toBe('osm:way/1');
    // The index built from a real file finds a point inside it — the whole contract in one line.
    expect(coveringBody(buildCorpusIndex(bodies), { lat: 44.005, lng: -69.995 })?.externalId).toBe(
      'way/1',
    );
    rmSync(path);
  });

  it('tolerates blank lines and a trailing newline', async () => {
    const path = write([row('way/1'), '', row('way/2'), '']);
    expect(await readCorpusBodies(path)).toHaveLength(2);
    rmSync(path);
  });

  it('defaults a missing name and area rather than dropping the body', async () => {
    // A body with no name is the common case (11,153 of them), and one with no stored area still has
    // a polygon to test against. Neither is a reason to lose it from the resolver.
    const path = write([row('way/1', { name: undefined, surfaceAreaSqM: undefined })]);
    const [body] = await readCorpusBodies(path);
    expect(body?.name).toBe('');
    expect(body?.surfaceAreaSqM).toBe(0);
    rmSync(path);
  });
});
