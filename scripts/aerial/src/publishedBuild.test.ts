import type { NaipManifest } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  againstPublished,
  describeDifference,
  newCampaignAdvice,
  PublishedBuildRefusal,
  publishedConflict,
} from './publishedBuild';

const manifest = {
  version: 2,
  campaign: 'naip-pilot-20261212',
  pilot: 'champlain',
  createdAt: '2026-12-12T00:00:00.000Z',
  ruleVersion: 2,
  catalog: { walkedOn: '2026-12-11', items: 0, perState: {}, archivedAt: null },
  exclusionsHash: 'e'.repeat(64),
  foliageStrikesHash: 'f'.repeat(64),
  offSeasonCells: [],
  basedOn: null,
  frames: {},
  cells: [],
  workTiles: [],
} as NaipManifest;

describe('a stage against what its campaign has published', () => {
  it('goes ahead when nothing is published, and has nothing to do for the same inputs', () => {
    expect(againstPublished(null, manifest)).toBe('unpublished');
    // A re-run of the select stage writes the same decision with a new time: the same build.
    expect(againstPublished(manifest, { ...manifest, createdAt: '2026-12-13T00:00:00.000Z' })).toBe(
      'published',
    );
    expect(publishedConflict(manifest, manifest)).toBeNull();
  });

  // A pilot's advice is a new pilot from nothing: it was `--from-current` until the ninth review, and
  // a pilot base expands to the whole region (`select.fromCurrentPilot`).
  it('refuses other inputs, naming what differs and the way to make the change', () => {
    const next = { ...manifest, ruleVersion: 3, foliageStrikesHash: '0'.repeat(64) };
    const said =
      'naip-pilot-20261212 is already published from other inputs (rule: 2 → 3; foliage strikes: changed). A published key is never overwritten, so naip-pilot-20261212 stays as it was built — make the change a new pilot, from nothing: run-aerial.sh naip-pilot-<YYYYMMDD> --pilot champlain --cells <file> (a pilot is never a base for --from-current)';
    expect(() => againstPublished(manifest, next)).toThrow(
      new PublishedBuildRefusal('published.otherInputs', said),
    );
    expect(publishedConflict(manifest, next)).toBe(said);
  });

  it('a production campaign’s advice, and a long difference counted rather than listed', () => {
    expect(newCampaignAdvice({ campaign: 'naip-20261212', pilot: null })).toBe(
      'make the change a new campaign: run-aerial.sh naip-<YYYYMMDD> --from-current, with NAIP_MANIFEST_URL at naip-summer-20261212-manifest.json, copies its unchanged work tiles',
    );
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(describeDifference(lines)).toBe('a; b; c; d; e; f; …and 2 more');
    expect(describeDifference(lines.slice(0, 2))).toBe('a; b');
  });
});
