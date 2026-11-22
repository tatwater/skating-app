import { describe, expect, it } from 'vitest';
import { REQUEST_KINDS } from './corpusRequests';
import { hazardLifecyclePhase } from './hazardLifecycle';
import {
  describeActors,
  describeNotification,
  NOTIFICATION_PREF_DEFAULTS,
  NOTIFICATION_PREF_KEY_FOR,
  NOTIFICATION_PREF_KEYS,
  NOTIFICATION_PREF_LABELS,
  NOTIFICATION_PREF_ORDER,
  NOTIFICATION_TYPES,
  type NotificationView,
  timezoneToSync,
} from './notifications';

const base = { id: 'n1', createdAt: 1_700_000_000_000 };
const lake = { id: 'b1', name: 'Lake Morey' };
const ok = { id: 'r1', available: true };
const gone = { id: 'r1', available: false };

describe('the notification vocabulary (D16 / D168)', () => {
  it('mirrors types and pref keys 1:1, and every key has a default, a label and a place in the order', () => {
    expect(NOTIFICATION_PREF_KEYS).toHaveLength(NOTIFICATION_TYPES.length);
    for (const type of NOTIFICATION_TYPES) {
      const key = NOTIFICATION_PREF_KEY_FOR[type];
      expect(NOTIFICATION_PREF_KEYS).toContain(key);
      expect(typeof NOTIFICATION_PREF_DEFAULTS[key]).toBe('boolean');
      expect(NOTIFICATION_PREF_LABELS[key].length).toBeGreaterThan(0);
    }
    expect([...NOTIFICATION_PREF_ORDER].sort()).toEqual([...NOTIFICATION_PREF_KEYS].sort());
  });
});

describe('describeActors', () => {
  it('reads naturally at one, two, three and many', () => {
    expect(describeActors({ names: [], count: 0 })).toBe('Someone');
    expect(describeActors({ names: ['Ellie'], count: 1 })).toBe('Ellie');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 2 })).toBe('Ellie and Sam');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 3 })).toBe('Ellie, Sam and 1 other');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 6 })).toBe('Ellie, Sam and 4 others');
    // A page that resolved only one name for a larger count still counts the rest.
    expect(describeActors({ names: ['Ellie'], count: 3 })).toBe('Ellie and 2 others');
  });
});

describe('describeNotification', () => {
  it('a thumb names the actors, the lake and the target kind, and taps through', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_rated',
      kind: 'thumb',
      targetType: 'hazard',
      target: { id: 'h1', available: true },
      body: lake,
      actors: { names: ['Ellie'], count: 1 },
    };
    expect(describeNotification(view)).toEqual({
      title: 'Ellie found your hazard on Lake Morey helpful',
      target: { kind: 'hazard', id: 'h1' },
    });
  });

  it('a degraded target is described and not tappable (A08 #5)', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_commented',
      reply: false,
      target: gone,
      body: null,
      actors: { names: ['Sam'], count: 1 },
      count: 1,
    };
    const d = describeNotification(view);
    expect(d.title).toBe('Sam commented on a report that’s no longer available');
    expect(d.target).toBeNull();
  });

  it('a reply reads as a reply and a burst carries its count', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_commented',
      reply: true,
      target: ok,
      body: lake,
      actors: { names: ['Sam', 'Ada'], count: 3 },
      count: 4,
    };
    expect(describeNotification(view)).toEqual({
      title: 'Sam, Ada and 1 other replied to your comment on Lake Morey',
      detail: '4 new comments',
      target: { kind: 'report', id: 'r1' },
    });
  });

  it('hazard phases each have a sentence', () => {
    for (const phase of ['confirmed', 'healing_unsafe', 'disputed', 'archived'] as const) {
      const d = describeNotification({
        ...base,
        type: 'hazard_confirmation',
        target: { id: 'h1', available: true },
        body: lake,
        phase,
      });
      expect(d.title).toContain('Lake Morey');
      expect(d.target).toEqual({ kind: 'hazard', id: 'h1' });
    }
  });

  it('a flag verdict says only the verdict', () => {
    const d = describeNotification({
      ...base,
      type: 'content_flag_resolved',
      resolution: 'dismissed',
    });
    expect(d.title).toBe('A moderator reviewed something you flagged and left it up');
    expect(d.target).toBeNull();
  });

  it('a single report in a named bay says the bay, with the lake in parentheses (A09)', () => {
    expect(
      describeNotification({
        ...base,
        type: 'favorite_report',
        target: ok,
        body: { id: 'b1', name: 'Lake Champlain' },
        count: 1,
        subAreaName: 'Malletts Bay',
      }).title,
    ).toBe('New report in Malletts Bay (Lake Champlain)');
    expect(
      describeNotification({
        ...base,
        type: 'great_report_nearby',
        target: ok,
        body: { id: 'b1', name: 'Lake Champlain' },
        count: 1,
        subAreaName: 'Malletts Bay',
      }).title,
    ).toBe('Great ice reported in Malletts Bay (Lake Champlain)');
    // A bucket of several may span bays, so it names the lake even when a bay is supplied.
    expect(
      describeNotification({
        ...base,
        type: 'favorite_report',
        target: ok,
        body: { id: 'b1', name: 'Lake Champlain' },
        count: 2,
        subAreaName: 'Malletts Bay',
      }).title,
    ).toBe('2 new reports on Lake Champlain');
  });

  it('report buckets land on the lake, the digest summarizes across lakes', () => {
    expect(
      describeNotification({
        ...base,
        type: 'great_report_nearby',
        target: ok,
        body: lake,
        count: 2,
      }),
    ).toEqual({ title: '2 great reports on Lake Morey', target: { kind: 'water', id: 'b1' } });
    expect(
      describeNotification({
        ...base,
        type: 'nearby_report_digest',
        bodies: [
          { body: lake, target: ok, count: 2 },
          {
            body: { id: 'b2', name: 'Lake Fairlee' },
            target: { id: 'r2', available: true },
            count: 1,
          },
        ],
        totalCount: 3,
      }),
    ).toEqual({
      title: '3 new reports near you across 2 lakes',
      detail: 'Lake Morey · Lake Fairlee',
      target: { kind: 'water', id: 'b1' },
    });
  });

  it('the unknown row is a sentence too', () => {
    const d = describeNotification({ ...base, type: 'unknown' });
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.target).toBeNull();
  });

  it('a recorded skate names the lake, carries its own time in the given zone, and lands on the list (A08 §2.4)', () => {
    // 2026-01-10 19:00Z — 2pm in New York, 11am in Los Angeles. The zone decides which one the
    // detail line says; a server composing this in UTC must pass the recipient's.
    const view: NotificationView = {
      ...base,
      type: 'activity_detected',
      activityId: 'a1',
      body: lake,
      startTime: Date.UTC(2026, 0, 10, 19, 0),
    };
    const east = describeNotification(view, { timeZone: 'America/New_York' });
    expect(east.title).toBe('You skated on Lake Morey. Add a report?');
    expect(east.detail).toMatch(/2:00 PM/);
    expect(east.target).toEqual({ kind: 'unreported_skates' });
    expect(describeNotification(view, { timeZone: 'America/Los_Angeles' }).detail).toMatch(
      /11:00 AM/,
    );
    expect(describeNotification({ ...view, body: null }).title).toBe(
      'You recorded a skate. Add a report?',
    );
  });
});

