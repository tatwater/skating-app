import { describe, expect, it } from 'vitest';

import {
  ADMIN_ROLE,
  activate,
  activateMany,
  activateNoDormancy,
  admit,
  admitFlowing,
  admitNoMatch,
  contest,
  FLOWING,
  KINDS,
  MODERATOR_ROLE,
  OWN_FILING,
  POST_POND_SHELVED,
  REQUEST_NOW,
  REQUEST_TZ,
  restore,
  TARLETON_DORMANCY,
  takedown,
  UNNAMED_POND,
  VIEWERS,
  type Viewer,
} from './requestFixtures';
import {
  bodyKicker,
  bodyRows,
  catalogRows,
  dormancyRows,
  headAge,
  headTitle,
  ifBlocks,
  noMatchRows,
  primaryAsk,
  receiptOf,
  refusalNote,
  requestBar,
  subjectOf,
} from './requestModel';

/**
 * Board 2.3 and the kinds derived from it, as data: every lever from the item's `can` alone — the
 * whole table of request kinds × the viewers the rule tells apart — and what the blocks and the
 * receipts say.
 */

type Kind = keyof typeof KINDS;

/** What each viewer's bar draws, by kind: the buttons' labels, in order. */
const BARS: Record<Kind, Record<Viewer, string[]>> = {
  admit: {
    admin: ['Admit', 'Decline'],
    moderator: ['Admit', 'Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  admitNoMatch: {
    admin: ['Look up again', 'Decline'],
    moderator: ['Look up again', 'Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  admitPending: {
    admin: ['Look up again', 'Decline'],
    moderator: ['Look up again', 'Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  admitFlowing: {
    admin: ['Decline'],
    moderator: ['Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  activate: {
    admin: ['Activate', 'Decline'],
    moderator: ['Activate', 'Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  restore: {
    admin: ['Restore', 'Decline'],
    // An admin's both ways: the server refuses a moderator both levers, so no bar at all.
    moderator: [],
    filer: [],
    noRole: [],
    decided: [],
  },
  contest: {
    admin: ['Confirm accessible', 'Decline'],
    moderator: ['Confirm accessible', 'Decline'],
    filer: [],
    noRole: [],
    decided: [],
  },
  takedown: {
    admin: ['Take it down', 'Decline'],
    moderator: [],
    filer: [],
    noRole: [],
    decided: [],
  },
};

/** What each viewer's item says in place of the levers it refuses. */
const NOTES: Record<Kind, Record<Viewer, ReturnType<typeof refusalNote>>> = (() => {
  const common = { filer: [OWN_FILING], noRole: [MODERATOR_ROLE], decided: null };
  const open = { admin: null, moderator: null, ...common };
  // A restore or takedown is an admin's both ways: the server's one sentence for both levers.
  const adminOnly = {
    admin: null,
    moderator: [ADMIN_ROLE],
    filer: [OWN_FILING],
    noRole: [ADMIN_ROLE],
    decided: null,
  };
  return {
    admit: open,
    admitNoMatch: open,
    admitPending: open,
    admitFlowing: { admin: [FLOWING], moderator: [FLOWING], ...common },
    activate: open,
    contest: open,
    restore: adminOnly,
    takedown: adminOnly,
  };
})();

describe('every lever from the item’s can: each request kind × each viewer', () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    for (const viewer of VIEWERS) {
      it(`${kind}, as ${viewer}`, () => {
        const item = KINDS[kind](viewer);
        expect(requestBar(item).map((b) => b.label)).toEqual(BARS[kind][viewer]);
        expect(refusalNote(item)).toEqual(NOTES[kind][viewer]);
        // Never a button for a verb the item refuses or doesn't answer.
        for (const b of requestBar(item)) expect(item.can[b.verb]).toBeNull();
      });
    }
  }

  it('draws no verb the item doesn’t answer, even one it would allow elsewhere', () => {
    const item = { ...admit(), can: { decline: null } };
    expect(requestBar(item).map((b) => b.verb)).toEqual(['decline']);
    expect(requestBar({ ...admit(), can: {} })).toEqual([]);
  });

  it('keys and colors each lever as the board does: A Admit, D Decline in red', () => {
    expect(requestBar(admit()).map((b) => [b.hotkey, b.danger, b.asks])).toEqual([
      ['A', false, null],
      ['D', true, 'note'],
    ]);
    expect(requestBar(admitNoMatch())[0]).toMatchObject({ hotkey: 'L', asks: null });
    expect(requestBar(restore())[0]).toMatchObject({ hotkey: 'R', asks: null });
    // A takedown's approval is red, and asks its reason.
    expect(requestBar(takedown())[0]).toMatchObject({
      label: 'Take it down',
      hotkey: 'T',
      danger: true,
      asks: 'reason',
    });
  });
});

describe('the head', () => {
  it('says the kind and who asked, how long ago', () => {
    expect(headTitle('admit')).toBe('Admit a body');
    // The founder-approved names for the kinds the board doesn't draw.
    expect(headTitle('activate')).toBe('Activation');
    expect(headTitle('restore')).toBe('Restoration');
    expect(headTitle('contest_access')).toBe('Access contested');
    expect(headTitle('takedown')).toBe('Takedown');
    expect(headAge(admit(), '3 days ago')).toBe('Asked by 2 · 3 days ago');
    expect(headAge(activateMany(), '7 hours ago')).toBe('Asked by 500+ · 7 hours ago');
  });

  it('names the item by its body, its catalog feature, or as unnamed water', () => {
    expect(subjectOf(activate())).toBe('Lake Tarleton');
    expect(subjectOf({ body: null, candidate: { ...UNNAMED_POND, name: 'Lot Pond' } })).toBe(
      'Lot Pond',
    );
    expect(subjectOf(admit())).toBe('Unnamed water');
  });

  it('sends a decision for the ask the server names, never one it infers', () => {
    const item = admit();
    expect(primaryAsk(item)?.requestId).toBe(item.primaryRequestId);
    const second = item.asks[1] as (typeof item.asks)[number];
    expect(primaryAsk({ ...item, primaryRequestId: second.requestId })).toBe(second);
    // Named but not served (the list was cut before it): nothing to send from here.
    expect(primaryAsk({ asks: [], primaryRequestId: item.primaryRequestId })).toBeNull();
  });
});

describe('the blocks', () => {
  it('draws 2.3’s catalog: source, class, area, no name, the match, the nearest body', () => {
    expect(catalogRows(UNNAMED_POND, REQUEST_NOW)).toEqual([
      { label: 'Source', value: '3DHP · YQ4K2', mono: true },
      { label: 'Class', value: 'Lake or pond' },
      { label: 'Area', value: '41 ac' },
      { label: 'Name', value: 'None in any catalog' },
      { label: 'Matched', value: '3 d ago · 125 ft from the ask' },
      // The console's one distance format, from the served meters.
      { label: 'Nearest', value: 'Ricker Pond · 0.8 mi' },
    ]);
  });

  it('names the nearest body only when the read found one: none served, no row', () => {
    const rows = catalogRows({ ...UNNAMED_POND, nearestKnown: null }, REQUEST_NOW);
    expect(rows.map((r) => r.label)).not.toContain('Nearest');
    // A name and a distance from the server, each as served.
    const near = catalogRows(
      {
        ...UNNAMED_POND,
        nearestKnown: { waterBodyId: 'x' as never, name: 'Post Pond', meters: 40 },
      },
      REQUEST_NOW,
    );
    expect(near.at(-1)).toEqual({ label: 'Nearest', value: 'Post Pond · 131 ft' });
  });

  it('says why an admit has no match, or that the lookup hasn’t answered', () => {
    expect(noMatchRows(admitNoMatch())).toEqual([
      { label: 'Lookup', value: 'No 3DHP feature within 150 m' },
    ]);
    expect(noMatchRows({ resolveError: null })).toEqual([
      { label: 'Lookup', value: 'Not answered yet' },
    ]);
  });

  it('draws the body we hold, and a removal', () => {
    const r = restore();
    expect(bodyKicker(activate().body as NonNullable<typeof r.body>)).toBe(
      'Lake or pond · Piermont, NH · 329 ac',
    );
    expect(bodyRows(r.body as NonNullable<typeof r.body>)).toContainEqual({
      label: 'Standing',
      value: 'Removed',
    });
    expect(
      bodyRows(activate().body as NonNullable<typeof r.body>).map((x) => x.label),
    ).not.toContain('Standing');
  });

  it('says 2.3’s two futures, and each kind’s', () => {
    expect(ifBlocks(admit())).toEqual({
      first: {
        title: 'Admitting it',
        rows: [
          { label: 'Adds', value: 'The outline as an active body' },
          { label: 'Closes', value: '2 asks · both told' },
          { label: 'Then', value: 'Enrichment queues it' },
        ],
      },
      declined: {
        title: 'Declining it',
        rows: [
          { label: 'Adds', value: 'Nothing' },
          { label: 'Closes', value: '2 asks · told, with your note' },
        ],
      },
    });
    expect(ifBlocks(admitNoMatch()).first.title).toBe('Looking it up again');
    expect(ifBlocks(activate()).first.rows.map((r) => r.value)).toContain(
      'Enrichment queues it if it has none',
    );
    expect(ifBlocks(takedown()).first.title).toBe('Taking it down');
    expect(ifBlocks(activateMany()).first.rows).toContainEqual({
      label: 'Closes',
      value: '500+ asks · all told',
    });
    expect(ifBlocks(restore()).declined.rows).toContainEqual({
      label: 'Closes',
      value: '1 ask · told, with your note',
    });
  });
});

describe('the receipt', () => {
  it('says what landed and what it closes, in the present tense', () => {
    expect(receiptOf(admit(), { kind: 'approve' })).toEqual({
      title: 'Admitted',
      description: 'Closes 2 asks · each asker told',
    });
    expect(receiptOf(takedown(), { kind: 'approve', note: 'Owner' }).title).toBe('Taken down');
    expect(receiptOf(activateMany(), { kind: 'decline', note: 'No' })).toEqual({
      title: 'Declined',
      description: 'Closes 500+ asks · each asker told',
    });
  });

  it('says a lookup is under way', () => {
    expect(receiptOf(admitNoMatch(), { kind: 'lookUpAgain' })).toEqual({
      title: 'Looking it up again',
      description: 'The catalog answers in a moment',
    });
  });
});

describe('the flowing-water admit', () => {
  it('says the server’s sentence and draws only Decline', () => {
    const item = admitFlowing();
    expect(refusalNote(item)).toEqual([FLOWING]);
    expect(requestBar(item).map((b) => b.verb)).toEqual(['decline']);
  });
});

describe('an activate’s dormancy (in Activating it)', () => {
  it('says why the body is dormant and since when, in the Body console’s words', () => {
    expect(dormancyRows(TARLETON_DORMANCY, REQUEST_TZ)).toEqual([
      { label: 'Dormant', value: 'Inactive · since 18 Dec 2025' },
    ]);
    expect(ifBlocks(activate(), REQUEST_TZ).first.rows[0]).toEqual({
      label: 'Dormant',
      value: 'Inactive · since 18 Dec 2025',
    });
  });

  it('adds the moderator’s note and who set it, by first name, only when served', () => {
    expect(dormancyRows(POST_POND_SHELVED, REQUEST_TZ)).toEqual([
      { label: 'Dormant', value: 'Moderator · since 24 Sep 2026' },
      { label: 'Note', value: '“Shelved while the town rebuilds the launch.”' },
      { label: 'Set by', value: 'Matt' },
    ]);
    expect(dormancyRows({ ...POST_POND_SHELVED, note: '  ', by: null }, REQUEST_TZ)).toHaveLength(
      1,
    );
  });

  it('draws nothing when the read serves none — never an invented reason', () => {
    const labels = ifBlocks(activateNoDormancy(), REQUEST_TZ).first.rows.map((r) => r.label);
    expect(labels).not.toContain('Dormant');
    expect(labels[0]).toBe('Returns');
    // And no other kind draws one.
    for (const k of [admit, restore, takedown, contest]) {
      expect(ifBlocks(k(), REQUEST_TZ).first.rows.map((r) => r.label)).not.toContain('Dormant');
    }
  });
});
