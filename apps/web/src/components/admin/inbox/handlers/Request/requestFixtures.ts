import type { InboxRowView } from '../../list/inboxTypes';
import { ASKS_NOW, ASKS_TZ, BOARD_ASKS, KATE_ASK, LUC_ASK, MANY_ASKS } from '../asks/askFixtures';
import type { RequestItem } from './requestModel';

/**
 * **Request items as `inbox.item` serves them** — board 2.3's admit, and every request kind the
 * board doesn't draw, each as each viewer the rule tells apart sees it: an admin (`body.remove`), a
 * moderator (`inbox.request`, no `body.remove`), the staffer who filed one of its asks, a viewer with
 * neither capability, and anyone once it is decided. `can` is the server's own words for each refusal
 * (`lib/inboxRules`), so the handler is tested against what the read sends. Stories and tests only.
 */

export const REQUEST_NOW = ASKS_NOW;
export const REQUEST_TZ = ASKS_TZ;
const H = 3_600_000;
const D = 24 * H;

type AnyId = never;
const id = (s: string) => s.padEnd(32, '0') as AnyId;

// ── The server's sentences (`lib/inboxRules`, `lib/auth`) ───────────────────────────────────
export const ADMIN_ROLE = 'Requires admin role';
export const MODERATOR_ROLE = 'Requires moderator role';
export const OWN_FILING = 'You filed this, so another staff member decides it.';
export const DECIDED = 'This has already been decided.';
export const FLOWING =
  'The catalog classifies this as flowing water or a canal, which the corpus does not hold. Decline it, or draw it by hand in the lake editor.';

const ACRE = 4046.8564224;

const body = (key: string, name: string, place: string, acres: number, removed = false) => ({
  waterBodyId: id(`wb${key}`),
  name,
  place,
  type: 'lakePond' as const,
  areaSqM: acres * ACRE,
  removed,
  point: { lat: 43.97, lng: -71.97 },
});

export const TARLETON = body('tarleton', 'Lake Tarleton', 'Piermont, NH', 329);
export const KOLELEMOOK = body('kolelemook', 'Kolelemook Lake', 'Springfield, NH', 41, true);
export const SPECTACLE = body('spectacle', 'Spectacle Pond', 'Groton, VT', 16);
export const POST_POND = body('postpond', 'Post Pond', 'Lyme, NH', 152);

/** 2.3's catalog feature: the unnamed 41-acre pond 38 m from Kate Donovan's ask. */
export const UNNAMED_POND: NonNullable<RequestItem['candidate']> = {
  source: '3dhp',
  externalId: 'YQ4K2',
  name: null,
  cls: 'lakePond',
  areaSqM: 41 * ACRE,
  centroid: { lat: 44.2815, lng: -72.2703 },
  polygon: { type: 'Polygon', coordinates: [] } as unknown as NonNullable<
    RequestItem['candidate']
  >['polygon'],
  matchedAt: REQUEST_NOW - 3 * D,
  metersFromAsk: 38,
  nearestKnown: null,
};

const base = (key: string, facet: string, filedAgo: number) => ({
  itemId: id(`itrq${key}`) as RequestItem['itemId'],
  lane: 'requests' as const,
  facet,
  filedAt: REQUEST_NOW - filedAgo,
  lastActivityAt: REQUEST_NOW - filedAgo,
  memberCount: 1,
  memberCountIsFloor: false,
  decided: null,
});

/** Who is looking: each answers a different `can`. */
export const VIEWERS = ['admin', 'moderator', 'filer', 'noRole', 'decided'] as const;
export type Viewer = (typeof VIEWERS)[number];

/**
 * The item's `can` for a viewer, as `inboxCan` answers it: the capability first (approving or declining
 * a restore or takedown is `body.remove`, an admin's; everything else `inbox.request`, a moderator's), then a
 * decided item, then the viewer's own filing, then the verb's precondition (`pre`).
 */
