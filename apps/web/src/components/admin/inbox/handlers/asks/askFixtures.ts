import { zonedInstant } from '@skating/core';

import type { AskMemberView } from './AskList';

/**
 * **Asks as `inbox.item` serves them** — 2.3's two (Luc Pelletier's and Kate Donovan's, served newest
 * first as the read lists members), and the shapes the board doesn't draw (a gone asker, a landmark
 * ask from a report). Stories and tests only. The clock is the board's: noon on 14 Oct 2026 in the
 * board's zone, an absolute instant whatever the runner's zone.
 */

export const ASKS_TZ = 'America/New_York';
export const ASKS_NOW = zonedInstant(2026, 10, 14, 12 * 60, ASKS_TZ);
const D = 86_400_000;

type AnyId = never;
const id = (s: string) => s.padEnd(32, '0') as AnyId;

const asker = (key: string, name: string, username: string) => ({
  userId: id(`pr${key}`),
  displayName: name,
  username,
  deleted: false,
  isStaff: false,
  role: 'member' as const,
  trustClass: 'trusted' as const,
  points: 41,
});

export const KATE_ASK: AskMemberView = {
  requestId: id('rqkate'),
  asker: asker('kate', 'Kate Donovan', 'kdonovan'),
  askedAt: ASKS_NOW - 3 * D,
  note: 'The one behind the state forest lot. Skated it this weekend and it isn’t on the map.',
  name: null,
  coord: { lat: 44.2812, lng: -72.2706 },
  status: 'open',
  fromReport: null,
  activityId: id('ackate') as AskMemberView['activityId'],
  // Her skate as the activity row stores it: the Saturday before, an hour and a quarter out.
  skate: {
    startTime: ASKS_NOW - 4 * D,
    endTime: ASKS_NOW - 4 * D + 75 * 60_000,
    elapsedSeconds: 48 * 60,
  },
  landmarkAsks: null,
};

export const LUC_ASK: AskMemberView = {
  requestId: id('rqluc'),
  asker: asker('luc', 'Luc Pelletier', 'lpelletier'),
  askedAt: ASKS_NOW - 2 * D,
  note: 'Same pond. Everyone in town calls it Lot Pond.',
  name: null,
  coord: { lat: 44.2809, lng: -72.2702 },
  status: 'open',
  fromReport: null,
  activityId: null,
  skate: null,
  landmarkAsks: null,
};

/** 2.3's asks, as served: newest first. */
export const BOARD_ASKS: AskMemberView[] = [LUC_ASK, KATE_ASK];

/** An asker who has since deleted their account. */
export const GONE_ASK: AskMemberView = {
  ...LUC_ASK,
  requestId: id('rqgone'),
  asker: { ...asker('gone', 'Deleted user', ''), deleted: true, trustClass: null },
  askedAt: ASKS_NOW - 5 * D,
  note: null,
};

/** A landmark ask filed from a report's where. */
export const REPORT_ASK: AskMemberView = {
  ...LUC_ASK,
  requestId: id('rqreport'),
  askedAt: ASKS_NOW - 5 * 3_600_000,
  note: null,
  name: 'the Narrows',
  fromReport: {
    reportId: id('rpnarrows') as NonNullable<AskMemberView['fromReport']>['reportId'],
    skateEndTime: zonedInstant(2026, 10, 14, 9 * 60 + 40, ASKS_TZ),
    where: 'through the Narrows, open water north of it',
  },
};

/** A page of asks as the read serves one: fifty, newest first. */
export const MANY_ASKS: AskMemberView[] = Array.from({ length: 50 }, (_, i) => ({
  ...LUC_ASK,
  requestId: id(`rqmany${i}`),
  asker: asker(`many${i}`, `Skater ${i + 1}`, `skater${i + 1}`),
  askedAt: ASKS_NOW - (i + 1) * 3_600_000,
  note: null,
}));
