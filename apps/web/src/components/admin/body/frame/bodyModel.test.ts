import { describe, expect, it } from 'vitest';

import { BODY_NOW, MASCOMA_HISTORY, MASCOMA_RECORD } from './bodyFixtures';
import {
  acresText,
  attentionTabs,
  bodyAsks,
  bodyFigures,
  bodyHistory,
  bodyIdentity,
  completeness,
  dayMonth,
  firstName,
  historyTime,
  lengthText,
  missingSentence,
  ringsText,
  statusDate,
} from './bodyModel';

const ctx = { history: MASCOMA_HISTORY, hasBathymetry: false, towns: null };

describe('the lockup', () => {
  it('draws the boards’ figures for Mascoma', () => {
    expect(bodyFigures(MASCOMA_RECORD)).toEqual([
      { label: 'Area', value: '1,143 ac' },
      { label: 'Depth avg / max', value: '9.4 / 24 m' },
      { label: 'Elevation', value: '228 m' },
    ]);
  });

  it('leaves out what nobody measured — never a zero', () => {
    const bare = {
      ...MASCOMA_RECORD,
      surfaceAreaSqM: undefined,
      meanDepthM: undefined,
      maxDepthM: undefined,
      elevationM: undefined,
    };
    expect(bodyFigures(bare).map((f) => f.value)).toEqual([null, null, null]);
    expect(bodyFigures({ ...bare, maxDepthM: 4 })[1]).toEqual({ label: 'Depth max', value: '4 m' });
    expect(bodyFigures({ ...bare, meanDepthM: 12 })[1]).toEqual({
      label: 'Depth avg',
      value: '12 m',
    });
  });

  it('writes acres and lengths the boards’ way', () => {
    expect(acresText(4046.86 * 0.4)).toBe('0.4 ac');
    expect(acresText(4_623_575)).toBe('1,143 ac');
    expect(lengthText(18_301)).toBe('18.3 km');
    expect(lengthText(640)).toBe('640 m');
  });
});

describe('completeness', () => {
  it('reads Mascoma as 9 / 10, missing only bathymetry, on the Water tab', () => {
    const items = completeness(MASCOMA_RECORD, false);
    expect(items).toHaveLength(10);
    expect(items.filter((i) => i.state === 'present')).toHaveLength(9);
    expect(missingSentence(items)).toBe('Missing bathymetry');
    expect([...attentionTabs(items)]).toEqual(['water']);
  });

  it('never counts posted rules or sample points', () => {
    const keys = completeness(MASCOMA_RECORD, true).map((i) => i.key);
    expect(keys).not.toContain('postedRules');
    expect(keys).not.toContain('samplePoints');
  });

  it('draws an unknown part as neither there nor missing', () => {
    const items = completeness(MASCOMA_RECORD, null);
    expect(items.find((i) => i.key === 'bathymetry')?.state).toBe('unknown');
    expect(missingSentence(items)).toBeNull();
    expect(attentionTabs(items).size).toBe(0);
  });

  it('lists what is missing as a sentence', () => {
    const items = completeness(
      { ...MASCOMA_RECORD, name: ' ', type: 'unclassified', elevationM: undefined },
      false,
    );
    expect(missingSentence(items)).toBe('Missing name, class, elevation and bathymetry');
    expect([...attentionTabs(items)].sort()).toEqual(['names', 'water']);
  });
});

