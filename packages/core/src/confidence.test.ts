import { describe, expect, it } from 'vitest';

import {
  type AttributeClaim,
  type BodyConfidence,
  independentVoices,
  mergeReviewReasons,
  needsAttention,
  sameName,
  scoreAttribute,
  scoreBody,
} from './confidence';
import type { WaterBodyClass } from './types';

const c = <T>(source: AttributeClaim<T>['source'], value: T): AttributeClaim<T> => ({
  source,
  value,
});

describe('independentVoices', () => {
  // 3DHP re-publishes NHD across the whole Northeast — 7,878 lakes, zero area disagreements at or
  // above 0.1%. Counting them separately would hand every federal body a free `high`.
  it('collapses NHD and 3DHP into one federal vote', () => {
    expect(independentVoices(['nhd', '3dhp'])).toBe(1);
    expect(independentVoices(['nhd'])).toBe(1);
    expect(independentVoices(['osm', 'nhd', '3dhp'])).toBe(2);
  });

  it('does not count a name or a moderator as a catalogue', () => {
    expect(independentVoices(['name'])).toBe(0);
    expect(independentVoices(['user'])).toBe(0);
  });
});

describe('scoreAttribute', () => {
  it('is high only when two independent catalogues agree', () => {
    expect(scoreAttribute([c('osm', 'lakePond'), c('nhd', 'lakePond')])).toBe('high');
  });

  it('is medium for one catalogue, uncontested — including NHD plus 3DHP', () => {
    expect(scoreAttribute([c('nhd', 'lakePond')])).toBe('medium');
    expect(scoreAttribute([c('nhd', 'lakePond'), c('3dhp', 'lakePond')])).toBe('medium');
  });

  it('is low when catalogues conflict', () => {
    expect(scoreAttribute([c('osm', 'lakePond'), c('nhd', 'wetland')])).toBe('low');
  });

  it('is none when nothing claims it', () => {
    expect(scoreAttribute([])).toBe('none');
  });

  it('treats a name keyword as weak evidence that never corroborates', () => {
    // The name is the same string the catalogue supplied, read a second way — not a second opinion.
    expect(scoreAttribute([c('name', 'lakePond')])).toBe('medium');
    expect(scoreAttribute([c('nhd', 'lakePond'), c('name', 'lakePond')])).toBe('medium');
  });

  it('lets a moderator end the question', () => {
    expect(scoreAttribute([c('osm', 'lakePond'), c('nhd', 'wetland'), c('user', 'wetland')])).toBe(
      'high',
    );
  });
});

describe('sameName', () => {
  it('ignores case, accent and spacing', () => {
    expect(sameName('Étang Payeur', 'etang  payeur')).toBe(true);
    expect(sameName(' Lake Champlain ', 'lake champlain')).toBe(true);
  });

  it('still separates two different lakes', () => {
    expect(sameName('Long Pond', 'Long Lake')).toBe(false);
  });
});

