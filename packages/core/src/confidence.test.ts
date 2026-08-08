import { describe, expect, it } from 'vitest';

import {
  type AttributeClaim,
  type BodyConfidence,
  independentVoices,
  isAdvisoryReviewReason,
  mergeReviewReasons,
  needsAttention,
  primaryReviewReason,
  REVIEW_REASON_PRIORITY,
  REVIEW_REASONS,
  sameDisplayName,
  sameName,
  scorableClassClaims,
  scoreAttribute,
  scoreBody,
  settledWetlandDissent,
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

  // Every one of these is a real pair the first version flagged as a disagreement.
  it.each([
    ["Harvey's Lake", 'Harvey Lake'],
    ["Leffert's Pond", 'Lefferts Pond'],
    ["Thompson's Pond", 'Thompsons Pond'],
    ['Clark Pond', 'Clarks Pond'],
    ['Howes Pond', 'Howe Pond'],
    ['Salem Lake', 'Lake Salem'],
    ['Lake Sadawga', 'Sadawga Lake'],
  ])('reads %s and %s as one name', (a, b) => {
    expect(sameName(a, b)).toBe(true);
  });

  // The line: a structural difference is provably one name spelled twice; a one-character difference
  // only looks like one. `Bear Pond` and `Bean Pond` are different lakes, so typos go to a human.
  it.each([
    ['Lake Runnemede', 'Lake Runnenede'],
    ['Little Eligo Pond', 'Little Elligo Pond'],
    ['Bear Pond', 'Bean Pond'],
    ['Bourne Pond', 'Bourn Pond'],
  ])('does NOT collapse %s and %s on a one-character difference', (a, b) => {
    expect(sameName(a, b)).toBe(false);
  });

  it('still separates two different lakes', () => {
    expect(sameName('Long Pond', 'Long Lake')).toBe(false);
    expect(sameName('Winona Lake', 'Bristol Pond')).toBe(false);
    expect(sameName('Sucker Pond', 'Lake Hancock')).toBe(false);
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
  // Our vocabulary draws a distinction NHD does not, and we already wrote down how it resolves. It
  // is not the catalogues contradicting each other, and scoring it `low` put 1,437 foregone
  // conclusions in front of a moderator.
  it('treats reservoir-vs-lakePond as agreement, not conflict', () => {
    const out = scoreBody({
      ...base,
      classes: [c('osm', 'reservoir' as WaterBodyClass), c('nhd', 'lakePond' as WaterBodyClass)],
    });
    expect(out.cls).toBe('high');
    expect(mergeReviewReasons({ confidence: { ...out, name: 'high', polygon: 'high' } })).toEqual(
      [],
    );
  });

  it('treats river-vs-lakePond the same way — a deadwater NHD publishes as a waterbody', () => {
    expect(
      scoreBody({
        ...base,
        classes: [c('osm', 'river' as WaterBodyClass), c('nhd', 'lakePond' as WaterBodyClass)],
      }).cls,
    ).toBe('high');
  });

  // The one class disagreement that is about the water rather than the vocabulary. D96's admission
  // rules turn on it, and mis-resolving it deleted 123 bodies NHD calls LakePond.
  //
  // **Direction matters, and these are the direction that is NOT settled**: the federal catalogue is
  // the one saying "bog". See the pair below for the mirror case.
  it('still calls a FEDERAL wetland claim against open water a conflict', () => {
    for (const pair of [
      ['lakePond', 'wetland'],
      ['reservoir', 'wetland'],
      ['bay', 'lakePond'],
    ] as const) {
      expect(
        scoreBody({
          ...base,
          classes: [c('osm', pair[0] as WaterBodyClass), c('nhd', pair[1] as WaterBodyClass)],
        }).cls,
      ).toBe('low');
    }
  });

  // 520 of the 652 class conflicts on the n7-2026-08-07 master list, measured by joining every one to
  // its NHD FTYPE. NHD compiled the northeast at 1:24,000 and calls this open water; one mapper
  // tagged the same polygon a marsh. D96 already decided that direction, so queueing it asks a
  // moderator to confirm a rule we trust, 520 times.
  it('treats a federal open-water class beating an OSM wetland tag as settled', () => {
    for (const federal of ['lakePond', 'reservoir'] as const) {
      const out = scoreBody({
        ...base,
        classes: [c('osm', 'wetland' as WaterBodyClass), c('nhd', federal as WaterBodyClass)],
      });
      expect(out.cls).toBe('medium');
      expect(mergeReviewReasons({ confidence: { ...out, name: 'high', polygon: 'high' } })).toEqual(
        [],
      );
    }
  });

  // 3DHP republishes NHD, so it can carry the open-water half of a group whose NHD half says bog.
  // One federal wetland claim disqualifies the whole group, or this rule would silence exactly the
  // 132 rows it exists to leave alone.
  it('refuses to settle when ANY federal claim is wetland', () => {
    expect(
      scoreBody({
        ...base,
        classes: [
          c('osm', 'wetland' as WaterBodyClass),
          c('nhd', 'wetland' as WaterBodyClass),
          c('3dhp', 'lakePond' as WaterBodyClass),
        ],
      }).cls,
    ).toBe('low');
  });

  // Drops the OSM wetland claim, not the group. A body where OSM also disagrees about something else
  // still scores that disagreement — losing a real conflict to a rule aimed at a different one is
  // the failure the claim-level filter avoids.
  it('does not settle a second, unrelated disagreement along with it', () => {
    expect(
      scoreBody({
        ...base,
        classes: [
          c('osm', 'wetland' as WaterBodyClass),
          c('osm', 'bay' as WaterBodyClass),
          c('nhd', 'lakePond' as WaterBodyClass),
        ],
      }).cls,
    ).toBe('low');
  });

  // Two OSM features in one group both tagged marsh is still one OSM voice, not two.
  it('settles regardless of how many times OSM says wetland', () => {
    expect(
      scoreBody({
        ...base,
        classes: [
          c('osm', 'wetland' as WaterBodyClass),
          c('osm', 'wetland' as WaterBodyClass),
          c('nhd', 'lakePond' as WaterBodyClass),
          c('3dhp', 'lakePond' as WaterBodyClass),
        ],
      }).cls,
    ).toBe('medium');
  });

  // An OSM wetland tag with nothing federal to beat it is not settled — it is the only claim there
  // is, and it is what D96 refuses under fifty acres.
  it('needs a federal open-water claim, not merely the absence of a federal wetland one', () => {
    expect(settledWetlandDissent([c('osm', 'wetland' as WaterBodyClass)])).toBe(false);
    expect(
      settledWetlandDissent([
        c('osm', 'wetland' as WaterBodyClass),
        c('nhd', 'lakePond' as WaterBodyClass),
      ]),
    ).toBe(true);
  });

  // The merge counts collapses so a volume shift between runs stays visible — a rule that resolves
  // rows without leaving a number behind is how the original 123-body deletion went unnoticed.
  it('exposes the collapse as a claim filter the merge can count', () => {
    const classes = [c('osm', 'wetland' as WaterBodyClass), c('nhd', 'lakePond' as WaterBodyClass)];
    expect(scorableClassClaims(classes)).toEqual([c('nhd', 'lakePond' as WaterBodyClass)]);
    // Untouched when the rule does not apply — same array, not a copy that drifts.
    const contested = [
      c('osm', 'lakePond' as WaterBodyClass),
      c('nhd', 'wetland' as WaterBodyClass),
    ];
    expect(scorableClassClaims(contested)).toBe(contested);
  });

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

describe('GNIS is an authority but not a second opinion', () => {
  // NHD's own `gnis_name` column IS GNIS. Counting them separately would be the NHD/3DHP mistake in
  // a different hat: one source agreeing with itself and scoring `high` for it.
  it('does not corroborate the federal name it is the source of', () => {
    expect(scoreAttribute([c('nhd', 'Mud Pond'), c('gnis', 'Mud Pond')])).toBe('medium');
  });

  it('is still better than silence when nothing else names the body', () => {
    expect(scoreAttribute([c('gnis', 'Cicero Swamp')])).toBe('medium');
    expect(scoreAttribute([])).toBe('none');
  });
});

describe('the queue ordering', () => {
  it('files a body under the worst thing wrong with it', () => {
    // A body that is both a duplicate and a name conflict renders as two lakes; the name is stored
    // either way. So it is a duplicate first.
    expect(primaryReviewReason(['name-conflict', 'duplicate-candidate'])).toBe(
      'duplicate-candidate',
    );
    expect(primaryReviewReason(['class-conflict', 'bay-without-parent'])).toBe(
      'bay-without-parent',
    );
  });

  it('is undefined for a body with nothing to review, which is what keeps the index small', () => {
    expect(primaryReviewReason(undefined)).toBeUndefined();
    expect(primaryReviewReason([])).toBeUndefined();
  });

  // A reason missing from the priority list would file every body carrying it as `undefined` — i.e.
  // silently out of the queue, which is the one failure a queue must not have.
  it('ranks every reason there is', () => {
    expect([...REVIEW_REASON_PRIORITY].sort()).toEqual([...REVIEW_REASONS].sort());
    for (const reason of REVIEW_REASONS) expect(primaryReviewReason([reason])).toBe(reason);
  });

  it('marks only name-conflict advisory, because only it costs nothing', () => {
    expect(isAdvisoryReviewReason('name-conflict')).toBe(true);
    for (const reason of REVIEW_REASONS.filter((r) => r !== 'name-conflict')) {
      expect(isAdvisoryReviewReason(reason)).toBe(false);
    }
  });
});

describe('sameDisplayName', () => {
  // Folded: spacing inside a proper noun, and a parenthesised alternate. 44 of run 8's 475 name
  // conflicts, and no pair of *different* lakes is spelled the same once spaces come out.
  it.each([
    ['LaCoute Lake', 'La Coute Lake'],
    ['Lower LaPomkeag Lake', 'Lower La Pomkeag Lake'],
    ['Wesserunsett Lake', 'Wesserunsett (Hayden) Lake'],
    ['Lonely Lake', 'Lonely Lake (Heron Pond)'],
  ])('folds %s and %s', (a, b) => {
    expect(sameDisplayName(a, b)).toBe(true);
  });

  // **The line, and it is the same line `sameName` draws.** These are the largest foldable-LOOKING
  // group in the queue (97 rows) and the one where folding would quietly merge two real ponds.
  it.each([
    ['Tuttle Pond', 'Turtle Pond'],
    ['Back Settlement Pond', 'Black Settlement Pond'],
    ['Bear Pond', 'Bean Pond'],
    ['Grand Lake', 'East Grand Lake'],
    ['Fitts Pond', 'Little Fitts Pond'],
    ['Silver Lake', 'Mattakeunk Pond'],
  ])('does NOT fold %s and %s', (a, b) => {
    expect(sameDisplayName(a, b)).toBe(false);
  });

  it('still folds everything sameName does, word order included', () => {
    expect(sameDisplayName('Salem Lake', 'Lake Salem')).toBe(true);
    expect(sameDisplayName("Harvey's Lake", 'Harveys Lake')).toBe(true);
  });

  it('does not fold two unnamed bodies into agreement', () => {
    expect(sameDisplayName('', '')).toBe(true); // sameName's own answer; no claim is stored for it
    expect(sameDisplayName('()', 'Long Pond')).toBe(false);
  });
});