function canFor(
  viewer: Viewer,
  kind: RequestItem['requestKind'],
  verbs: readonly ('approve' | 'decline' | 'lookUpAgain')[],
  pre: Partial<Record<'approve' | 'decline' | 'lookUpAgain', string>> = {},
): RequestItem['can'] {
  const can: RequestItem['can'] = {};
  for (const verb of verbs) {
    // A restore or takedown is an admin's both ways: approving and declining are `body.remove`.
    const needsAdmin = verb !== 'lookUpAgain' && (kind === 'restore' || kind === 'takedown');
    can[verb] =
      viewer === 'noRole'
        ? needsAdmin
          ? ADMIN_ROLE
          : MODERATOR_ROLE
        : viewer === 'moderator' && needsAdmin
          ? ADMIN_ROLE
          : viewer === 'decided'
            ? DECIDED
            : viewer === 'filer'
              ? OWN_FILING
              : (pre[verb] ?? null);
  }
  return can;
}

const decidedState = (viewer: Viewer): RequestItem['decided'] =>
  viewer === 'decided'
    ? {
        at: REQUEST_NOW - 2 * H,
        by: { userId: id('prsarah') as never, displayName: 'Sarah Berman' },
        decision: 'approved',
        actionId: id('maapproved') as never,
        byMe: false,
      }
    : null;

/** What the read adds to every request item: the ask it names for the decision, and the cut. */
type Served = 'primaryRequestId' | 'asksCut' | 'ruling' | 'dormancy';

/**
 * A request item as served: `primaryRequestId` is the newest open ask (the first open one in `asks`,
 * served newest first), else the newest; nothing cut; no ruling or dormancy unless the kind has one.
 */
function served(
  item: Omit<RequestItem, Served> & Partial<Pick<RequestItem, 'ruling' | 'dormancy' | 'asksCut'>>,
): RequestItem {
  const named = item.asks.find((a) => a.status === 'open') ?? item.asks[0];
  return {
    ruling: null,
    dormancy: null,
    asksCut: false,
    ...item,
    primaryRequestId: (named?.requestId ?? id('rqnone')) as RequestItem['primaryRequestId'],
  };
}

/** Spectacle Pond's standing ruling, which its contest asks against: no public access. */
export const SPECTACLE_RULING: NonNullable<RequestItem['ruling']> = {
  verdict: 'none',
  ruledAt: REQUEST_NOW - 40 * D,
  by: {
    userId: id('prsarah') as never,
    displayName: 'Sarah Berman',
    username: 'sberman',
    deleted: false,
    isStaff: true,
  },
  note: 'Posted private by the landowner.',
  reason: 'The landowner wrote in; the only access is across their field.',
};

/** Lake Tarleton's dormancy, as the body stores it: nobody there for seasons. */
export const TARLETON_DORMANCY: NonNullable<RequestItem['dormancy']> = {
  reason: 'inactive',
  since: REQUEST_NOW - 300 * D,
  note: null,
  by: null,
};

// ── Each kind, for a viewer ──────────────────────────────────────────────────────────────────

/** 2.3: an admit the catalog matched, asked by two. */
export const admit = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('admit', 'admit', 3 * D),
    memberCount: 2,
    kind: 'request',
    requestKind: 'admit',
    body: null,
    asks: BOARD_ASKS,
    candidate: UNNAMED_POND,
    resolveError: null,
    can: canFor(viewer, 'admit', ['approve', 'decline']),
    decided: decidedState(viewer),
  });

/** An admit the catalog didn't match: *Look up again* in *Admit*'s place, and why. */
export const admitNoMatch = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('nomatch', 'admit', 2 * D),
    kind: 'request',
    requestKind: 'admit',
    body: null,
    asks: [{ ...LUC_ASK, note: null }],
    candidate: null,
    resolveError: 'No 3DHP feature within 150 m',
    can: canFor(viewer, 'admit', ['lookUpAgain', 'decline']),
    decided: decidedState(viewer),
  });

/** An admit whose lookup hasn't answered yet. */
export const admitPending = (viewer: Viewer = 'admin'): RequestItem => ({
  ...admitNoMatch(viewer),
  itemId: id('itrqpending') as RequestItem['itemId'],
  resolveError: null,
});

