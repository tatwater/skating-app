import {
  type RequestKind,
  standingReasonLabel,
  WATER_BODY_CLASS_LABELS,
  waterBodyClassLabel,
} from '@skating/core';

import { shortAge } from '@/lib/ages';

import { firstName, statusDate } from '../../../body/frame/bodyModel';
import { formatDistance } from '../../../body/tabs/places/placesModel';
import { shownName } from '../../blocks/shownName';
import { acres } from '../../list/inboxModel';
import type { InboxItemView } from '../../list/inboxTypes';
import { askedBy } from '../../words/inboxWords';
import { kindName, REQUEST_HANDLER_WORDS as W } from './requestWords';

/**
 * **A request item, as data** — pure, so every rule is tested without a page: a `request` item (one
 * question's asks: admit a body, activate, restore, contest its access, take it down) turned into
 * what the handler draws: the head, the catalog or body block, the two futures, which buttons the bar
 * draws, the refusals it says, and the receipt.
 *
 * - **Every lever comes from the item's `can`** (D217): a verb the item answers `null` is drawn; a
 *   sentence is the server's refusal, said in the item and never drawn as a button; a verb it doesn't
 *   answer is not drawn at all. No rule here re-decides what the server decided.
 * - **Restore and takedown are an admin's both ways** (D48, `body.remove`; §7 ruling 16): the
 *   server refuses both levers to anyone else, so `can` alone draws no bar and says why.
 * - Nothing here says anything about the ice (D3).
 */

/** The item behind 2.3 and the request kinds derived from it. */
export type RequestItem = Extract<InboxItemView, { kind: 'request' }>;
export type RequestCandidate = NonNullable<RequestItem['candidate']>;
export type RequestBody = NonNullable<RequestItem['body']>;
export type RequestDormancy = NonNullable<RequestItem['dormancy']>;

/** The verbs a request item's bar can send. */
export type RequestVerb = 'approve' | 'decline' | 'lookUpAgain';

/** A lever's write: an approval (a takedown's with its reason), a decline with its note, a lookup. */
export type RequestWrite =
  | { kind: 'approve'; note?: string }
  | { kind: 'decline'; note: string }
  | { kind: 'lookUpAgain' };

/** The ask a decision is sent for: the one the server names (`primaryRequestId`), if it is served. */
export function primaryAsk(
  item: Pick<RequestItem, 'asks' | 'primaryRequestId'>,
): RequestItem['asks'][number] | null {
  return item.asks.find((a) => a.requestId === item.primaryRequestId) ?? null;
}

/** What a receipt and a dialog call the item: its body, its catalog feature, or unnamed water. */
export function subjectOf(item: Pick<RequestItem, 'body' | 'candidate'>): string {
  return item.body?.name ?? item.candidate?.name ?? W.unnamedWater;
}

// ── The head ─────────────────────────────────────────────────────────────────────────────────

/** The pane head's kicker: 2.3's *Admit a body*, else the kind's founder-approved name. */
export function headTitle(kind: RequestKind): string {
  return kind === 'admit' ? W.admitHead : kindName(kind);
}

/** "Asked by 2 · 3 days ago" — its words written out, as a pane head writes an age. */
export function headAge(
  item: Pick<RequestItem, 'memberCount' | 'memberCountIsFloor'>,
  ago: string,
): string {
  return `${askedBy(item.memberCount, item.memberCountIsFloor)} · ${ago}`;
}

/** The body's line over its name: "Lake or pond · Piermont, NH · 1,650 ac". */
export function bodyKicker(body: RequestBody): string {
  return [waterBodyClassLabel(body.type), body.place, body.areaSqM !== null && acres(body.areaSqM)]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' · ');
}

// ── The blocks ───────────────────────────────────────────────────────────────────────────────

export type Row = { label: string; value: string; mono?: boolean };

