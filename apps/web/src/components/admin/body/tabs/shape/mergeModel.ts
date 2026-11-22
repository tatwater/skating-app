import type { Id } from '@skating/convex/dataModel';
import { makeFunctionReference } from 'convex/server';

import { MERGE_WORDS as W } from './mergeWords';

/**
 * **The Shape tab's merge, as data** — pure, so every rule is tested without a page: the server's
 * preview of a merge (`bodyConsole.mergePreview`) turned into what the flow draws — what moves, what
 * a bay or a list runs into, what stays behind, and whether the merge may be confirmed. Nothing here
 * re-decides what the server decided: a refusal is its sentence, *too big* is its flag, a count past
 * the read's bound is drawn as the floor it is.
 */

/** A body as the preview names it (the Inbox's `BodyRefView`). */
export type MergeBodyRef = {
  waterBodyId: Id<'waterBodies'>;
  name: string;
  place: string | null;
  type: string;
  areaSqM: number | null;
  removed: boolean;
  point: { lat: number; lng: number } | null;
};

/** The kinds of row a merge moves, in the order the preview lists them. */
export const MOVE_KINDS = [
  'reports',
  'hazards',
  'bounties',
  'bodyFeatures',
  'putIns',
  'favorites',
  'requests',
  'placeNames',
  'flags',
  'subAreas',
  'landmarks',
  'gpsActivities',
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** `bodyConsole.mergePreview`'s answer, as the brief's snippet types it. */
export type MergePreview =
  | { ok: false; refusal: string }
  | {
      ok: true;
      survivor: MergeBodyRef;
      loser: MergeBodyRef;
      /** Rows that move, by kind, each `{ count, capped }` (a floor past the read's bound). */
      moves: Record<MoveKind, { count: number; capped: boolean }>;
      favoritesDeduped: number;
      /** Bays that would be delisted by a name the survivor already has. */
      baysClashing: string[];
      /** The union of the moderators' lists, against their caps. */
      lists: {
        pins: number;
        aliases: number;
        links: number;
        caps: { pins: number; aliases: number; links: number };
      };
      /** What stays on the loser: access alerts and linked lots. */
      staysBehind: { accessAlerts: number; parkingLots: number };
      /** Past one transaction's budget the merge is refused here. */
      tooBig: boolean;
    };

/** What `waterBodies.merge` answers once it offers its undo (the brief's snippet). */
export type MergeAnswer = { survivorId: Id<'waterBodies'>; actionId: string } & (
  | { undoable: true; undoNeedsReason: boolean }
  | { undoable: false }
);

/**
 * **PLACEHOLDER (B01-5d)**: the preview read and the merge write by name, typed as the brief's
 * snippets, until S4a's `bodyConsole.mergePreview` and `merge`'s new answer are in the generated
 * api — then `api.bodyConsole.mergePreview` and `api.waterBodies.merge`.
 */
export const MERGE_PREVIEW = makeFunctionReference<
  'query',
  { loserId: Id<'waterBodies'>; survivorId: Id<'waterBodies'> },
  MergePreview
>('bodyConsole:mergePreview');
export const MERGE_WRITE = makeFunctionReference<
  'mutation',
  { survivorId: Id<'waterBodies'>; loserId: Id<'waterBodies'>; reason?: string },
  MergeAnswer
>('waterBodies:merge');

/** The body picked to survive: by id and name, from the touching list or the search. */
export type Survivor = { id: string; name: string };

export type Row = { label: string; value: string };

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A count as the preview gives it: a floor drawn "200+" — never a total a bound cut short. */
export const countText = (m: { count: number; capped: boolean }): string =>
  `${int.format(m.count)}${m.capped ? '+' : ''}`;

/** *What moves*: one row per kind that moves anything, in the preview's order. */
export function moveRows(moves: Record<MoveKind, { count: number; capped: boolean }>): Row[] {
  return MOVE_KINDS.filter((k) => moves[k].count > 0 || moves[k].capped).map((k) => ({
    label: W.kinds[k],
    value: countText(moves[k]),
  }));
}

/**
 * The rest of what the merge does: favorites kept once, bays delisted by a name the survivor has,
 * the lists' union against their caps, and what stays here — each row only where it says something.
 */
export function consequenceRows(p: Extract<MergePreview, { ok: true }>): Row[] {
  const behind = [
    p.staysBehind.accessAlerts > 0 ? W.alerts(p.staysBehind.accessAlerts) : null,
    p.staysBehind.parkingLots > 0 ? W.lots(p.staysBehind.parkingLots) : null,
  ].filter((x): x is string => x !== null);
  return [
    ...(p.favoritesDeduped > 0
      ? [{ label: W.keptOnce, value: W.favoritesDeduped(p.favoritesDeduped, p.survivor.name) }]
      : []),
    ...(p.baysClashing.length > 0
      ? [{ label: W.delisted, value: W.baysClash(p.baysClashing, p.survivor.name) }]
      : []),
    { label: W.lists, value: W.listsAgainstCaps(p.lists) },
    ...(behind.length > 0 ? [{ label: W.staysHere, value: behind.join(' · ') }] : []),
  ];
}

/**
 * Whether the merge may be confirmed, and what is said where it may not: on its way or failed, no
 * confirm (the read says so); refused, the server's sentence; too big, the sentence a too-heavy merge
 * is refused with. Only a preview that is `ok` and not too big confirms.
 */
export function mergeVerdict(preview: MergePreview | undefined | null): {
  confirm: boolean;
  said: string | null;
} {
  if (preview == null) return { confirm: false, said: null };
  if (!preview.ok) return { confirm: false, said: preview.refusal };
  if (preview.tooBig) return { confirm: false, said: W.tooBig };
  return { confirm: true, said: null };
}