describe('describeNotification — a moderator’s decision (D285)', () => {
  type Decision = Extract<NotificationView, { type: 'moderator_decision' }>;
  const decision = (over: Omit<Partial<Decision>, 'type'>): Decision => ({
    ...base,
    type: 'moderator_decision',
    about: 'admit',
    outcome: 'approved',
    body: lake,
    ...over,
  });
  const ABOUTS: Decision['about'][] = [...REQUEST_KINDS, 'drawn', 'accessAlert'];
  const OUTCOMES: Decision['outcome'][] = [
    'approved',
    'declined',
    'merged',
    'rejected',
    'retracted',
  ];
  /** The pairs a writer gives: an ask is approved or declined, a drawing approved, rejected or merged. */
  const written = (about: Decision['about'], outcome: Decision['outcome']) =>
    about === 'accessAlert'
      ? outcome === 'retracted'
      : about === 'drawn'
        ? outcome === 'approved' || outcome === 'rejected' || outcome === 'merged'
        : outcome === 'approved' || outcome === 'declined';
  // D3: what was decided, never a word on the ice.
  const ICE_WORDS = /\b(safe|unsafe|skateable|skatable|good to go|thick|solid|ice|clear)\b/i;

  it('words an approved ask by what it did, with the lake', () => {
    const titles = Object.fromEntries(
      REQUEST_KINDS.map((about) => [about, describeNotification(decision({ about })).title]),
    );
    expect(titles).toEqual({
      activate: 'Gli added Lake Morey to the map',
      admit: 'Gli added Lake Morey to the map',
      restore: 'Gli put Lake Morey back on the map',
      contest_access: 'Gli marked Lake Morey as having public access',
      takedown: 'Gli took Lake Morey off the map, as you asked',
      name_bay: 'Gli added the bay you named on Lake Morey',
      name_landmark: 'Gli added the place you named on Lake Morey',
    });
    expect(describeNotification(decision({ about: 'activate' })).target).toEqual({
      kind: 'water',
      id: 'b1',
    });
    // A takedown took the lake off the map: the tap goes nowhere.
    expect(describeNotification(decision({ about: 'takedown' })).target).toBeNull();
  });

  it('a decline says what was asked and carries the moderator’s note as its second line (D179)', () => {
    const d = describeNotification(
      decision({
        about: 'name_bay',
        outcome: 'declined',
        note: '  Already on the map as Long Bay  ',
      }),
    );
    expect(d).toEqual({
      title: 'Your request to name a bay on Lake Morey was declined',
      detail: 'Already on the map as Long Bay',
      target: { kind: 'water', id: 'b1' },
    });
    // An admit has no lake yet; the sentence stands without one.
    expect(
      describeNotification(
        decision({ about: 'admit', outcome: 'declined', body: null, note: 'No' }),
      ),
    ).toEqual({ title: 'Your request to add a lake was declined', detail: 'No', target: null });
    // A blank note is no second line.
    expect(
      describeNotification(decision({ about: 'restore', outcome: 'declined', note: '  ' })).detail,
    ).toBeUndefined();
    // An approval's note, when the moderator left one, is read the same way.
    expect(describeNotification(decision({ about: 'activate', note: 'Welcome back' })).detail).toBe(
      'Welcome back',
    );
  });

  it('a drawing approved, rejected or merged; a rejection carries no reason and no tap', () => {
    expect(describeNotification(decision({ about: 'drawn' }))).toEqual({
      title: 'Gli added Lake Morey, the lake you drew, to the map',
      target: { kind: 'water', id: 'b1' },
    });
    expect(
      describeNotification(decision({ about: 'drawn', outcome: 'rejected', note: 'Duplicate' })),
    ).toEqual({ title: 'Gli didn’t add Lake Morey, the lake you drew, to the map', target: null });
    expect(describeNotification(decision({ about: 'drawn', outcome: 'merged' })).title).toBe(
      'Your drawing was merged into Lake Morey — anything you reported there moved with it',
    );
  });

  it('a retraction names the alert’s spot and lake, never the moderator’s reason', () => {
    const alert = (over: Omit<Partial<Decision>, 'type'>) =>
      describeNotification(decision({ about: 'accessAlert', outcome: 'retracted', ...over }));
    expect(alert({ place: 'Route 5 lot', note: 'Spam' })).toEqual({
      title: 'A moderator took down your access alert at Route 5 lot, Lake Morey',
      target: { kind: 'water', id: 'b1' },
    });
    expect(alert({}).title).toBe('A moderator took down your access alert on Lake Morey');
    expect(alert({ body: null, place: 'Route 5 lot' })).toEqual({
      title: 'A moderator took down your access alert at Route 5 lot',
      target: null,
    });
    expect(alert({ body: null }).title).toBe('A moderator took down your access alert');
  });

  it('a kind this build has no words for reads as the plain sentence, never a throw', () => {
    for (const about of ['photo', 'toString', '__proto__', undefined]) {
      for (const outcome of OUTCOMES) {
        const view = decision({ outcome, about: about as never });
        expect(describeNotification(view)).toEqual({
          title: 'A moderator made a decision on something you sent',
          target: { kind: 'water', id: 'b1' },
        });
      }
    }
  });

  it('every about × outcome is a sentence, with and without its lake, and never a word on the ice', () => {
    for (const about of ABOUTS) {
      for (const outcome of OUTCOMES) {
        for (const body of [lake, null]) {
          for (const extra of [{}, { note: 'Thin and unsafe — stay off' }, { place: 'The ramp' }]) {
            const d = describeNotification(decision({ about, outcome, body, ...extra }));
            expect(d.title.length, `${about} × ${outcome}`).toBeGreaterThan(0);
            expect(d.title, `${about} × ${outcome}`).not.toMatch(ICE_WORDS);
            // A pair no writer gives reads as a plain decision, never another pair's words.
            if (!written(about, outcome)) {
              expect(d.title).toBe('A moderator made a decision on something you sent');
            }
            // Only a request's note reaches the asker; a retraction's or rejection's reason never.
            if (about === 'accessAlert' || about === 'drawn') expect(d.detail).toBeUndefined();
            if (d.target !== null) expect(d.target).toEqual({ kind: 'water', id: 'b1' });
            if (body === null) expect(d.target).toBeNull();
          }
        }
      }
    }
  });
});

