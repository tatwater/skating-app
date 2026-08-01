import { describe, expect, it } from 'vitest';
import {
  archiveKey,
  buildExtractManifest,
  checksumUrl,
  EXTRACT_SOURCES,
  type ExtractSource,
  extractUrl,
  parseBuildDate,
  parsePublishedMd5,
  runTableRow,
} from './archive';

const VT: ExtractSource = { state: 'VT', slug: 'vermont' };

describe('EXTRACT_SOURCES', () => {
  it('covers the five corpus states exactly once each', () => {
    expect(EXTRACT_SOURCES.map((s) => s.state).sort()).toEqual(['MA', 'ME', 'NH', 'NY', 'VT']);
  });

  it('clips New York and nothing else', () => {
    // The downstate metro is a third of the extract and none of it is skated; the 41.3°N cut is
    // inherited from the Phase 2.5 runbook rather than reinvented here.
    const clipped = EXTRACT_SOURCES.filter((s) => s.clipBBox);
    expect(clipped.map((s) => s.state)).toEqual(['NY']);
    expect(clipped[0]?.clipBBox?.[1]).toBe(41.3);
  });

  it('builds a filesystem-safe archive key per state', () => {
    for (const source of EXTRACT_SOURCES) expect(archiveKey(source)).toMatch(/^[a-z]{2}$/);
  });
});

describe('urls', () => {
  it('asks for the -latest alias and its checksum companion', () => {
    expect(extractUrl(VT)).toBe(
      'https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf',
    );
    expect(checksumUrl(VT)).toBe(`${extractUrl(VT)}.md5`);
  });
});

describe('parsePublishedMd5', () => {
  it('reads Geofabrik\'s "<hash>  <filename>" format', () => {
    expect(parsePublishedMd5('d9480acd6217694fed4e313a57f229c0  vermont-latest.osm.pbf')).toBe(
      'd9480acd6217694fed4e313a57f229c0',
    );
  });

  it('lowercases, so a case difference is never read as a mismatch', () => {
    expect(parsePublishedMd5('D9480ACD6217694FED4E313A57F229C0  x.pbf')).toBe(
      'd9480acd6217694fed4e313a57f229c0',
    );
  });

  it('returns undefined on junk rather than throwing away a finished download', () => {
    expect(parsePublishedMd5('<html>404</html>')).toBeUndefined();
    expect(parsePublishedMd5('')).toBeUndefined();
    expect(parsePublishedMd5('nothex  x.pbf')).toBeUndefined();
  });
});

describe('parseBuildDate', () => {
  it('extracts the dated build id — the thing that actually pins the snapshot', () => {
    expect(
      parseBuildDate('https://download.geofabrik.de/north-america/us/vermont-260731.osm.pbf'),
    ).toBe('260731');
  });

  it('refuses to treat "latest" as a version', () => {
    // If the redirect ever stops happening we want an ABSENT build date, not the word "latest"
    // sitting in the provenance record looking like one.
    expect(
      parseBuildDate('https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf'),
    ).toBeUndefined();
    expect(parseBuildDate(undefined)).toBeUndefined();
  });
});

describe('buildExtractManifest', () => {
  const base = {
    source: VT,
    fetchedAt: '2026-08-01T10:00:00.000Z',
    resolvedUrl: 'https://download.geofabrik.de/north-america/us/vermont-260731.osm.pbf',
    filename: 'vermont-260731.osm.pbf',
    bytes: 123_456_789,
    sha256: 'abc123',
  };

  it('records the resolved dated URL as the pin', () => {
    const m = buildExtractManifest(base);
    expect(m.resolvedUrl).toContain('260731');
    expect(m.buildDate).toBe('260731');
    expect(m.requestedUrl).toContain('-latest');
  });

  it('omits resolvedUrl when the server did not redirect', () => {
    const m = buildExtractManifest({ ...base, resolvedUrl: extractUrl(VT) });
    expect(m.resolvedUrl).toBeUndefined();
    expect(m.buildDate).toBeUndefined();
  });

  it('marks a checksum match', () => {
    const m = buildExtractManifest({ ...base, publishedMd5: 'aaa', actualMd5: 'AAA' });
    expect(m.md5Verified).toBe(true);
  });

  it('marks a checksum mismatch rather than silently accepting it', () => {
    // The failure this catches: a truncated download loading ~30k bad bodies, which the README
    // names as the reason the discipline existed in the first place.
    const m = buildExtractManifest({ ...base, publishedMd5: 'aaa', actualMd5: 'bbb' });
    expect(m.md5Verified).toBe(false);
  });

  it('leaves md5Verified undefined when there was nothing to check against', () => {
    // "We didn't check" and "it didn't match" are different facts. Collapsing them is how a bad
    // download gets loaded on a technicality.
    const m = buildExtractManifest(base);
    expect(m.md5Verified).toBeUndefined();
    expect(buildExtractManifest({ ...base, publishedMd5: 'aaa' }).md5Verified).toBeUndefined();
  });

  it('carries the clip bbox for New York', () => {
    const ny = EXTRACT_SOURCES.find((s) => s.state === 'NY');
    if (!ny) throw new Error('NY missing');
    expect(buildExtractManifest({ ...base, source: ny }).clipBBox?.[1]).toBe(41.3);
  });
});

describe('runTableRow', () => {
  const manifest = buildExtractManifest({
    source: VT,
    fetchedAt: '2026-08-01T10:00:00.000Z',
    resolvedUrl: 'https://download.geofabrik.de/north-america/us/vermont-260731.osm.pbf',
    filename: 'vermont-260731.osm.pbf',
    bytes: 1,
    sha256: '0123456789abcdef0123456789abcdef',
    publishedMd5: 'aaa',
    actualMd5: 'aaa',
  });

  it('renders a row the README run table can take verbatim', () => {
    const row = runTableRow(manifest);
    expect(row).toContain('| VT |');
    expect(row).toContain('260731');
    expect(row).toContain('✓');
    expect(row).toContain('2026-08-01');
  });

  it('says unverified rather than implying a check that never ran', () => {
    const unchecked = buildExtractManifest({
      source: VT,
      fetchedAt: '2026-08-01T10:00:00.000Z',
      filename: 'x.pbf',
      bytes: 1,
      sha256: 'x',
    });
    expect(runTableRow(unchecked)).toContain('unverified');
  });

  it('shouts about a mismatch', () => {
    const bad = buildExtractManifest({
      source: VT,
      fetchedAt: '2026-08-01T10:00:00.000Z',
      filename: 'x.pbf',
      bytes: 1,
      sha256: 'x',
      publishedMd5: 'aaa',
      actualMd5: 'bbb',
    });
    expect(runTableRow(bad)).toContain('MISMATCH');
  });
});
