import { LANDMARK_KIND_LABELS, type LandmarkKind, landmarkNameKey } from '@skating/core';
import type { CompareRow } from '@/components/kit/compare-table';
import { ageInWords } from '@/lib/ages';
import type { InboxItemView } from '../../list/inboxTypes';
import { milesWords } from '../Flag/flagFormat';
import { PLACE_WORDS as W } from './placeWords';

/**
 * **Board 2.4, as data** — pure, so every rule is tested without a page: a `place` item (one or more
 * asks to name a bay or a landmark on a body, what already answers it, and the places that look
 * like it) turned into what the handler draws.
 *
 * - **A lever is drawn only where the item's `can` holds its verb as `null`**; a sentence is the
 *   server's refusal and draws nothing (D217).
 * - **Same place** answers a landmark ask with its lookalike (`approve` with `sameAs`): drawn where
 *   `can.sameAs` allows it and the item holds a landmark lookalike.
 * - **Approve** answers an ask with a place already there: a bay drawn by that name
 *   (`drawnSubAreaId`) or a landmark that already answers it (`answeringLandmarkId`) — and only where
 *   `can.approve` allows it.
 * - **Draw in Body →** stands in for *Approve* while approval waits on a drawing — its `can` is the
 *   server's sentence saying so — on an item the viewer may otherwise decide (another verb allowed).
 *   It is a link, not a write: the old editor in a new tab.
 */

export type PlaceItem = Extract<InboxItemView, { kind: 'place' }>;
export type PlaceAsk = PlaceItem['asks'][number];
export type Lookalike = PlaceItem['lookalikes'][number];
export type LandmarkLookalike = Extract<Lookalike, { kind: 'landmark' }>;
export type ProposalLookalike = Extract<Lookalike, { kind: 'proposal' }>;

const allowed = (item: Pick<PlaceItem, 'can'>, v: 'approve' | 'decline' | 'sameAs'): boolean =>
  v in item.can && item.can[v] === null;

/** The ask a decision is written on: the item's first, the one its rule's facts were read from. */
export function primaryAsk(item: Pick<PlaceItem, 'asks'>): PlaceAsk | null {
  return item.asks[0] ?? null;
}

/** The landmark the item's lookalikes hold, if any (the one *Same place* answers with). */
export function landmarkLookalike(item: Pick<PlaceItem, 'lookalikes'>): LandmarkLookalike | null {
  return item.lookalikes.find((l): l is LandmarkLookalike => l.kind === 'landmark') ?? null;
}

/** Another open ask nearby by a similar name, if any. */
export function proposalLookalike(item: Pick<PlaceItem, 'lookalikes'>): ProposalLookalike | null {
  return item.lookalikes.find((l): l is ProposalLookalike => l.kind === 'proposal') ?? null;
}

export type PlaceBar = {
  /** *Same place*: the landmark it answers with, or `null` when not drawn. */
  samePlace: LandmarkLookalike | null;
  approve: boolean;
  /** *Draw in Body →* (a link, not a write). */
  draw: boolean;
  decline: boolean;
};

export function placeBar(
  item: Pick<
    PlaceItem,
    'can' | 'placeKind' | 'lookalikes' | 'drawnSubAreaId' | 'answeringLandmarkId' | 'asks'
  >,
): PlaceBar {
  const lookalike = item.placeKind === 'name_landmark' ? landmarkLookalike(item) : null;
  const samePlace = allowed(item, 'sameAs') && lookalike !== null ? lookalike : null;
  const answered =
    item.placeKind === 'name_bay'
      ? item.drawnSubAreaId !== null
      : item.answeringLandmarkId !== null;
  const approve = allowed(item, 'approve') && answered && primaryAsk(item) !== null;
  const decline = allowed(item, 'decline') && primaryAsk(item) !== null;
  const waitsOnDrawing = typeof item.can.approve === 'string' && !answered;
  const draw = !approve && waitsOnDrawing && (decline || samePlace !== null);
  return { samePlace, approve, draw, decline };
}

export const hasBar = (bar: PlaceBar): boolean =>
  bar.samePlace !== null || bar.approve || bar.draw || bar.decline;

/**
 * The first refusal among the verbs the item draws, when it draws no lever at all — said once in the
 * body, so an empty bar is never a mystery. `null` while any lever is drawn, or once decided.
 */
export function refusalSaid(item: Parameters<typeof placeBar>[0] & Pick<PlaceItem, 'decided'>) {
  if (item.decided !== null || hasBar(placeBar(item))) return null;
  for (const v of ['approve', 'sameAs', 'decline'] as const) {
    const answer = item.can[v];
    if (typeof answer === 'string') return answer;
  }
  return null;
}

/** The head's kicker. */
export const headTitle = (item: Pick<PlaceItem, 'placeKind'>): string =>
  item.placeKind === 'name_bay' ? W.titleBay : W.titleLandmark;