describe('scoreBody', () => {
  const base = {
    names: [] as AttributeClaim<string>[],
    polygons: [] as AttributeClaim<number>[],
    classes: [] as AttributeClaim<WaterBodyClass>[],
    depths: [] as AttributeClaim<number>[],
  };

  it('scores each attribute separately', () => {
    const out = scoreBody({
      ...base,
      names: [c('osm', 'Long Pond'), c('nhd', 'Long Pond')],
      classes: [c('osm', 'lakePond' as WaterBodyClass)],
      polygons: [c('osm', 1), c('nhd', 0.94)],
    });
    expect(out).toEqual({ name: 'high', polygon: 'high', cls: 'medium', depth: 'none' });
  });

  it('never queues an outline disagreement, because no human can settle one by eye', () => {
    const out = scoreBody({ ...base, polygons: [c('osm', 1), c('nhd', 0.4)] });
    expect(out.polygon).toBe('low');
    expect(mergeReviewReasons({ confidence: out })).toEqual([]);
  });

  // A well-corroborated outline and a name only one publisher has ever heard of is an ordinary
  // combination, and one number per body would hide it.
  it('does not let a strong attribute carry a weak one', () => {
    const out = scoreBody({
      ...base,
      names: [c('osm', 'Mud Pond')],
      polygons: [c('osm', 1), c('nhd', 0.97)],
      classes: [c('osm', 'lakePond' as WaterBodyClass), c('nhd', 'lakePond' as WaterBodyClass)],
    });
    expect(out.name).toBe('medium');
    expect(out.polygon).toBe('high');
    expect(out.cls).toBe('high');
  });

  // Bucketed, not thresholded once. The first draft used a single 0.85 bar taken from the phase
  // plan's prose; the measured OSM-vs-NHD median over 12,643 pairs is 0.883, so that bar sat below
  // the median and called 38.6% of all matched pairs a disagreement.
  it('buckets outline agreement against the measured distribution', () => {
    expect(scoreBody({ ...base, polygons: [c('osm', 1), c('nhd', 0.94)] }).polygon).toBe('high');
    expect(scoreBody({ ...base, polygons: [c('osm', 1), c('nhd', 0.79)] }).polygon).toBe('medium');
    expect(scoreBody({ ...base, polygons: [c('osm', 1), c('nhd', 0.62)] }).polygon).toBe('low');
  });

  it('calls a single uncorroborated outline medium, not a conflict', () => {
    expect(scoreBody({ ...base, polygons: [c('osm', 1)] }).polygon).toBe('medium');
  });

  // 6,756 bodies had OSM silent and NHD saying LakePond. Scoring `unclassified` as a claim made every
  // one of them read as a conflict, and they were most of a 3,999-row queue nobody could have worked.
  it('does not let `unclassified` vote against a real class', () => {
    const out = scoreBody({
      ...base,
      classes: [c('osm', 'unclassified' as WaterBodyClass), c('nhd', 'lakePond' as WaterBodyClass)],
    });
    expect(out.cls).toBe('medium');
  });
});

describe('mergeReviewReasons', () => {
  const clean: BodyConfidence = {
    name: 'high',
    polygon: 'high',
    cls: 'high',
    depth: 'medium',
  };

  it('is empty for a corroborated body', () => {
    expect(mergeReviewReasons({ confidence: clean })).toEqual([]);
  });

  it('queues a genuine conflict', () => {
    expect(mergeReviewReasons({ confidence: { ...clean, cls: 'low' } })).toEqual([
      'class-conflict',
    ]);
  });

  // The whole point of separating `low` from `none`: absence of evidence is a backlog, and folding it
  // into the queue would put thousands of unnamed ponds in front of a moderator who would then stop
  // opening the queue at all.
  it('does NOT queue a body that is merely unresolved', () => {
    expect(
      mergeReviewReasons({
        confidence: { name: 'none', polygon: 'medium', cls: 'none', depth: 'none' },
      }),
    ).toEqual([]);
  });

  it('does not queue a depth disagreement, which no human can settle by looking', () => {
    expect(mergeReviewReasons({ confidence: { ...clean, depth: 'low' } })).toEqual([]);
  });

  // Half Moon Cove: 330 acres, named "Cove", 0.00 contained in any corpus body — and the state's own
  // map calls it a wetland. Only the missing parent catches that; the name actively misleads.
  it('queues a bay with no parent body', () => {
    expect(mergeReviewReasons({ confidence: clean, bayWithoutParent: true })).toEqual([
      'bay-without-parent',
    ]);
  });

  it('queues two features from one catalogue in one merge group', () => {
    expect(mergeReviewReasons({ confidence: clean, sameSourceDuplicate: true })).toEqual([
      'same-source-duplicate',
    ]);
  });

  it('reports every reason, not the first', () => {
    expect(
      mergeReviewReasons({
        confidence: { ...clean, cls: 'low', name: 'low' },
        sameSourceDuplicate: true,
      }),
    ).toEqual(['class-conflict', 'name-conflict', 'same-source-duplicate']);
  });
});

describe('needsAttention', () => {
  it('separates the backlog from the queue', () => {
    const unresolved: BodyConfidence = {
      name: 'none',
      polygon: 'medium',
      cls: 'none',
      depth: 'none',
    };
    expect(needsAttention(unresolved)).toBe(true);
    expect(mergeReviewReasons({ confidence: unresolved })).toEqual([]);
  });

  it('leaves a fully-described body alone', () => {
    expect(needsAttention({ name: 'medium', polygon: 'high', cls: 'high', depth: 'none' })).toBe(
      false,
    );
  });
});
