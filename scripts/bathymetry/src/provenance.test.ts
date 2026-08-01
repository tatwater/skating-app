import { describe, expect, it } from 'vitest';
import { renderProvenance, snapshotFingerprint } from './provenance';
import type { BathymetrySource, RawManifest } from './types';

const SOURCE: BathymetrySource = {
  key: 'nh-granit-contours',
  state: 'NH',
  agency: 'NH GRANIT',
  kind: 'contours',
  unit: 'ft',
  fetch: { type: 'arcgis', url: 'https://example.gov/FeatureServer/0' },
  attribution: 'NH DES · NH Fish and Game',
  sourceUrl: 'https://granit.unh.edu/',
  datum: 'depth below surface at survey time',
  notes: 'meters is a length, not a depth.',
};

const MANIFEST: RawManifest = {
  key: 'nh-granit-contours',
  fetchedAt: '2026-07-31T20:11:04.123Z',
  source: { url: 'https://example.gov/FeatureServer/0', kind: 'arcgis', format: 'geojson' },
  files: [
    { name: 'page-00000.json.gz', bytes: 4_000_000, sha256: 'bb' },
    { name: 'page-00001.json.gz', bytes: 2_500_000, sha256: 'aa' },
  ],
  recordCount: 9285,
  service: { fields: [], copyrightText: 'New Hampshire Department of Environmental Services' },
};

describe('snapshotFingerprint', () => {
  it('is independent of file order', () => {
    const reordered: RawManifest = { ...MANIFEST, files: [...MANIFEST.files].reverse() };
    expect(snapshotFingerprint(reordered)).toBe(snapshotFingerprint(MANIFEST));
  });

  it('ignores the fetch timestamp, so re-fetching identical data compares equal', () => {
    // The question this answers is "is my archive the one that produced the current tiles?", which a
    // manifest hash could never answer — it carries a timestamp and differs on every re-fetch.
    const refetched: RawManifest = { ...MANIFEST, fetchedAt: '2027-01-01T00:00:00.000Z' };
    expect(snapshotFingerprint(refetched)).toBe(snapshotFingerprint(MANIFEST));
  });

  it('changes when the bytes change', () => {
    const changed: RawManifest = {
      ...MANIFEST,
      files: [{ name: 'page-00000.json.gz', bytes: 4_000_000, sha256: 'cc' }],
    };
    expect(snapshotFingerprint(changed)).not.toBe(snapshotFingerprint(MANIFEST));
  });
});

describe('renderProvenance', () => {
  const out = renderProvenance(
    [{ source: SOURCE, manifest: MANIFEST }],
    '2026-07-31T20:30:00.000Z',
  );

  it('is a pure function of its inputs — no clock, so a no-op run makes no diff', () => {
    // This file is committed. A renderer reading Date.now() would dirty it on every run.
    expect(
      renderProvenance([{ source: SOURCE, manifest: MANIFEST }], '2026-07-31T20:30:00.000Z'),
    ).toBe(out);
  });

  it('records the day, not the clock time', () => {
    expect(out).toContain('Generated 2026-07-31');
    expect(out).toContain('| **Captured** | 2026-07-31 |');
    expect(out).not.toContain('20:11:04');
  });

  it('groups by state, because staleness and refreshing are both per-state', () => {
    expect(out).toContain('## NH');
  });

  it("carries the agency's own copyright text as captured, distinctly from the credit we render", () => {
    // Two different things: what they say today vs. what we agreed to show. A drift between them is
    // for a human to read, so both are on the page.
    expect(out).toContain('| **Credit we render** | NH DES · NH Fish and Game |');
    expect(out).toContain('*New Hampshire Department of Environmental Services*');
  });

  it('gives the per-state refresh commands, not a refresh-everything one', () => {
    expect(out).toContain('snapshot --state=NH --refresh');
    expect(out).toContain('verify --state=NH');
  });

  it('totals the bytes across a snapshot in human units', () => {
    expect(out).toContain('6.5 MB');
  });

  it('marks a never-fetched source rather than omitting it', () => {
    const never = renderProvenance([{ source: SOURCE }], '2026-07-31T20:30:00.000Z');
    expect(never).toContain('Never fetched');
    expect(never).toContain('0/1 sources archived');
  });

  it('says "(none published)" rather than leaving a licence row blank', () => {
    const noCredit = renderProvenance(
      [{ source: SOURCE, manifest: { ...MANIFEST, service: { fields: [] } } }],
      '2026-07-31T20:30:00.000Z',
    );
    expect(noCredit).toContain('*(none published)*');
  });

  it('renders an opaque file download without inventing a record count', () => {
    const fileManifest: RawManifest = {
      key: 'vt-anr-biobase-soundings',
      fetchedAt: '2026-07-31T20:11:04.123Z',
      source: { url: 'https://example.gov/x.zip', kind: 'file' },
      files: [{ name: 'x.zip', bytes: 22_300_000, sha256: 'dd' }],
      http: { lastModified: 'Mon, 01 Jun 2026 15:42:58 GMT' },
    };
    const rendered = renderProvenance(
      [
        {
          source: {
            ...SOURCE,
            key: 'vt-anr-biobase-soundings',
            state: 'VT',
            kind: 'soundings',
            fetch: { type: 'file', url: 'https://example.gov/x.zip', filename: 'x.zip' },
          },
          manifest: fileManifest,
        },
      ],
      '2026-07-31T20:30:00.000Z',
    );
    expect(rendered).toContain('— (opaque file)');
    expect(rendered).toContain('Mon, 01 Jun 2026 15:42:58 GMT');
  });

  it('always documents New York, including when nothing is archived', () => {
    expect(out).toContain('## New York');
    expect(out).toContain('No statewide lake bathymetry exists to archive');
  });
});
