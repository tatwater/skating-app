import { COMPLETENESS_FIELDS } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BODY_NOW, MASCOMA_HISTORY, MASCOMA_ID, MASCOMA_RECORD, on } from './bodyFixtures';
import {
  acresText,
  attentionTabs,
  bodyAsks,
  bodyFigures,
  bodyHistory,
  bodyIdentity,
  COMPLETENESS_TABS,
  dayMonth,
  firstName,
  type HistoryAction,
  historyHead,
  historyTime,
  latestOnBody,
  lengthText,
  outlineTrust,
  removalFromLeft,
  removalOf,
  ringsText,
  statusDate,
} from './bodyModel';

const ctx = { history: MASCOMA_HISTORY };

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

  it('writes a modeled depth as an estimate, never as a sounding', () => {
    const modeled = {
      ...MASCOMA_RECORD,
      meanDepthSource: 'globathy' as const,
      maxDepthSource: 'state_agency' as const,
    };
    expect(bodyFigures(modeled)[1]).toEqual({ label: 'Depth avg / max', value: '~9.4 / 24 m' });
    expect(
      bodyFigures({ ...modeled, meanDepthM: undefined, maxDepthSource: 'hydrolakes_modeled' })[1],
    ).toEqual({ label: 'Depth max', value: '~24 m' });
    // A depth whose source isn't recorded: nothing vouches for it, so it reads as an estimate too,
    // as core's caption reads it.
    expect(
      bodyFigures({ ...MASCOMA_RECORD, meanDepthSource: undefined, maxDepthSource: undefined })[1],
    ).toEqual({ label: 'Depth avg / max', value: '~9.4 / ~24 m' });
  });

  it('writes acres and lengths the boards’ way', () => {
    expect(acresText(4046.86 * 0.4)).toBe('0.4 ac');
    expect(acresText(4_623_575)).toBe('1,143 ac');
    expect(lengthText(18_301)).toBe('18.3 km');
    expect(lengthText(640)).toBe('640 m');
  });
});

describe('completeness’s amber squares', () => {
  it('flags the tab of each field the stored answer says is missing — Water for bathymetry', () => {
    expect([...attentionTabs(['bathymetry'])]).toEqual(['water']);
    expect([...attentionTabs([])]).toEqual([]);
    expect(
      [...attentionTabs(['name', 'elevation', 'lots', 'landmarks', 'bathymetry'])].sort(),
    ).toEqual(['access', 'names', 'places', 'water']);
  });

  it('flags exactly the tabs that hold a missing field, for any stored answer (property)', () => {
    fc.assert(
      fc.property(fc.subarray([...COMPLETENESS_FIELDS]), (missing) => {
        const tabs = attentionTabs(missing);
        expect([...tabs].sort()).toEqual(
          [...new Set(missing.map((f) => COMPLETENESS_TABS[f]))].sort(),
        );
        // Nothing missing flags nothing: an answer never invents a gap.
        if (missing.length === 0) expect(tabs.size).toBe(0);
      }),
    );
  });

  it('has a tab for every one of the founder’s ten, and never posted rules or sample points', () => {
    expect(Object.keys(COMPLETENESS_TABS).sort()).toEqual([...COMPLETENESS_FIELDS].sort());
    expect(Object.keys(COMPLETENESS_TABS)).not.toContain('postedRules');
    expect(Object.keys(COMPLETENESS_TABS)).not.toContain('samplePoints');
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
      { history: [] },
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
    expect(rows[2]).toEqual({
      id: 'h4',
      at: MASCOMA_HISTORY[2]?.createdAt,
      who: 'Teagan',
      what: 'Ruled on public access',
    });
    expect(
      bodyHistory([
        {
          id: 'x',
          action: 'set_standing',
          targetType: 'waterbody',
          targetId: 'b',
          createdAt: 0,
          actor: null,
        },
      ])[0]?.who,
    ).toBeNull();
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

describe('the family’s history', () => {
  const row = (over: Partial<HistoryAction>): HistoryAction => ({
    id: 'r',
    action: 'set_public_access',
    targetType: 'waterbody',
    targetId: MASCOMA_ID,
    createdAt: on(9, 1),
    actor: { displayName: 'Sarah Berman', username: 'sarah' },
    ...over,
  });

  it('takes the body’s own row of a verb, never a bay’s or an absorbed body’s', () => {
    const rows = [
      row({ id: 'absorbed', targetId: 'other' }),
      row({ id: 'bay', targetType: 'waterBodySubArea' }),
      row({ id: 'own' }),
    ];
    expect(latestOnBody(rows, MASCOMA_ID, 'set_public_access')?.id).toBe('own');
    expect(latestOnBody(rows.slice(0, 2), MASCOMA_ID, 'set_public_access')).toBeNull();
  });

  it('names nobody for a ruling no row read records — never a guess', () => {
    const noRow = bodyIdentity(MASCOMA_RECORD, { history: [row({ targetId: 'absorbed' })] });
    expect(noRow.access).toMatchObject({ badge: 'Accessible', by: null });
    expect(noRow.boost.note).toBeNull();
  });

  it('counts the changes only when the read was whole; a capped read says how many it shows', () => {
    const entries = bodyHistory(MASCOMA_HISTORY);
    expect(historyHead({ entries, capped: false })).toBe('6 changes');
    expect(historyHead({ entries: entries.slice(0, 1), capped: false })).toBe('1 change');
    expect(historyHead({ entries: [], capped: false })).toBe('0 changes');
    expect(historyHead({ entries, capped: true })).toBe('Latest 6');
    expect(historyHead({ entries: [], capped: true })).toBeNull();
  });

  it('never writes a capped count as a total (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 120 }), fc.boolean(), (n, capped) => {
        const entries = Array.from({ length: n }, (_, i) => ({
          id: String(i),
          at: 0,
          who: null,
          what: 'x',
        }));
        const head = historyHead({ entries, capped });
        if (capped) expect(head === null || /^Latest /.test(head)).toBe(true);
        else expect(head).toMatch(/ changes?$/);
      }),
    );
  });
});

