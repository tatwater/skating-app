/**
 * The elevation archive's rules — the incremental story, and the datum check D101 demanded (N7-2).
 */

import { describe, expect, it } from 'vitest';
import {
  type ElevationArchiveEntry,
  elevationDeltas,
  mergeArchiveEntries,
  missingKeys,
  resolutionBands,
} from './elevationArchive';
import { coordinateKey } from './epqs';

const entry = (over: Partial<ElevationArchiveEntry> & { key: string }): ElevationArchiveEntry => ({
  lat: 44,
  lng: -71,
  elevationM: 100,
  fetchedAt: '2026-08-08T00:00:00.000Z',
  ...over,
});

describe('missingKeys — the whole incremental story', () => {
  it('returns nothing when the archive already answers every point', () => {
    // D104's "we only have to do this once": a second run over an unchanged corpus is free.
    const points = [
      { lat: 44.5, lng: -71.5 },
      { lat: 43.5, lng: -70.5 },
    ];
    const archived = new Set(points.map((p) => coordinateKey(p.lat, p.lng)));
    expect(missingKeys(points, archived, coordinateKey)).toEqual([]);
  });

  it('asks only for the points the archive lacks', () => {
    const archived = new Set([coordinateKey(44.5, -71.5)]);
    const got = missingKeys(
      [
        { lat: 44.5, lng: -71.5 },
        { lat: 43.5, lng: -70.5 },
      ],
      archived,
      coordinateKey,
    );
    expect(got).toEqual([{ lat: 43.5, lng: -70.5, key: coordinateKey(43.5, -70.5) }]);
  });

  it('asks once for two bodies whose interior points round to the same key', () => {
    // A pond and the arm beside it legitimately collide at 1.1 m. Asking twice spends a request to
    // learn the same number — and at ~4 s a request that is not free.
    const got = missingKeys(
      [
        { lat: 44.5, lng: -71.5 },
        { lat: 44.500001, lng: -71.5 },
      ],
      new Set(),
      coordinateKey,
    );
    expect(got).toHaveLength(1);
  });
});

describe('mergeArchiveEntries', () => {
  it('keeps everything already archived when nothing new arrives', () => {
    const existing = [entry({ key: 'a' }), entry({ key: 'b' })];
    expect(mergeArchiveEntries(existing, [])).toEqual(existing);
  });

  it('appends new keys after the existing ones, so a diff reads as additions', () => {
    const got = mergeArchiveEntries([entry({ key: 'a' })], [entry({ key: 'b' })]);
    expect(got.map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('lets a refetch win, because the only reason to refetch is a better raster', () => {
    // D104: "a lake stamped from a 30 m raster can be re-stamped from 1 m later".
    const got = mergeArchiveEntries(
      [entry({ key: 'a', elevationM: 100, resolutionM: 30 })],
      [entry({ key: 'a', elevationM: 103.4, resolutionM: 1 })],
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ elevationM: 103.4, resolutionM: 1 });
  });
});

describe('resolutionBands', () => {
  it('bands the corpus so a coarse-DEM cohort is visible rather than latent', () => {
    expect(
      resolutionBands([
        { resolutionM: 1 },
        { resolutionM: 1 },
        { resolutionM: 3.4 },
        { resolutionM: 10 },
        { resolutionM: 30 },
        { resolutionM: 90 },
        { resolutionM: undefined },
      ]),
    ).toEqual({ '1m': 2, '3m': 1, '10m': 1, '30m': 1, 'coarser than 30m': 1, unreported: 1 });
  });

  it('is empty for an empty archive rather than reporting a band of zero', () => {
    expect(resolutionBands([])).toEqual({});
  });
});

describe('elevationDeltas — the check D101 asked for BEFORE the switch', () => {
  const archived = new Map([
    [coordinateKey(44.5, -71.5), entry({ key: 'x', elevationM: 100 })],
    [coordinateKey(43.5, -70.5), entry({ key: 'y', elevationM: 220 })],
  ]);

  it('reports the signed delta, so a datum shift cannot average itself away', () => {
    // "A source swap that silently changes a datum would move every decile in regionStats and look
    // like a data-quality improvement." A one-sided distribution is what a datum shift looks like;
    // an accuracy improvement scatters both ways.
    const got = elevationDeltas(
      [
        { elevationM: 120, lat: 44.5, lng: -71.5 },
        { elevationM: 200, lat: 43.5, lng: -70.5 },
      ],
      archived,
      coordinateKey,
    );
    expect(got.map((d) => d.deltaM)).toEqual([-20, 20]);
  });

  it('skips a body the archive has no reading for rather than scoring it zero', () => {
    // A missing entry counted as "agrees exactly" is how a comparison reports agreement it never
    // measured — the same shape as the shoreline cross-check that reported `0 comparable`.
    const got = elevationDeltas([{ elevationM: 10, lat: 1, lng: 1 }], archived, coordinateKey);
    expect(got).toEqual([]);
  });
});
