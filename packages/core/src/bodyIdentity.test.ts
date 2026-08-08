import { describe, expect, it } from 'vitest';
import { CATALOGUE_ID_FIELDS, type IdMatch, requiresReview, resolveUpsert } from './bodyIdentity';

/** A stored row's key, as the caller's lookup would report it. */
const hit = (field: (typeof CATALOGUE_ID_FIELDS)[number], value: string, ...keys: string[]) =>
  ({ field, value, keys }) as IdMatch<string>;

describe('the normal traffic', () => {
  it('inserts a lake no catalogue id resolves to', () => {
    expect(resolveUpsert({ nhdId: '141034078' }, [])).toEqual({ action: 'insert' });
  });

  it('patches in place when one id finds one row', () => {
    // Patch and never delete-recreate: user content keys off the Convex `_id`, and keeping it stable
    // is what makes "change a lake's geometry source" a field update rather than a migration.
    expect(
      resolveUpsert({ osmId: 'way/150404999' }, [hit('osmId', 'way/150404999', 'k1')]),
    ).toEqual({ action: 'patch', key: 'k1', matchedBy: ['osmId'] });
  });

  it('patches once when several ids agree on the same row — the reconciled steady state', () => {
    const verdict = resolveUpsert({ osmId: 'way/1', nhdId: '141034078', threeDhpId: 'I6PYK' }, [
      hit('osmId', 'way/1', 'k1'),
      hit('nhdId', '141034078', 'k1'),
      hit('threeDhpId', 'I6PYK', 'k1'),
    ]);
    expect(verdict).toEqual({
      action: 'patch',
      key: 'k1',
      matchedBy: ['osmId', 'nhdId', 'threeDhpId'],
    });
  });
});

describe('the case the campaign ordering exists to make rare', () => {
  it('MERGES rather than creating a third row when two ids hit two rows', () => {
    // Reconciliation missed a duplicate. Creating a third row here is how one lake becomes three.
    const verdict = resolveUpsert({ osmId: 'way/1', nhdId: '141034078' }, [
      hit('osmId', 'way/1', 'k-osm'),
      hit('nhdId', '141034078', 'k-nhd'),
    ]);
    expect(verdict).toEqual({
      action: 'merge',
      into: 'k-osm',
      absorb: ['k-nhd'],
      matchedBy: ['osmId', 'nhdId'],
    });
  });

  it('merges into the OSM-keyed row by default, because that is where user content lives', () => {
    // Not a claim about geometry quality — D92 decides that per lake via `geometrySource`. A claim
    // about attachment: the OSM lane has been the corpus since Phase 1.
    const verdict = resolveUpsert({ nhdId: 'n1', osmId: 'way/1' }, [
      hit('nhdId', 'n1', 'k-nhd'),
      hit('osmId', 'way/1', 'k-osm'),
    ]);
    expect(verdict.action).toBe('merge');
    // Note the caller passed nhdId FIRST. The survivor must be ranked by CATALOGUE_ID_FIELDS, not by
    // the order someone else's lookup code happened to use — otherwise which row survives a merge
    // depends on the shape of the caller, and both orderings look correct at the call site.
    if (verdict.action === 'merge') expect(verdict.into).toBe('k-osm');
  });

  it('honours an explicit survivor rule over the default', () => {
    const verdict = resolveUpsert(
      { osmId: 'way/1', nhdId: 'n1' },
      [hit('osmId', 'way/1', 'k-osm'), hit('nhdId', 'n1', 'k-nhd')],
      { preferSurvivor: (c) => (c.find((x) => x.field === 'nhdId')?.key ?? c[0]?.key) as string },
    );
    if (verdict.action === 'merge') {
      expect(verdict.into).toBe('k-nhd');
      expect(verdict.absorb).toEqual(['k-osm']);
    } else expect.unreachable();
  });

  it('collapses three colliding rows into one survivor and two absorbed', () => {
    const verdict = resolveUpsert({ osmId: 'way/1', nhdId: 'n1', threeDhpId: 't1' }, [
      hit('osmId', 'way/1', 'a'),
      hit('nhdId', 'n1', 'b'),
      hit('threeDhpId', 't1', 'c'),
    ]);
    if (verdict.action === 'merge') {
      expect(verdict.into).toBe('a');
      expect(verdict.absorb).toEqual(['b', 'c']);
    } else expect.unreachable();
  });
});

describe('the corpus-invariant violations, which must never be guessed at', () => {
  it('refuses when ONE id resolves to several rows', () => {
    const verdict = resolveUpsert({ nhdId: '141034078' }, [hit('nhdId', '141034078', 'k1', 'k2')]);
    expect(verdict.action).toBe('conflict');
    if (verdict.action === 'conflict') expect(verdict.reason).toMatch(/must be unique/);
  });

  it('reports ambiguity BEFORE any merge, since the corpus is already proven wrong', () => {
    // A merge decided on top of a corpus that violates uniqueness is a decision built on sand.
    const verdict = resolveUpsert({ osmId: 'way/1', nhdId: 'n1' }, [
      hit('osmId', 'way/1', 'k-osm'),
      hit('nhdId', 'n1', 'k1', 'k2'),
    ]);
    expect(verdict.action).toBe('conflict');
  });

  it('refuses a feature carrying no catalogue id at all', () => {
    // It cannot be upserted, only counted as a drop — which the DropLedger is for.
    const verdict = resolveUpsert({}, []);
    expect(verdict.action).toBe('conflict');
    if (verdict.action === 'conflict') expect(verdict.reason).toMatch(/no catalogue id/);
  });
});

describe('requiresReview', () => {
  it('lets the normal traffic through unattended', () => {
    expect(requiresReview({ action: 'insert' })).toBe(false);
    expect(requiresReview({ action: 'patch', key: 'k', matchedBy: ['osmId'] })).toBe(false);
  });

  it('queues merges and conflicts for a human', () => {
    // An automatic merge that is wrong is unrecoverable in a way a queued one is not, and the
    // measured frequency says queueing is affordable: 92 fan-out ids across the whole archive.
    expect(
      requiresReview({ action: 'merge', into: 'a', absorb: ['b'], matchedBy: ['osmId'] }),
    ).toBe(true);
    expect(requiresReview({ action: 'conflict', reason: 'x' })).toBe(true);
  });
});

describe('the field order is the contract', () => {
  it('puts OSM first, since the default survivor rule reads it', () => {
    expect(CATALOGUE_ID_FIELDS).toEqual(['osmId', 'nhdId', 'threeDhpId']);
  });

  it('does not include gnisId — GNIS names places, and a place can be split', () => {
    // Measured: 92 GNIS ids resolve to more than one NHD body. Upserting on it would merge them.
    expect(CATALOGUE_ID_FIELDS).not.toContain('gnisId');
  });
});