describe('the identity list', () => {
  const id = bodyIdentity(MASCOMA_RECORD, ctx);

  it('names the body, its kind and its catalogs', () => {
    expect(id.name).toBe('Mascoma Lake');
    expect(id.kind).toBe('Reservoir');
    expect(id.names).toEqual({ primary: 'Mascoma Lake', tag: 'NHD', aliases: [] });
    expect(id.ids).toEqual([
      { tag: 'OSM', value: 'relation/4056603' },
      { tag: 'NHD', value: '120802878' },
      { tag: '3DHP', value: 'JDYXT' },
      { tag: 'GNIS', value: '868293' },
    ]);
    expect(id.outline).toEqual({ tag: 'OSM', rings: 'The shore and 3 islands' });
    expect(id.shoreline).toBe('18.3 km');
  });

  it('carries the year on a status date, and names who ruled', () => {
    expect(id.standing).toEqual({
      badge: 'Active',
      tone: 'lit',
      since: 'Since 17 Sep 2026',
      note: null,
    });
    expect(id.access).toEqual({
      badge: 'Accessible',
      ruled: 'Ruled 21 Sep 2026',
      by: { name: 'Teagan' },
    });
    expect(id.boost).toEqual({ value: 0.3, note: 'Set 19 Sep 2026 by Teagan.' });
  });

  it('says *No public access* for a none ruling, and dormant since it', () => {
    const none = bodyIdentity(
      {
        ...MASCOMA_RECORD,
        publicAccess: { verdict: 'none', decidedAt: BODY_NOW, decidedByUserId: 'x' as never },
      },
      ctx,
    );
    expect(none.access?.badge).toBe('No public access');
    expect(none.standing).toMatchObject({
      badge: 'Dormant',
      tone: 'dim',
      note: 'No public access',
    });
  });

  it('draws no ruling, no boost note and no ids that were never recorded', () => {
    const bare = bodyIdentity(
      {
        ...MASCOMA_RECORD,
        publicAccess: undefined,
        curatedBoost: undefined,
        osmId: undefined,
        nhdId: undefined,
        threeDhpId: undefined,
        gnisId: undefined,
        activatedAt: undefined,
        shorelineM: undefined,
      },
      { history: [], hasBathymetry: null, towns: null },
    );
    expect(bare.access).toBeNull();
    expect(bare.boost).toEqual({ value: 0, note: null });
    expect(bare.ids).toEqual([]);
    expect(bare.standing.since).toBeNull();
    expect(bare.shoreline).toBeNull();
  });

  it('lists the names that lost as aliases, once each', () => {
    const named = bodyIdentity(
      {
        ...MASCOMA_RECORD,
        nameClaims: [
          { source: 'gnis', value: 'Mascoma Lake' },
          { source: 'osm', value: 'Lake Mascoma' },
          { source: 'user', value: 'Lake Mascoma' },
        ],
      },
      ctx,
    );
    expect(named.names).toEqual({
      primary: 'Mascoma Lake',
      tag: 'GNIS',
      aliases: ['Lake Mascoma'],
    });
  });

  it('removed and unlisted bodies read their standing', () => {
    expect(
      bodyIdentity({ ...MASCOMA_RECORD, removedAt: BODY_NOW, removalReason: 'junk' }, ctx).standing,
    ).toMatchObject({ badge: 'Removed', note: 'Junk' });
    expect(bodyIdentity({ ...MASCOMA_RECORD, dedupStatus: 'merged' }, ctx).standing.badge).toBe(
      'Unlisted',
    );
  });
});

describe('rings', () => {
  it('counts shores and islands', () => {
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(ringsText({ type: 'Polygon', coordinates: [ring] })).toBe('The shore');
    expect(ringsText({ type: 'Polygon', coordinates: [ring, ring] })).toBe(
      'The shore and 1 island',
    );
    expect(ringsText({ type: 'MultiPolygon', coordinates: [[ring], [ring, ring, ring]] })).toBe(
      '2 shores and 2 islands',
    );
  });
});

describe('asks and history', () => {
  it('words each ask and points it at the tab that handles it', () => {
    const asks = bodyAsks({
      bays: [
        {
          requestId: 'r1',
          name: 'Shaker cove',
          askers: 3,
          createdAt: 1,
          notes: ['Near the bridge'],
        },
      ],
      placeNames: [{ _id: 'p1', name: 'the Narrows', messages: 1 }],
      landmarks: [{ requestId: 'r2', name: 'the flats', askers: 1, createdAt: 2 }],
    });
    expect(asks.map((a) => [a.id, a.kicker, a.tab, a.sub])).toEqual([
      ['ask:r1', 'Bay request · 3 skaters', 'shape', 'Near the bridge'],
      ['placeName:p1', 'Place name · 1 email', 'places', null],
      ['landmarkAsk:r2', 'Landmark proposal · 1 skater', 'places', null],
    ]);
  });

  it('names staff by first name and says what they did from the operator’s side', () => {
    const rows = bodyHistory(MASCOMA_HISTORY);
    expect(rows[1]).toEqual({
      id: 'h4',
      at: MASCOMA_HISTORY[1]?.createdAt,
      who: 'Teagan',
      what: 'Ruled on public access',
    });
    expect(bodyHistory([{ ...MASCOMA_HISTORY[0]!, actor: null }])[0]?.who).toBeNull();
    expect(firstName('  Matt  Steinberg ')).toBe('Matt');
  });
});

describe('clock words', () => {
  it('writes September as Sep, never Sept', () => {
    const sep = new Date(2026, 8, 17, 12).getTime();
    expect(dayMonth(sep)).toBe('17 Sep');
    expect(statusDate(sep)).toBe('17 Sep 2026');
  });

  it('reads a row’s time as the clock today, the weekday this week, else the date', () => {
    const now = BODY_NOW; // Wednesday 14 Oct 2026, local noon
    expect(historyTime(new Date(2026, 9, 14, 9, 5).getTime(), now)).toBe('09:05');
    expect(historyTime(new Date(2026, 9, 10, 12).getTime(), now)).toBe('Sat');
    expect(historyTime(new Date(2026, 9, 8, 12).getTime(), now)).toBe('Thu');
    expect(historyTime(new Date(2026, 9, 7, 12).getTime(), now)).toBe('7 Oct');
  });

  it('takes the reader’s zone for the day', () => {
    // 02:00 UTC Thursday is still Wednesday evening in New York.
    const at = Date.UTC(2026, 9, 15, 2);
    const now = Date.UTC(2026, 9, 15, 3);
    expect(historyTime(at, now, 'America/New_York')).toBe('22:00');
    expect(statusDate(at, 'America/New_York')).toBe('14 Oct 2026');
    expect(statusDate(at, 'UTC')).toBe('15 Oct 2026');
  });
});
