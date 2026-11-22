import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

import { acresText } from '../../bodies/bodiesModel';
import { dayMonth } from '../../shell/consoleTime';
import type { InboxItemView } from '../list/inboxTypes';
import {
  accessScene,
  admitScene,
  alertScene,
  drawnScene,
  type EmbedAccessPoint,
  type EmbedBody,
  type EmbedPoint,
  type InboxMapView,
  lookalikeScene,
  reportPointScene,
  requestOnBodyScene,
} from './inboxMapScene';
import { ITEM_MAP_WORDS as W } from './inboxMapWords';

/**
 * **From `inbox.itemMap`'s answer to the embed's scene** — one pure adapter per kind, so the server's
 * geometry and the board's scene meet in one place:
 *
 * | Kind | Scene |
 * |---|---|
 * | `flag` on a report or hazard | `reportPointScene` (the red reticle in the Safety lane) |
 * | `flag` on an access alert | `alertScene` (its put-in or lot lit) |
 * | `flag` on a body | the body alone |
 * | `access` | `accessScene` (the body, its put-ins and lots) |
 * | `request` | `admitScene` for a catalog candidate; the body and its asks for a body we hold |
 * | `place` | `lookalikeScene` (the asked points, each lookalike, the rule to the nearest) |
 * | `drawn` | `drawnScene` (the drawing over the body it overlaps, the share on the shore) |
 *
 * **What it says when the answer is short.** An outline the server sent simplified (larger than an
 * embed is sent) is drawn with *Outline simplified* on the caption — never as if exact; an answer
 * the server capped says *Not everything is shown*. **No map at all** (`null`) where there is
 * nothing to place: a flag on a person, a comment or a Post, a ticket, an answer that holds no
 * outline and no point — the slot collapses rather than drawing an empty frame.
 */

/** `inbox.itemMap`'s answer. */
export type ItemMapRead = FunctionReturnType<typeof api.inbox.itemMap>;
export type ServerItemMap = NonNullable<ItemMapRead['map']>;
type ServerBody = NonNullable<ServerItemMap['body']>;

const embed = (b: ServerBody): EmbedBody => ({ id: b.id, name: b.name, outline: b.outline });
const point = (p: ServerItemMap['points'][number]): EmbedPoint => ({
  id: p.id,
  at: p.at,
  ...(p.name !== undefined ? { name: p.name } : {}),
});
const accessPoint = (p: ServerItemMap['access'][number]): EmbedAccessPoint => ({
  ...point(p),
  kind: p.kind,
});

/** The caption's honest notes about the answer: a simplified outline, a capped answer. */
export function answerNotes(map: ServerItemMap, drawn: readonly (ServerBody | null)[]): string[] {
  const notes: string[] = [];
  if (drawn.some((b) => b?.simplified === true)) notes.push(W.simplified);
  if (map.capped) notes.push(W.capped);
  return notes;
}

/** A caption from its parts, or none. */
const join = (parts: readonly (string | null | undefined)[]): string | undefined => {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return kept.length > 0 ? kept.join(' · ') : undefined;
};

/** The body alone (a flag on a body, a hazard with no point): framed whole. */
function bodyAlone(body: ServerBody, caption: string | undefined): InboxMapView {
  return accessScene({ body: embed(body), access: [], ...(caption ? { caption } : {}) });
}

function flagMap(item: Extract<InboxItemView, { kind: 'flag' }>, map: ServerItemMap) {
  const caption = join(answerNotes(map, [map.body]));
  const target = item.target;
  if (!target.exists) return null;
  if (target.targetType === 'report' || target.targetType === 'hazard') {
    const at = map.points[0];
    if (at === undefined) return map.body ? bodyAlone(map.body, caption) : null;
    return reportPointScene({
      body: map.body ? embed(map.body) : null,
      report: point(at),
      safety: item.lane === 'safety',
      ...(caption ? { caption } : {}),
    });
  }
  if (target.targetType === 'accessAlert') {
    const place = map.access[0];
    if (place === undefined) return map.body ? bodyAlone(map.body, caption) : null;
    return alertScene({
      body: map.body ? embed(map.body) : null,
      target: accessPoint(place),
      ...(caption ? { caption } : {}),
    });
  }
  if (target.targetType === 'waterbody') return map.body ? bodyAlone(map.body, caption) : null;
  // A person, a comment, a Post, a photo: nothing to place.
  return null;
}