describe('the outline’s trust', () => {
  it('says since when and how, and nothing when neither is recorded', () => {
    expect(
      outlineTrust({ outlineTrustedSince: on(10, 12), outlineTrustedVia: 'campaign' }),
    ).toEqual({ since: 'Since 12 Oct 2026', via: 'An import re-affirmed it' });
    expect(
      outlineTrust({ outlineTrustedSince: on(9, 3), outlineTrustedVia: 'approved' })?.via,
    ).toBe('A moderator approved it');
    expect(outlineTrust({ outlineTrustedSince: null, outlineTrustedVia: null })).toBeNull();
    expect(outlineTrust({ outlineTrustedSince: on(9, 3), outlineTrustedVia: null })).toBeNull();
  });
});

describe('a body that left', () => {
  const base: HistoryAction = {
    id: 'x',
    action: 'reject_waterbody',
    targetType: 'waterbody',
    targetId: MASCOMA_ID,
    createdAt: on(10, 2),
    actor: { displayName: 'Teagan Atwater', username: 'teagan' },
    reason: '  Drawn over the town beach  ',
  };

  it('says when, by whom and why it was rejected', () => {
    expect(removalOf([base], MASCOMA_ID)).toEqual({
      verb: 'Rejected',
      when: '2 Oct 2026',
      who: 'Teagan',
      reason: 'Drawn over the town beach',
    });
  });

  it('says a merge, the machine by no name, and no reason when it gave none', () => {
    expect(
      removalOf([{ ...base, action: 'merge_waterbody', actor: null, reason: ' ' }], MASCOMA_ID),
    ).toEqual({ verb: 'Merged', when: '2 Oct 2026', who: null, reason: null });
  });

  it('from the row its standing names: the listed reason for a removal, the row’s words, who decided', () => {
    const left = {
      action: 'remove' as const,
      at: on(10, 2),
      reason: ' ',
      removalReason: 'unskateable' as const,
      by: { displayName: 'Teagan Atwater' },
    };
    expect(removalFromLeft(left)).toEqual({
      verb: 'Removed',
      when: '2 Oct 2026',
      who: 'Teagan',
      reason: null,
      because: 'Not skateable',
    });
    expect(
      removalFromLeft({
        ...left,
        action: 'reject_waterbody',
        reason: 'Drawn over the beach',
        removalReason: null,
        by: null,
      }),
    ).toEqual({ verb: 'Rejected', when: '2 Oct 2026', who: null, reason: 'Drawn over the beach' });
  });

  it('a removal says the moderator’s own words whole — never the composed audit sentence that may be shortened', () => {
    const note = `${'The landowner asked us to take it off the map; '.repeat(60)}posted gates.`;
    const left = {
      action: 'remove' as const,
      at: on(10, 2),
      // The composed sentence, shortened under the reason cap.
      reason: 'Removed from map (landowner request): The landowner asked us…',
      removalReason: 'landowner_request' as const,
      note,
      by: { displayName: 'Teagan Atwater' },
    };
    expect(removalFromLeft(left).reason).toBe(note);
    // No note: the row's reason stands in.
    expect(removalFromLeft({ ...left, note: null }).reason).toBe(left.reason);
    expect(removalFromLeft({ ...left, note: '  ' }).reason).toBe(left.reason);
  });

  it('finds nothing in another body’s rows, or in rows of other verbs', () => {
    expect(removalOf([{ ...base, targetId: 'other' }], MASCOMA_ID)).toBeNull();
    expect(removalOf([{ ...base, action: 'remove' }], MASCOMA_ID)).toBeNull();
    expect(removalOf([], MASCOMA_ID)).toBeNull();
  });
});