/** An admit the catalog matched to flowing water: *Admit* is refused, said in the item. */
export const admitFlowing = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...admit(viewer),
    itemId: id('itrqflowing') as RequestItem['itemId'],
    memberCount: 1,
    asks: [KATE_ASK],
    candidate: { ...UNNAMED_POND, cls: null },
    can: canFor(viewer, 'admit', ['approve', 'decline'], { approve: FLOWING }),
  });

/** An activate: a dormant body asked back onto the active map. */
export const activate = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('activate', 'activate', 7 * H),
    memberCount: 2,
    kind: 'request',
    requestKind: 'activate',
    body: TARLETON,
    asks: [
      { ...KATE_ASK, note: 'The club skated it every weekend last winter.', activityId: null },
      { ...LUC_ASK, note: null },
    ],
    candidate: null,
    resolveError: null,
    dormancy: TARLETON_DORMANCY,
    can: canFor(viewer, 'activate', ['approve', 'decline']),
    decided: decidedState(viewer),
  });

/** A restore: a removed body asked back (an admin's to approve). */
export const restore = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('restore', 'restore', 6 * D),
    kind: 'request',
    requestKind: 'restore',
    body: KOLELEMOOK,
    asks: [{ ...LUC_ASK, note: 'Removed in July, but the town opened the beach lot.' }],
    candidate: null,
    resolveError: null,
    can: canFor(viewer, 'restore', ['approve', 'decline']),
    decided: decidedState(viewer),
  });

/** A contest of a no-public-access ruling. */
export const contest = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('contest', 'contest_access', 4 * D),
    kind: 'request',
    requestKind: 'contest_access',
    body: SPECTACLE,
    asks: [{ ...KATE_ASK, note: 'The town plows the beach lot now.', activityId: null }],
    candidate: null,
    resolveError: null,
    ruling: SPECTACLE_RULING,
    can: canFor(viewer, 'contest_access', ['approve', 'decline']),
    decided: decidedState(viewer),
  });

/** A takedown: a landowner asks a body off the map (an admin's to approve). */
export const takedown = (viewer: Viewer = 'admin'): RequestItem =>
  served({
    ...base('takedown', 'takedown', 1 * D),
    kind: 'request',
    requestKind: 'takedown',
    body: POST_POND,
    asks: [{ ...LUC_ASK, note: 'I own the only shore. Please take it off the map.' }],
    candidate: null,
    resolveError: null,
    can: canFor(viewer, 'takedown', ['approve', 'decline']),
    decided: decidedState(viewer),
  });

/** An activate asked by more people than the read holds: a page of fifty, counted to a floor. */
export const activateMany = (): RequestItem =>
  served({
    ...activate('admin'),
    itemId: id('itrqmany') as RequestItem['itemId'],
    memberCount: 500,
    memberCountIsFloor: true,
    asks: MANY_ASKS,
  });

/** Every kind, by name — the table test's rows and the stories' list. */
export const KINDS = {
  admit,
  admitNoMatch,
  admitPending,
  admitFlowing,
  activate,
  restore,
  contest,
  takedown,
} as const;

// ── List rows, for the page stories ──────────────────────────────────────────────────────────

/** A list row for an item, as `inbox.listPage` serves it. */
export function rowOf(item: RequestItem): InboxRowView {
  const first = item.asks[0];
  return {
    itemId: item.itemId,
    lane: item.lane,
    facet: item.facet,
    filedAt: item.filedAt,
    lastActivityAt: item.lastActivityAt,
    memberCount: item.memberCount,
    memberCountIsFloor: item.memberCountIsFloor,
    body: item.body,
    can: item.can,
    decided: item.decided,
    kind: 'request',
    requestKind: item.requestKind,
    askers: item.memberCount,
    firstAsker: first?.asker ?? null,
    note: first?.note ?? null,
    candidate:
      item.candidate === null
        ? null
        : {
            name: item.candidate.name ?? 'Unnamed pond near Groton, VT',
            areaSqM: item.candidate.areaSqM,
          },
    resolveError: item.resolveError,
  } as InboxRowView;
}
