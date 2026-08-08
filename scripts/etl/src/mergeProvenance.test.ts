import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSourceStages,
  loadMergeProvenance,
  type MergeSourcePaths,
} from './mergeProvenance';

/**
 * These tests exist because the failure mode is **silence**. A merge that cannot find its GNIS
 * archive still finishes, still prints a report, and still writes a corpus — a smaller one, missing
 * the bodies the gazetteer would have named into existence. The only place that can ever surface is
 * the run row, so "a missing archive produces a stage that says MISSING" is the assertion, not a
 * detail of one.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-prov-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, value: unknown): string {
  const path = join(dir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function paths(overrides: Partial<MergeSourcePaths> = {}): MergeSourcePaths {
  return {
    osmDir: join(dir, '.raw'),
    osmStates: ['vt'],
    nhdDir: join(dir, '.raw-nhd'),
    nhdKeys: [{ key: 'vt', state: 'VT' }],
    threeDhpDir: join(dir, '.raw-3dhp'),
    gnisManifest: join(dir, '.raw-gnis', 'manifest.json'),
    boundariesPath: join(dir, 'boundaries.ndjson'),
    downstatePath: join(dir, 'downstate-ny.geojson'),
    ...overrides,
  };
}

describe('buildSourceStages', () => {
  it('names every stage by family, so the page can group seventeen files as four steps', () => {
    write('.raw/vt/manifest.json', { slug: 'vermont', filename: 'vermont-260731.osm.pbf' });
    write('.raw-nhd/vt/manifest.json', { slug: 'Vermont', bytesVerified: true });
    write('.raw-3dhp/source/manifest.json', { fiscalYear: 'FY26' });
    write('.raw-3dhp/waterbody/manifest.json', { layer: 'waterbody' });
    write('.raw-gnis/manifest.json', { states: [{ code: 'VT' }, { code: 'NH' }] });
    writeFileSync(join(dir, 'boundaries.ndjson'), '{}\n');
    writeFileSync(join(dir, 'downstate-ny.geojson'), '{}');

    expect(buildSourceStages(paths()).map((s) => s.name)).toEqual([
      'source · osm/vt',
      'source · nhd/VT',
      'source · 3dhp/download',
      'source · 3dhp/clip',
      'source · gnis/VT',
      'source · gnis/NH',
      'mask · five-state',
      'mask · downstate-ny',
    ]);
  });

  it('records a missing archive as a stage, never as an omission', () => {
    // Nothing on disk at all: a corpus built this way is a *different corpus*, and the run row is
    // the only artifact that can say so after the fact.
    const stages = buildSourceStages(paths());
    expect(stages).toHaveLength(7); // GNIS collapses to one row when the whole manifest is gone
    for (const stage of stages) expect(stage.detail).toMatch(/^MISSING/);
  });

  it('survives an unreadable manifest the same way it survives an absent one', () => {
    mkdirSync(join(dir, '.raw', 'vt'), { recursive: true });
    writeFileSync(join(dir, '.raw', 'vt', 'manifest.json'), 'not json {');
    const osm = buildSourceStages(paths()).find((s) => s.name === 'source · osm/vt');
    expect(osm?.detail).toMatch(/^MISSING/);
  });

  it('fingerprints the masks, which have no upstream checksum to verify against', () => {
    writeFileSync(join(dir, 'boundaries.ndjson'), '{"a":1}\n');
    const mask = buildSourceStages(paths()).find((s) => s.name === 'mask · five-state');
    expect(mask?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Absent, not `false`: "we could not check" is a different claim from "the check failed".
    expect(mask?.checksumVerified).toBeUndefined();
  });
});

describe('loadMergeProvenance', () => {
  it('finds the manifest beside the artifact without being told where it is', () => {
    write('merge/merge-manifest.json', { campaignId: 'n7-x', stages: [{ name: 'merge' }] });
    const found = loadMergeProvenance(join(dir, 'merge', 'bodies.ndjson'));
    expect(found?.manifest.campaignId).toBe('n7-x');
    expect(found?.manifest.stages).toEqual([{ name: 'merge' }]);
  });

  it('prefers an explicit override — the artifact may have been moved', () => {
    const path = write('elsewhere/merge-manifest.json', { campaignId: 'n7-y' });
    const found = loadMergeProvenance(join(dir, 'nowhere', 'bodies.ndjson'), path);
    expect(found?.manifest.campaignId).toBe('n7-y');
  });

  it('returns nothing rather than throwing when there is no manifest', () => {
    expect(loadMergeProvenance(join(dir, 'bodies.ndjson'))).toBeUndefined();
  });
});
