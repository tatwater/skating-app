import type { BodyStanding } from '@skating/core';

import type { RetentionFacts } from './standingModel';

/**
 * Board 5.4.8's Mascoma Lake on the Body row's pinned day — Wednesday 14 October 2026, midday in
 * the runner's own zone, day 10 of the watch. Stories and tests only.
 */
export const BODY_NOW = new Date(2026, 9, 14, 12, 0).getTime();

export const ACTIVE: BodyStanding = { standing: 'active' };
export const ACTIVE_SINCE = new Date(2026, 8, 17, 12, 0).getTime();

/** What keeps Mascoma active: the boost, nine favorites, its launches and a report on 10 Oct. */
export const MASCOMA_RETENTION: RetentionFacts = {
  curatedBoost: { value: 0.3, at: new Date(2026, 8, 19, 12, 0).getTime() },
  favorites: 9,
  savedPutIns: 3,
  lastActivity: { at: new Date(2026, 9, 10, 12, 0).getTime(), kind: 'report' },
};

/** As the console reads it today: favorites and the last use have no read yet. */
export const MASCOMA_RETENTION_WIRED: RetentionFacts = {
  ...MASCOMA_RETENTION,
  favorites: null,
  lastActivity: null,
};

export const DORMANT_BY_HAND: BodyStanding = {
  standing: 'dormant',
  since: new Date(2026, 9, 2, 12, 0).getTime(),
  reason: 'moderator',
  note: 'Drawn down for dam work until January',
};

export const DORMANT_ON_RULING: BodyStanding = {
  standing: 'dormant',
  since: new Date(2026, 8, 21, 12, 0).getTime(),
  reason: 'no_public_access',
};

export const REMOVED: BodyStanding = {
  standing: 'removed',
  since: new Date(2026, 9, 1, 12, 0).getTime(),
  reason: 'landowner_request',
};
