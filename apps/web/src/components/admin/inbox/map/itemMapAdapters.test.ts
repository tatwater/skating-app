import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { InboxMapView } from './inboxMapScene';
import { answerNotes, itemMapScene, kindHasMap, shoreFact } from './itemMapAdapters';
import {
  ACCESS_MAP,
  ACCESS_REPORTS,
  ACTIVATE,
  ACTIVATE_MAP,
  ADMIT_MAP,
  ADMIT_MAP_NO_TRACK,
  ADMIT_MATCH,
  ALERT_FLAG,
  ALERT_MAP,
  CAPPED,
  DRAWN,
  DRAWN_MAP,
  DRAWN_MAP_NO_TRACK,
  EMPTY_MAP,
  GONE_FLAG,
  PERSON_FLAG,
  PLACE,
  PLACE_MAP,
  SAFETY,
  SAFETY_MAP,
  SIMPLIFIED,
  TICKET,
  TRACKS_SIMPLIFIED,
} from './itemMapFixtures';

const TZ = 'America/New_York';
const ids = (v: InboxMapView | null) => v?.scene.items.map((i) => i.id) ?? null;
/** The skates drawn: the scene's track lines (a rule to the nearest body is a line too). */
const lines = (v: InboxMapView | null) =>
  v?.scene.items.flatMap((i) => (i.id.startsWith('track:') ? [i.id] : [])) ?? [];
const marks = (v: InboxMapView | null) =>
  v?.scene.items.flatMap((i) => (i.kind === 'point' ? [i.mark] : [])) ?? [];