/** *The catalog* (2.3): the matched feature's source, class, area, name, match and nearest body. */
export function catalogRows(c: RequestCandidate, now: number): Row[] {
  return [
    { label: W.source, value: W.sourceId(c.externalId), mono: true },
    ...(c.cls !== null ? [{ label: W.class, value: WATER_BODY_CLASS_LABELS[c.cls] }] : []),
    { label: W.area, value: acres(c.areaSqM) },
    { label: W.name, value: c.name ?? W.noName },
    {
      label: W.matched,
      value: W.matchedWhen(
        shortAge(now - c.matchedAt),
        c.metersFromAsk === null ? null : formatDistance(c.metersFromAsk),
      ),
    },
    // The read names the nearest body we hold only when it found one: never an empty row.
    ...(c.nearestKnown !== null
      ? [
          {
            label: W.nearest,
            value: `${c.nearestKnown.name} · ${formatDistance(c.nearestKnown.meters)}`,
          },
        ]
      : []),
  ];
}

/** An admit the catalog hasn't matched: why, in the resolver's words — or that it hasn't answered. */
export function noMatchRows(item: Pick<RequestItem, 'resolveError'>): Row[] {
  return [{ label: W.lookup, value: item.resolveError?.trim() || W.notAnsweredYet }];
}

/** *The body*, for a request on a body we hold: its class, place and area, and a removal. */
export function bodyRows(body: RequestBody): Row[] {
  return [
    { label: W.class, value: waterBodyClassLabel(body.type) },
    ...(body.place !== null ? [{ label: W.place, value: body.place }] : []),
    ...(body.areaSqM !== null ? [{ label: W.area, value: acres(body.areaSqM) }] : []),
    ...(body.removed ? [{ label: W.standing, value: W.removed }] : []),
  ];
}

/**
 * Why an activate's body is dormant, and since when — the reason in the Body console's own words
 * (core's `standingReasonLabel`, its Standing tab's), the date as a status date carries it — then the
 * moderator's note and who set it, each only when the read serves it. Never a reason it didn't send.
 */
export function dormancyRows(d: RequestDormancy, timeZone?: string): Row[] {
  return [
    {
      label: W.dormant,
      value: W.dormantSince(standingReasonLabel(d.reason), statusDate(d.since, timeZone)),
    },
    ...(d.note !== null && d.note.trim() !== ''
      ? [{ label: W.note, value: `“${d.note.trim()}”` }]
      : []),
    // Staff are named by first name on the console; one who is gone or leaving isn't named.
    ...(shownName(d.by) !== null
      ? [{ label: W.setBy, value: firstName(shownName(d.by) as string) }]
      : []),
  ];
}

