import { zonedInstant } from '@skating/core';
import { ACCESS_ITEM, ADMIT_ITEM, SAFETY_ITEM, TICKET_ITEM } from '../list/inboxFixtures';

import type { InboxItemView } from '../list/inboxTypes';
import {
  ACCESS,
  ADMIT,
  ALERT,
  CASPIAN_DRAWING,
  CASPIAN_LAKE,
  DRAWN as DRAWN_SCENE,
  LOOKALIKE,
  MASCOMA,
  REPORT_POINT,
  RICKER_POND,
  TOMHANNOCK,
  UNNAMED_POND,
} from './inboxMapFixtures';
import type { ServerItemMap } from './itemMapAdapters';

/**
 * `inbox.itemMap`'s answers for the boards' items, and the items they answer — the board shapes'
 * geometry (`inboxMapFixtures`) as the server sends it. Story and test support only.
 */

type Body = NonNullable<ServerItemMap['body']>;
const sent = (
  b: { id: string; name: string; outline: Body['outline'] },
  simplified = false,
): Body => ({
  id: b.id,
  name: b.name,
  outline: b.outline,
  simplified,
});

const EMPTY: Omit<ServerItemMap, 'kind'> = {
  body: null,
  candidate: null,
  others: [],
  points: [],
  access: [],
  lookalikes: [],
  tracks: [],
  overlapShare: null,
  capped: false,
};

const lngLat = (p: readonly [number, number]): [number, number] => [p[0], p[1]];

// ── 2.1: a safety flag on a report ──────────────────────────────────────────────────────────
export const SAFETY = SAFETY_ITEM;
export const SAFETY_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'flag',
  body: sent(MASCOMA),
  points: [{ id: REPORT_POINT.report.id, at: lngLat(REPORT_POINT.report.at) }],
};

// ── 2.2: access reports ─────────────────────────────────────────────────────────────────────
export const ACCESS_REPORTS = ACCESS_ITEM;
export const ACCESS_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'access',
  body: sent(TOMHANNOCK),
  access: ACCESS.access.map((a) => ({ ...a, at: lngLat(a.at) })),
};

// ── 2.3: an admit with a catalog match ──────────────────────────────────────────────────────
const ADMIT_ASK = (ADMIT_ITEM as Extract<InboxItemView, { kind: 'request' }>).asks[0];
export const ADMIT_MATCH = {
  ...ADMIT_ITEM,
  candidate: { name: null, areaSqM: 41 * 4046.8564224 },
  // Kate Donovan's ask came with her recorded skate: the track the map draws is hers.
  asks: ADMIT_ASK ? [{ ...ADMIT_ASK, activityId: ADMIT.tracks?.[0]?.id ?? null }] : [],
} as unknown as InboxItemView;
/** The asks' skates as the server sends them: whole (not thinned). */
const ADMIT_TRACKS: ServerItemMap['tracks'] = (ADMIT.tracks ?? []).map((t) => ({
  id: t.id,
  path: t.path.map(lngLat),
  simplified: false,
}));
export const ADMIT_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'request',
  candidate: sent(UNNAMED_POND),
  others: [sent(RICKER_POND)],
  points: ADMIT.asks.map((a) => ({ id: a.id, at: lngLat(a.at) })),
  tracks: ADMIT_TRACKS,
};
/** The same admit with no skate behind it: no line, and no legend for one. */
export const ADMIT_MAP_NO_TRACK: ServerItemMap = { ...ADMIT_MAP, tracks: [] };

/** A request on a body we hold (an activate): the body and the asks. */
export const ACTIVATE = { ...ADMIT_ITEM, requestKind: 'activate' } as unknown as InboxItemView;
export const ACTIVATE_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'request',
  body: sent(MASCOMA),
  points: [{ id: 'rq9', at: [-72.16, 43.63] }],
};