describe('each kind’s scene', () => {
  it('a safety flag on a report: the body and the red reticle', () => {
    const v = itemMapScene(SAFETY, SAFETY_MAP, TZ);
    expect(ids(v)).toEqual(['body:mascoma', 'report:r1']);
    expect(marks(v)).toEqual(['reticle']);
    expect(v?.caption).toBeNull();
  });

  it('a content flag on a report reads the bright reticle, not the red', () => {
    expect(
      marks(itemMapScene({ ...SAFETY, lane: 'contentFlags' } as never, SAFETY_MAP, TZ)),
    ).toEqual(['asked']);
  });

  it('a flag on an access alert lights its put-in', () => {
    const v = itemMapScene(ALERT_FLAG, ALERT_MAP, TZ);
    expect(v?.scene.lit).toBe('putIn:fairlee');
    expect(v?.caption).toBe('Fairlee town launch');
    // A simplified outline is said beside the put-in's name, never in its place.
    expect(itemMapScene(ALERT_FLAG, SIMPLIFIED(ALERT_MAP), TZ)?.caption).toBe(
      'Fairlee town launch · Outline simplified',
    );
  });

  it('access: the body and its access points', () => {
    expect(ids(itemMapScene(ACCESS_REPORTS, ACCESS_MAP, TZ))).toEqual([
      'body:tomhannock',
      'putIn:dam-road',
    ]);
  });

  it('an admit: the candidate dashed, ours, the rule, the legend and the catalog’s fact', () => {
    const v = itemMapScene(ADMIT_MATCH, ADMIT_MAP_NO_TRACK, TZ);
    expect(ids(v)).toEqual([
      'body:ricker',
      'candidate:yq4k2',
      'gap:nearest:ricker',
      'gap:nearest:ricker:length',
    ]);
    expect(v?.legend.map((r) => r.label)).toEqual(['Catalog outline · not ours yet', 'Ours']);
    expect(v?.caption).toBe('Unnamed · 41 ac');
  });

  it('an admit with an ask’s skate: its track, named for its asker as the board does', () => {
    const v = itemMapScene(ADMIT_MATCH, ADMIT_MAP, TZ);
    expect(lines(v)).toContain('track:kd');
    expect(v?.legend.map((r) => r.label)).toEqual([
      'Catalog outline · not ours yet',
      'Kate Donovan’s skate',
      'Ours',
    ]);
  });

  it('several skates, or one whose asker isn’t named, say what they are', () => {
    const two = {
      ...ADMIT_MAP,
      tracks: [
        ...ADMIT_MAP.tracks,
        { ...(ADMIT_MAP.tracks[0] as (typeof ADMIT_MAP.tracks)[number]), id: 'other' },
      ],
    };
    expect(itemMapScene(ADMIT_MATCH, two, TZ)?.legend.map((r) => r.label)).toContain(
      'Recorded skates',
    );
    const unmatched = {
      ...ADMIT_MAP,
      tracks: [{ ...(ADMIT_MAP.tracks[0] as (typeof ADMIT_MAP.tracks)[number]), id: 'x' }],
    };
    expect(itemMapScene(ADMIT_MATCH, unmatched, TZ)?.legend.map((r) => r.label)).toContain(
      'A recorded skate',
    );
  });

  it('a thinned skate is said on the caption, never drawn as if whole', () => {
    expect(itemMapScene(ADMIT_MATCH, TRACKS_SIMPLIFIED(ADMIT_MAP), TZ)?.caption).toContain(
      'Skate simplified',
    );
    expect(itemMapScene(DRAWN, TRACKS_SIMPLIFIED(DRAWN_MAP), TZ)?.caption).toContain(
      'Skate simplified',
    );
  });

  it('draws no line for an item the server sent no skate for', () => {
    expect(lines(itemMapScene(ADMIT_MATCH, ADMIT_MAP_NO_TRACK, TZ))).toEqual([]);
    expect(lines(itemMapScene(DRAWN, DRAWN_MAP_NO_TRACK, TZ))).toEqual([]);
    expect(itemMapScene(DRAWN, DRAWN_MAP_NO_TRACK, TZ)?.caption).not.toContain('Skate');
  });

  it('a request on a body we hold: the body and the asked points', () => {
    const v = itemMapScene(ACTIVATE, ACTIVATE_MAP, TZ);
    expect(ids(v)).toEqual(['body:mascoma', 'ask:rq9']);
  });

  it('an admit no catalog feature matched: the asked points, said so', () => {
    const v = itemMapScene(ADMIT_MATCH, { ...ADMIT_MAP, candidate: null, others: [] }, TZ);
    expect(marks(v)).toEqual(['asked', 'asked']);
    expect(v?.caption).toBe('No catalog feature');
  });

  it('a place ask: the asked point, the lookalike, the rule between', () => {
    const v = itemMapScene(PLACE, PLACE_MAP, TZ);
    expect(marks(v)).toEqual(['lookalike', 'asked']);
    expect(v?.reach).not.toBeNull();
    // Several asked the same bay: all drawn, all framed.
    const many = itemMapScene(
      PLACE,
      {
        ...PLACE_MAP,
        lookalikes: [],
        points: [...PLACE_MAP.points, { id: 'x', at: [-71.75, 43.67] }],
      },
      TZ,
    );
    expect(marks(many)).toEqual(['asked', 'asked']);
  });

  it('a drawing: ours, the drawing over it, its legend and the share on the shore', () => {
    const v = itemMapScene(DRAWN, DRAWN_MAP_NO_TRACK, TZ);
    expect(ids(v)).toEqual(['body:caspian', 'drawn:drawn-kd']);
    expect(v?.legend.map((r) => r.label)).toEqual([
      'Caspian Lake · ours · 789 ac',
      'Drawn 12 Oct · Kate Donovan',
    ]);
    expect(v?.caption).toBe('8 % on the shore');
  });

  it('a drawing with its skate: the track, and the board’s legend with the skate’s day', () => {
    const v = itemMapScene(DRAWN, DRAWN_MAP, TZ);
    expect(lines(v)).toEqual(['track:kd-11oct']);
    expect(v?.legend.map((r) => r.label)).toEqual([
      'Caspian Lake · ours · 789 ac',
      'Drawn 12 Oct · Kate Donovan',
      'The recorded skate · 11 Oct',
    ]);
  });
});

