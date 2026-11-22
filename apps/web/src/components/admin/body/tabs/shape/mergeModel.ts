import { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

import { MERGE_WORDS as W } from './mergeWords';

/**
 * **The Shape tab's merge, as data** — pure, so every rule is tested without a page: the server's
 * preview of a merge (`bodyConsole.mergePreview`) turned into what the flow draws — what moves, what
 * a bay or a list runs into, what stays behind, and whether the merge may be confirmed. Nothing here
 * re-decides what the server decided: a refusal is its sentence, *too big* is its flag, a count past
 * the read's bound is drawn as the floor it is.
 */

/** `bodyConsole.mergePreview`'s answer, as the server types it (`MergePreview` in `bodyConsole.ts`). */
export type MergePreview = FunctionReturnType<typeof api.bodyConsole.mergePreview>;
type PreviewOk = Extract<MergePreview, { ok: true }>;

/** A body as the preview names it (the Inbox's `BodyRefView`). */
export type MergeBodyRef = PreviewOk['survivor'];

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
] as const satisfies readonly (keyof PreviewOk['moves'])[];
export type MoveKind = (typeof MOVE_KINDS)[number];

/** What `waterBodies.merge` answers: the survivor, its own row and this viewer's undo offer. */
export type MergeAnswer = FunctionReturnType<typeof api.waterBodies.merge>;

/** The preview read and the merge write the Shape tab calls. */
export const MERGE_PREVIEW = api.bodyConsole.mergePreview;
export const MERGE_WRITE = api.waterBodies.merge;

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
  const some = (m: { count: number; capped: boolean }) => m.count > 0 || m.capped;
  const { accessAlerts, parkingLots } = p.staysBehind;
  const behind = [
    some(accessAlerts) ? W.alerts(accessAlerts) : null,
    some(parkingLots) ? W.lots(parkingLots) : null,
  ].filter((x): x is string => x !== null);
  return [
    ...(some(p.favoritesDeduped)
      ? [{ label: W.keptOnce, value: W.favoritesDeduped(p.favoritesDeduped, p.survivor.name) }]
      : []),
    // A capped list (the preview didn't read the survivor's bays) says so from the flag — with no
    // names, that they weren't checked; never read as "none clash".
    ...(p.baysClashing.names.length > 0
      ? [{ label: W.delisted, value: W.baysClash(p.baysClashing, p.survivor.name) }]
      : p.baysClashing.capped
        ? [{ label: W.delisted, value: W.baysClashUnchecked(p.survivor.name) }]
        : []),
    { label: W.lists, value: W.listsAgainstCaps(p.lists) },
    ...(behind.length > 0 ? [{ label: W.staysHere, value: behind.join(' · ') }] : []),
  ];
}

/**
 * Whether the merge may be confirmed, and what is said where it may not: on its way or failed, no
 * confirm (the read says so); refused — outright, or too big with its counts — the server's own
 * sentence, never one worded here. Only a preview the server would run confirms.
 */
export function mergeVerdict(preview: MergePreview | undefined | null): {
  confirm: boolean;
  said: string | null;
} {
  if (preview == null) return { confirm: false, said: null };
  if (!preview.ok) return { confirm: false, said: preview.refusal };
  if (preview.refusal !== null) return { confirm: false, said: preview.refusal };
  return { confirm: true, said: null };
}
