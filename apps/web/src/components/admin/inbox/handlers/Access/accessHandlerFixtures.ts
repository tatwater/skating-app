import { zonedInstant } from '@skating/core';

import type { AccessItem, AccessReport } from './accessModel';

/**
 * Board 2.2's item as `inbox.item` would hand it over — Tomhannock Reservoir, a standing
 * *accessible* ruling of 12 Sep disputed by two reports — and the other states the item can be in.
 * The board's day: 14 Oct 2026, at noon in the board's zone. Story and test support only.
 *
 * **Every time is an absolute instant** — a wall-clock time in the board's zone (`BOARD_ZONE`, the
 * zone the tests and stories read dates in), never the runner's local clock: a fixture built with a
 * local `new Date(…)` moves a day under a runner far east or west (CI runs `Etc/GMT-14`).
 */

/** The boards' zone: their bodies are in New England, and the tests read dates there. */
export const BOARD_ZONE = 'America/New_York';

/** A wall-clock time in the board's zone, as an instant. */
const on = (month: number, day: number, h = 12, m = 0) =>
  zonedInstant(2026, month, day, h * 60 + m, BOARD_ZONE);

export const ACCESS_NOW = on(10, 14);

type Lockup = NonNullable<AccessReport['filer']>;
const person = (id: string, displayName: string, username: string, points: number): Lockup => ({
  userId: id as Lockup['userId'],
  displayName,
  username,
  deleted: false,
  isStaff: false,
  role: 'member',
  trustClass: 'trusted',
  points,
});

export const LUC = person('p_luc', 'Luc Pelletier', 'lpelletier', 22);
export const JAMIE = person('p_jamie', 'Jamie Moreau', 'jmoreau', 31);
export const KATE = person('p_kate', 'Kate Donovan', 'kdonovan', 58);
export const PAT = person('p_pat', 'Pat Lavoie', 'plavoie', 9);
const TEAGAN = {
  userId: 'p_teagan' as Lockup['userId'],
  displayName: 'Teagan Atwater',
  username: 'teagan',
  deleted: false,
  isStaff: true,
};

const report = (
  id: string,
  filer: Lockup | null,
  note: string | null,
  filedAt: number,
  status: AccessReport['status'] = 'open',
): AccessReport => ({
  flagId: id as AccessReport['flagId'],
  reason: 'no_public_access',
  note,
  filedAt,
  status,
  filer,
  autoFiled: filer === null,
  occurrences: 1,
  lastOccurrenceAt: null,
  prior: null,
});

const BODY: AccessItem['body'] = {
  waterBodyId: 'wb_tomhannock' as AccessItem['body']['waterBodyId'],
  name: 'Tomhannock Reservoir',
  place: 'Troy, NY',
  type: 'reservoir',
  areaSqM: 1650 * 4046.8564224,
  removed: false,
  point: { lat: 42.87, lng: -73.585 },
};

const ALLOWED: AccessItem['can'] = { ruleClosed: null, ruleAccessible: null, clearRuling: null };

/** The board: two reports disputing the 12 Sep accessible ruling, which dismissed two earlier. */
export const DISPUTE: AccessItem = {
  kind: 'access',
  itemId: 'it_tomhannock' as AccessItem['itemId'],
  lane: 'accessReports',
  facet: 'disputes',
  filedAt: on(10, 10, 9, 12),
  lastActivityAt: on(10, 13, 16, 40),
  memberCount: 2,
  memberCountIsFloor: false,
  can: ALLOWED,
  decided: null,
  body: BODY,
  // Neither list was cut short of its count.
  reportsCut: false,
  dismissedByRulingCut: false,
  reports: [
    report(
      'f_luc',
      LUC,
      'Posted no trespassing at both approaches now. Town sign says the road is for the water department only.',
      on(10, 13, 16, 40),
    ),
    report('f_jamie', JAMIE, 'Gated at the dam road, no shoulder to park on.', on(10, 10, 9, 12)),
  ],
  ruling: {
    verdict: 'open',
    ruledAt: on(9, 12, 11, 5),
    by: TEAGAN,
    note: 'The town says the dam-road launch is public.',
    reason: 'The town clerk, by email',
  },
  dismissedByRuling: [
    report('f_kate', KATE, 'Gate across the dam road', on(9, 6, 8, 30), 'closed'),
    report('f_pat', PAT, 'Gate across the dam road', on(9, 6, 10, 2), 'closed'),
  ],
  // A contest ask can be filed only under a no-public-access ruling: none under an accessible one.
  contestAsks: { count: 0, capped: false },
};

/** A first report on a body nobody has ruled on. */
export const FIRST_REPORT: AccessItem = {
  ...DISPUTE,
  facet: 'new',
  memberCount: 1,
  memberCountIsFloor: false,
  reports: [report('f_goose', KATE, 'New owner posted the only path in.', on(10, 14, 3, 0))],
  ruling: null,
  dismissedByRuling: [],
  can: { ruleClosed: null, ruleAccessible: null, clearRuling: 'There is no ruling to clear.' },
};

/** Reports after a standing *no public access* ruling — they don't dispute it. */
export const AFTER_NO_ACCESS: AccessItem = {
  ...DISPUTE,
  reports: [report('f_luc2', LUC, 'Still posted, still gated.', on(10, 12, 7, 45))],
  memberCount: 1,
  memberCountIsFloor: false,
  ruling: {
    verdict: 'none',
    ruledAt: on(9, 20, 14, 0),
    by: TEAGAN,
    note: 'Posted by the water department.',
    reason: null,
  },
  dismissedByRuling: [],
  // Two skaters ask for it back: the only stored "accessible" claims.
  contestAsks: { count: 2, capped: false },
};

/** Many reporters at once — and one the app filed, with no byline. */
export const MANY: AccessItem = {
  ...DISPUTE,
  memberCount: 6,
  memberCountIsFloor: false,
  reports: [
    report('m1', LUC, 'Locked gate, both ends.', on(10, 14, 8, 0)),
    report('m2', JAMIE, 'Same — locked.', on(10, 13, 18, 20)),
    report('m3', KATE, null, on(10, 13, 9, 5)),
    report('m4', PAT, 'Signs say no trespassing.', on(10, 12, 15, 0)),
    report(
      'm5',
      person('p_dana', 'Dana Whitlock', 'dwhitlock', 4),
      'Couldn’t find a way in.',
      on(10, 11, 12, 0),
    ),
    report('m6', null, null, on(10, 11, 10, 0)),
  ],
};

/**
 * More reports than the read holds whole: 500+ counted, six served, the list cut by the item's
 * budget — and more dismissed reports than were read, so the ruling's count is a floor too.
 */
export const CUT: AccessItem = {
  ...MANY,
  memberCount: 500,
  memberCountIsFloor: true,
  reportsCut: true,
  dismissedByRulingCut: true,
};

/** A viewer whose `can` refuses every verb: no bar at all. */
export const READ_ONLY: AccessItem = {
  ...DISPUTE,
  can: {
    ruleClosed: 'Only moderators rule on access.',
    ruleAccessible: 'Only moderators rule on access.',
    clearRuling: 'Only moderators rule on access.',
  },
};

/**
 * A staffer who filed one of the reports (D289): the server refuses them every ruling, in its own
 * words, and the bar draws nothing.
 */
const OWN_FILING = 'You filed this, so another staff member decides it.';
export const FILED_BY_VIEWER: AccessItem = {
  ...DISPUTE,
  can: { ruleClosed: OWN_FILING, ruleAccessible: OWN_FILING, clearRuling: OWN_FILING },
};