describe('a short answer, said honestly', () => {
  const cases = [
    ['safety', SAFETY, SAFETY_MAP],
    ['alert', ALERT_FLAG, ALERT_MAP],
    ['access', ACCESS_REPORTS, ACCESS_MAP],
    ['activate', ACTIVATE, ACTIVATE_MAP],
    ['place', PLACE, PLACE_MAP],
    ['drawn', DRAWN, DRAWN_MAP],
  ] as const;

  it.each(cases)('%s: a simplified outline is never drawn as exact', (_, item, map) => {
    expect(itemMapScene(item, SIMPLIFIED(map), TZ)?.caption).toContain('Outline simplified');
  });

  it.each(cases)('%s: a capped answer says not everything is shown', (_, item, map) => {
    expect(itemMapScene(item, CAPPED(map), TZ)?.caption).toContain('Not everything is shown');
  });

  it('a simplified candidate or neighbor is said too', () => {
    const v = itemMapScene(
      ADMIT_MATCH,
      {
        ...ADMIT_MAP,
        candidate: {
          ...(ADMIT_MAP.candidate as NonNullable<typeof ADMIT_MAP.candidate>),
          simplified: true,
        },
      },
      TZ,
    );
    expect(v?.caption).toBe('Outline simplified · Unnamed · 41 ac');
    expect(answerNotes(ADMIT_MAP, [null, null])).toEqual([]);
  });

  it('only a drawn outline’s flag counts, and a capped one says so with nothing simplified', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (simplified, capped) => {
        const m = {
          ...SAFETY_MAP,
          capped,
          body: { ...(SAFETY_MAP.body as NonNullable<typeof SAFETY_MAP.body>), simplified },
        };
        const caption = itemMapScene(SAFETY, m, TZ)?.caption ?? '';
        expect(caption.includes('Outline simplified')).toBe(simplified);
        expect(caption.includes('Not everything is shown')).toBe(capped);
      }),
    );
  });
});

describe('no map at all — the slot collapses', () => {
  it('for a kind with nothing to place', () => {
    expect(kindHasMap(TICKET)).toBe(false);
    expect(kindHasMap(PERSON_FLAG)).toBe(false);
    expect(kindHasMap(GONE_FLAG)).toBe(false);
    expect(kindHasMap(SAFETY)).toBe(true);
    expect(kindHasMap(ACCESS_REPORTS)).toBe(true);
    expect(itemMapScene(TICKET, EMPTY_MAP('ticket'), TZ)).toBeNull();
    expect(itemMapScene(PERSON_FLAG, EMPTY_MAP('flag'), TZ)).toBeNull();
    // Even an answer that carried a body draws nothing for a flag on a person.
    expect(itemMapScene(PERSON_FLAG, SAFETY_MAP, TZ)).toBeNull();
    expect(itemMapScene(GONE_FLAG, SAFETY_MAP, TZ)).toBeNull();
  });

  it('for no such item, and for an answer with nothing in it', () => {
    expect(itemMapScene(SAFETY, null, TZ)).toBeNull();
    for (const [item, kind] of [
      [SAFETY, 'flag'],
      [ALERT_FLAG, 'flag'],
      [ACCESS_REPORTS, 'access'],
      [ADMIT_MATCH, 'request'],
      [PLACE, 'place'],
      [DRAWN, 'drawn'],
    ] as const)
      expect(itemMapScene(item, EMPTY_MAP(kind), TZ)).toBeNull();
  });

  it('draws the body alone where the flagged thing has no point', () => {
    expect(ids(itemMapScene(SAFETY, { ...SAFETY_MAP, points: [] }, TZ))).toEqual(['body:mascoma']);
    expect(ids(itemMapScene(ALERT_FLAG, { ...ALERT_MAP, access: [] }, TZ))).toEqual(['body:morey']);
    expect(ids(itemMapScene(PLACE, { ...PLACE_MAP, points: [] }, TZ))).toEqual(['body:newfound']);
    const onBody = { ...SAFETY, target: { targetType: 'waterbody', exists: true } } as never;
    expect(ids(itemMapScene(onBody, { ...SAFETY_MAP, points: [] }, TZ))).toEqual(['body:mascoma']);
    expect(itemMapScene(onBody, EMPTY_MAP('flag'), TZ)).toBeNull();
  });

  it('a drawing over open land draws the drawing alone, with no shore fact', () => {
    const v = itemMapScene(DRAWN, { ...DRAWN_MAP_NO_TRACK, others: [], overlapShare: null }, TZ);
    expect(ids(v)).toEqual(['drawn:drawn-kd']);
    expect(v?.caption).toBeNull();
  });
});

describe('shoreFact', () => {
  it('is the share outside the body, whole percent, clamped', () => {
    expect(shoreFact(0.92)).toBe('8 % on the shore');
    expect(shoreFact(null)).toBeUndefined();
    expect(shoreFact(Number.NaN)).toBeUndefined();
    fc.assert(
      fc.property(fc.double({ min: -1, max: 2, noNaN: true }), (share) => {
        const n = Number((shoreFact(share) ?? '').split(' ')[0]);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }),
    );
  });
});