// ── 2.4: a landmark ask with a lookalike ────────────────────────────────────────────────────
export const PLACE = {
  ...ADMIT_ITEM,
  kind: 'place',
  placeKind: 'name_landmark',
} as unknown as InboxItemView;
export const PLACE_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'place',
  body: sent(LOOKALIKE.body as NonNullable<typeof LOOKALIKE.body>),
  points: [{ id: LOOKALIKE.asked.id, at: lngLat(LOOKALIKE.asked.at), name: 'the Narrows' }],
  lookalikes: LOOKALIKE.lookalikes.map((l) => ({
    id: l.id,
    at: lngLat(l.at),
    name: 'The Narrows',
  })),
};

// ── 2.5: a drawing over a known body ────────────────────────────────────────────────────────
export const DRAWN = {
  ...ADMIT_ITEM,
  kind: 'drawn',
  // Noon on 12 Oct in the board's zone (an absolute instant, whatever the runner's zone).
  filedAt: zonedInstant(2026, 10, 12, 12 * 60, 'America/New_York'),
  drawer: { displayName: 'Kate Donovan' },
  overlap: {
    share: 0.92,
    suggested: true,
    body: { name: 'Caspian Lake', areaSqM: 789 * 4046.8564224 },
  },
  // The skate it was drawn from: 11 Oct, late morning in the board's zone.
  skate: {
    activityId: 'kd-11oct',
    startTime: zonedInstant(2026, 10, 11, 9 * 60, 'America/New_York'),
    endTime: zonedInstant(2026, 10, 11, 11 * 60, 'America/New_York'),
    elapsedSeconds: 96 * 60,
    hasTrack: true,
  },
} as unknown as InboxItemView;
export const DRAWN_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'drawn',
  body: sent(CASPIAN_DRAWING),
  others: [sent(CASPIAN_LAKE)],
  overlapShare: 0.92,
  tracks: DRAWN_SCENE.track
    ? [{ id: DRAWN_SCENE.track.id, path: DRAWN_SCENE.track.path.map(lngLat), simplified: false }]
    : [],
};
/** The same drawing whose skate left no track: no line, and no legend for one. */
export const DRAWN_MAP_NO_TRACK: ServerItemMap = { ...DRAWN_MAP, tracks: [] };

// ── 2.6: a flag on an access alert ──────────────────────────────────────────────────────────
export const ALERT_FLAG = {
  ...SAFETY_ITEM,
  lane: 'contentFlags',
  target: {
    targetType: 'accessAlert',
    targetId: 'al1',
    exists: true,
    summary: '',
    moderationStatus: null,
  },
} as unknown as InboxItemView;
export const ALERT_MAP: ServerItemMap = {
  ...EMPTY,
  kind: 'flag',
  body: sent(ALERT.body as NonNullable<typeof ALERT.body>),
  access: [{ ...ALERT.target, at: lngLat(ALERT.target.at) }],
};

// ── No geometry ─────────────────────────────────────────────────────────────────────────────
export const TICKET = TICKET_ITEM;
export const PERSON_FLAG = {
  ...SAFETY_ITEM,
  lane: 'contentFlags',
  target: { targetType: 'user', targetId: 'p1', exists: true, summary: '', moderationStatus: null },
} as unknown as InboxItemView;
export const GONE_FLAG = {
  ...SAFETY_ITEM,
  target: { targetType: 'report', targetId: 'rp1', exists: false },
} as unknown as InboxItemView;
export const EMPTY_MAP = (kind: ServerItemMap['kind']): ServerItemMap => ({ ...EMPTY, kind });

/** The answer with its outline sent simplified, and capped. */
export const SIMPLIFIED = (m: ServerItemMap): ServerItemMap => ({
  ...m,
  ...(m.body ? { body: { ...m.body, simplified: true } } : {}),
});
/** The answer with its skates thinned to fit. */
export const TRACKS_SIMPLIFIED = (m: ServerItemMap): ServerItemMap => ({
  ...m,
  tracks: m.tracks.map((t) => ({ ...t, simplified: true })),
});
export const CAPPED = (m: ServerItemMap): ServerItemMap => ({ ...m, capped: true });