/** The two futures: what approving (or looking up again) does, and what declining does. */
export function ifBlocks(
  item: RequestItem,
  /** The inspector's zone, for the dormancy's date. */
  timeZone?: string,
): {
  first: { title: string; rows: Row[] };
  declined: { title: string; rows: Row[] };
} {
  const n = item.memberCount;
  const floor = item.memberCountIsFloor;
  const closes = { label: W.closes, value: W.closesTold(n, floor) };
  const declined = {
    title: W.ifDeclined,
    rows: [
      { label: W.adds, value: W.nothing },
      { label: W.closes, value: W.closesWithNote(n, floor) },
    ],
  };
  const kind = item.requestKind;
  if (kind === 'admit' && item.candidate === null) {
    return {
      first: {
        title: W.ifLookedUp,
        rows: [
          { label: W.asks, value: W.catalogAgain },
          { label: W.thenRow, value: W.admitOnceMatched },
        ],
      },
      declined,
    };
  }
  const rows: Row[] = (() => {
    switch (kind) {
      case 'admit':
        return [
          { label: W.adds, value: W.outlineActive },
          closes,
          { label: W.thenRow, value: W.enrichmentQueues },
        ];
      case 'activate':
        return [
          ...(item.dormancy !== null ? dormancyRows(item.dormancy, timeZone) : []),
          { label: W.bringsBack, value: W.activeMap },
          closes,
          { label: W.thenRow, value: W.enrichmentIfMissing },
        ];
      case 'restore':
        return [{ label: W.bringsBack, value: W.restoredUnlessRuled }, closes];
      case 'contest_access':
        return [
          { label: W.sets, value: W.rulingAccessible },
          { label: W.bringsBack, value: W.activeMap },
          closes,
        ];
      case 'takedown':
        return [
          { label: W.takesOff, value: W.searchAndPush },
          { label: W.leaves, value: W.zoomedIn },
          closes,
        ];
      // A bay or a landmark ask is a place item, never a request's; drawn plainly if one comes.
      case 'name_bay':
      case 'name_landmark':
        return [closes];
    }
  })();
  return { first: { title: W.ifApproved[kind], rows }, declined };
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

export type RequestBarItem = {
  verb: RequestVerb;
  label: string;
  hotkey: 'A' | 'C' | 'D' | 'L' | 'R' | 'T';
  what: string;
  /** Red: a takedown, and the board's *Decline*. */
  danger: boolean;
  /** What its dialog asks before it sends; `null` sends on one press. */
  asks: 'note' | 'reason' | null;
};

/** Each approving button's key: its verb's initial (2.3's *Admit* is A). */
const APPROVE_KEY: Record<RequestKind, RequestBarItem['hotkey']> = {
  admit: 'A',
  activate: 'A',
  restore: 'R',
  contest_access: 'C',
  takedown: 'T',
  name_bay: 'A',
  name_landmark: 'A',
};

/** Whether the item allows `verb`: it answers `null`. An absent verb isn't a choice here at all. */
const allows = (item: Pick<RequestItem, 'can'>, verb: RequestVerb): boolean =>
  Object.hasOwn(item.can, verb) && item.can[verb] === null;

/**
 * The bar's buttons, from the item's `can` alone: the kind's approval, *Admit* and the rest (or *Look up again* for an
 * admit the catalog hasn't matched, which the item answers in *Admit*'s place) then *Decline*.
 */
export function requestBar(item: Pick<RequestItem, 'can' | 'requestKind'>): RequestBarItem[] {
  const kind = item.requestKind;
  const out: RequestBarItem[] = [];
  if (allows(item, 'approve')) {
    out.push({
      verb: 'approve',
      label: W.approve[kind],
      hotkey: APPROVE_KEY[kind],
      what: W.what[kind],
      danger: kind === 'takedown',
      asks: kind === 'takedown' ? 'reason' : null,
    });
  }
  if (allows(item, 'lookUpAgain')) {
    out.push({
      verb: 'lookUpAgain',
      label: W.lookUpAgain,
      hotkey: 'L',
      what: W.whatLookUp,
      danger: false,
      asks: null,
    });
  }
  if (allows(item, 'decline')) {
    out.push({
      verb: 'decline',
      label: W.decline,
      hotkey: 'D',
      what: W.whatDecline,
      danger: true,
      asks: 'note',
    });
  }
  return out;
}

/**
 * What the item says in place of the levers it refuses: each distinct sentence the server answered
 * (its own words, D268). `null` when nothing is refused — or when the item is decided, which the lock
 * says.
 */
export function refusalNote(item: Pick<RequestItem, 'can' | 'decided'>): string[] | null {
  if (item.decided !== null) return null;
  const lines = [
    ...new Set(
      (['approve', 'lookUpAgain', 'decline'] as const)
        .map((v) => item.can[v])
        .filter((s): s is string => typeof s === 'string' && s.trim() !== ''),
    ),
  ];
  return lines.length === 0 ? null : lines;
}

// ── The receipt ──────────────────────────────────────────────────────────────────────────────

/**
 * A landed write's receipt: its title and what it closes (present tense). Whether it offers Undo is
 * the write's own answer's (a lookup answers none), never decided here.
 */
export function receiptOf(
  item: Pick<RequestItem, 'requestKind' | 'memberCount' | 'memberCountIsFloor'>,
  write: RequestWrite,
): { title: string; description: string } {
  if (write.kind === 'lookUpAgain') return { title: W.lookingUp, description: W.lookingUpDetail };
  return {
    title: write.kind === 'decline' ? W.declined : W.receipt[item.requestKind],
    description: W.closesReceipt(item.memberCount, item.memberCountIsFloor),
  };
}