function requestMap(item: Extract<InboxItemView, { kind: 'request' }>, map: ServerItemMap) {
  const asks = map.points.map(point);
  const nearest = map.others[0] ?? null;
  if (map.candidate !== null) {
    const c = item.candidate;
    const fact = c === null ? undefined : `${c.name ?? W.unnamed} · ${acresText(c.areaSqM)} ac`;
    return admitScene({
      candidate: embed(map.candidate),
      asks,
      nearest: nearest ? embed(nearest) : null,
      legend: { candidate: W.candidateLegend, ...(nearest ? { nearest: W.oursLegend } : {}) },
      ...(fact ? { candidateFact: fact } : {}),
      ...captioned(join(answerNotes(map, [map.candidate, nearest]))),
    });
  }
  const caption = join(answerNotes(map, [map.body]));
  if (map.body !== null) {
    return requestOnBodyScene({ body: embed(map.body), asks, ...captioned(caption) });
  }
  // No body and no candidate: the asked points alone, if any.
  if (asks.length === 0) return null;
  return admitScene({ candidate: null, asks, ...captioned(join([W.noCandidate, caption])) });
}

function placeMap(map: ServerItemMap) {
  const caption = join(answerNotes(map, [map.body]));
  const [asked, ...also] = map.points.map(point);
  if (asked === undefined) return map.body ? bodyAlone(map.body, caption) : null;
  return lookalikeScene({
    body: map.body ? embed(map.body) : null,
    asked,
    alsoAsked: also,
    lookalikes: map.lookalikes.map(point),
    ...captioned(caption),
  });
}

/** The share of a drawing outside the body it overlaps, as the board letters it. */
export function shoreFact(share: number | null): string | undefined {
  if (share === null || !Number.isFinite(share)) return undefined;
  const outside = Math.round((1 - Math.min(1, Math.max(0, share))) * 100);
  return `${outside} % ${W.onTheShore}`;
}

function drawnMap(
  item: Extract<InboxItemView, { kind: 'drawn' }>,
  map: ServerItemMap,
  timeZone?: string,
) {
  if (map.body === null) return null;
  const known = map.others[0] ?? null;
  const ours = item.overlap?.body;
  const drawer = item.drawer?.displayName;
  const fact = shoreFact(map.overlapShare);
  return drawnScene({
    body: known ? embed(known) : null,
    drawing: embed(map.body),
    legend: {
      ...(known
        ? {
            body: join([
              known.name,
              W.ours,
              ours?.areaSqM != null ? `${acresText(ours.areaSqM)} ac` : null,
            ]),
          }
        : {}),
      drawing: join([`${W.drawn} ${dayMonth(item.filedAt, timeZone)}`, drawer]),
    },
    ...(fact ? { drawingFact: fact } : {}),
    ...captioned(join(answerNotes(map, [map.body, known]))),
  });
}

const captioned = (caption: string | undefined) => (caption ? { caption } : {});

/**
 * The embed's scene for an item and its map answer, or `null` — nothing to draw, and the slot
 * collapses. `map` `null` (no such item, or the item not stored yet) collapses too.
 */
export function itemMapScene(
  item: InboxItemView,
  map: ServerItemMap | null,
  timeZone?: string,
): InboxMapView | null {
  if (map === null) return null;
  switch (item.kind) {
    case 'flag':
      return flagMap(item, map);
    case 'access':
      return map.body === null
        ? null
        : accessScene({
            body: embed(map.body),
            access: map.access.map(accessPoint),
            ...captioned(join(answerNotes(map, [map.body]))),
          });
    case 'request':
      return requestMap(item, map);
    case 'place':
      return placeMap(map);
    case 'drawn':
      return drawnMap(item, map, timeZone);
    case 'ticket':
      return null;
  }
}

/**
 * Whether a kind can have a map at all — so a handler never reserves a slot (nor a loading box) for
 * an item that will draw none: a ticket, a flag on a person, a comment, a Post or a photo.
 */
export function kindHasMap(item: InboxItemView): boolean {
  if (item.kind === 'ticket') return false;
  if (item.kind !== 'flag') return true;
  const t = item.target;
  return (
    t.exists &&
    (t.targetType === 'report' ||
      t.targetType === 'hazard' ||
      t.targetType === 'accessAlert' ||
      t.targetType === 'waterbody')
  );
}