describe('timezoneToSync (A08 §3)', () => {
  it('writes only when the device knows its zone and it differs from the stored one', () => {
    expect(timezoneToSync(undefined, 'America/New_York')).toBe('America/New_York');
    expect(timezoneToSync('America/New_York', 'America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(timezoneToSync('America/New_York', 'America/New_York')).toBeNull();
    expect(timezoneToSync(undefined, null)).toBeNull();
    expect(timezoneToSync('America/New_York', null)).toBeNull();
  });
});

describe('hazardLifecyclePhase', () => {
  it('orders archived > disputed > healing > confirmed > provisional', () => {
    expect(
      hazardLifecyclePhase({ status: 'archived', healingState: 'disputed', confirmCount: 5 }, true),
    ).toBe('archived');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'disputed', confirmCount: 5 }, true),
    ).toBe('disputed');
    expect(
      hazardLifecyclePhase(
        { status: 'active', healingState: 'healing_unsafe', confirmCount: 0 },
        false,
      ),
    ).toBe('healing_unsafe');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 1 }, false),
    ).toBe('confirmed');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 0 }, false),
    ).toBe('provisional');
    // A passage marker needs two confirmations (D64).
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 1 }, true),
    ).toBe('provisional');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 2 }, true),
    ).toBe('confirmed');
  });
});
