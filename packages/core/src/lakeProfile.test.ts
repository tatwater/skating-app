import { describe, expect, it } from 'vitest';
import { buildLakeCaption, captionStateFor, type RegionStatsRow } from './lakeProfile';
import { computeDeciles } from './regionStats';

const VT: RegionStatsRow = {
  state: 'VT',
  metrics: {
    maxDepthM:
      computeDeciles(Array.from({ length: 400 }, (_, i) => 1 + (i / 400) ** 3 * 90)) ?? undefined,
  },
};

describe('captionStateFor', () => {
  it('picks a known state code, stably', () => {
    // Border-spanning bodies belong to several populations and there is no principled pick from the
    // row alone; `states` is sorted by importCanonical, so first-known is arbitrary but STABLE —
    // the alternative is a comparison that flips between renders.
    expect(captionStateFor({ states: ['NY', 'VT'] })).toBe('NY');
    expect(captionStateFor({ states: ['NY', 'VT'] })).toBe('NY');
  });

  it('ignores a code we have no name for, rather than printing it raw', () => {
    expect(captionStateFor({ states: ['ZZ', 'VT'] })).toBe('VT');
    expect(captionStateFor({ states: ['ZZ'] })).toBeUndefined();
    expect(captionStateFor({})).toBeUndefined();
  });
});

describe('buildLakeCaption', () => {
  it('returns null for a missing body', () => {
    expect(buildLakeCaption(null, [VT])).toBeNull();
    expect(buildLakeCaption(undefined, [VT])).toBeNull();
  });

  it('names the state in a comparative clause', () => {
    const caption = buildLakeCaption(
      { states: ['VT'], maxDepthM: 97, maxDepthSource: 'state_agency' },
      [VT],
    );
    expect(caption).toContain('among the deepest in Vermont');
  });

  it('degrades to no comparison when regionStats has not been computed yet', () => {
    // The state every body is in before the first recompute. A comparison we cannot support is a
    // clause we omit, never a hedge.
    const caption = buildLakeCaption(
      { states: ['VT'], maxDepthM: 97, maxDepthSource: 'state_agency' },
      undefined,
    );
    expect(caption).not.toContain('deepest');
    expect(caption).toContain('318 ft');
  });

  it('degrades the same way when the body is in a state we have no row for', () => {
    const caption = buildLakeCaption(
      { states: ['ME'], maxDepthM: 97, maxDepthSource: 'state_agency' },
      [VT],
    );
    expect(caption).not.toContain('deepest');
  });

  it('says nothing at all about a body we know nothing about', () => {
    expect(buildLakeCaption({ states: ['VT'], name: 'Pond' }, [VT])).toBeNull();
  });
});