/** The head's age, written out ("5 hours ago"). */
export const headAge = (item: Pick<PlaceItem, 'filedAt'>, now: number): string =>
  ageInWords(item.filedAt, now);

/** The ask came from a report's *where*: the head links Reports (Coming soon), else the body. */
export const fromReport = (item: Pick<PlaceItem, 'asks'>): boolean =>
  primaryAsk(item)?.fromReport != null;

/** The name asked for, as the display word quotes it. */
export const askedName = (item: Pick<PlaceItem, 'asks'>): string => primaryAsk(item)?.name ?? '';

/** The body's line over the name: "Newfound Lake · Bristol, NH". */
export function bodyLine(body: PlaceItem['body']): string {
  return body.place !== null ? `${body.name} · ${body.place}` : body.name;
}

/** "43.6702 −71.7588": four decimals, a true minus. */
export function pointText(p: { lat: number; lng: number }): string {
  const f = (v: number) => v.toFixed(4).replace('-', '−');
  return `${f(p.lat)} ${f(p.lng)}`;
}

/** Whether two names are one name by the landmark rule (a leading "the" and case set aside). */
export const sameName = (a: string, b: string): boolean =>
  a !== '' && landmarkNameKey(a) === landmarkNameKey(b);

const kindLabel = (k: string): string => LANDMARK_KIND_LABELS[k as LandmarkKind] ?? k;

/** The lookalike column's head: "The Narrows · OpenStreetMap". */
export function lookalikeHead(l: LandmarkLookalike): string {
  const source = W.source[l.source];
  return source !== undefined ? `${l.name} · ${source}` : l.name;
}

/** The compare table's rows: the ask against the landmark that may be the same place. */
export function compareRows(ask: PlaceAsk, l: LandmarkLookalike): CompareRow[] {
  const name = ask.name ?? '';
  const same = sameName(name, l.name);
  return [
    {
      label: W.name,
      cells: [
        { value: `“${name}”`, same },
        { value: l.name, same },
      ],
    },
    { label: W.kind, cells: [{ value: W.landmark }, { value: kindLabel(l.landmarkKind) }] },
    {
      label: W.point,
      cells: [
        { value: pointText(ask.coord), mono: true },
        { value: pointText(l.point), mono: true },
      ],
    },
    {
      label: W.alsoCalled,
      cells: [
        { value: W.nothingYet },
        { value: l.aliases.length > 0 ? l.aliases.join(', ') : W.noAliases },
      ],
    },
    {
      label: W.usedBy,
      cells: [
        { value: ask.fromReport !== null ? W.reports(1) : W.noReportsYet },
        {
          value:
            l.usedByReports === null
              ? W.usedByUnknown
              : l.usedByReports === 0
                ? W.noReportsYet
                : W.reports(l.usedByReports),
        },
      ],
    },
  ];
}

/** The match chips over the table: "same name" (lit) when it is one, and how far apart (amber). */
export function matchChips(
  ask: PlaceAsk,
  l: LandmarkLookalike,
): { text: string; tone: 'lit' | 'warn' }[] {
  return [
    ...(sameName(ask.name ?? '', l.name) ? [{ text: W.sameName, tone: 'lit' as const }] : []),
    { text: W.apart(milesWords(l.meters)), tone: 'warn' },
  ];
}

type Row = { label: string; value: string };

/** *If same place*: what answering with the lookalike does. */
export function ifSamePlace(ask: PlaceAsk): Row[] {
  return [
    { label: W.landmark, value: W.gainsAlias(ask.name ?? '') },
    ...(ask.fromReport !== null ? [{ label: W.rowReport, value: W.snaps }] : []),
    { label: W.asker, value: W.creditedTold },
  ];
}

/** *If drawn*: where the drawing is done while the console's map tools aren't built. */
export function ifDrawn(): Row[] {
  return [
    { label: W.opens, value: W.oldEditorNewTab },
    { label: W.thenLabel, value: W.approveThere },
  ];
}

/** *If approved*: an ask the place already answers. */
export function ifApproved(item: Pick<PlaceItem, 'placeKind'>): Row[] {
  return [
    {
      label: W.answeredBy,
      value: item.placeKind === 'name_bay' ? W.theBayDrawn : W.theLandmarkThere,
    },
    { label: W.asker, value: W.creditedTold },
  ];
}

/** *If declined*: every ask the item holds closes, each asker reading the note. */
export function ifDeclined(item: Pick<PlaceItem, 'memberCount' | 'memberCountIsFloor'>): Row[] {
  return [
    { label: W.closes, value: W.asksClosed(item.memberCount, item.memberCountIsFloor) },
    { label: W.asker, value: W.toldWithNote },
  ];
}
