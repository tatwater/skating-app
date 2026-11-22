import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';
import type { MoveKind } from './mergeModel';

/** The server's codes for what stopped an unmerge (`unmerge.receipt`'s `stalled.code`). */
type UnmergeStallCode = NonNullable<
  NonNullable<FunctionReturnType<typeof api.unmerge.receipt>>['stalled']
>['code'];

/**
 * **The Shape tab's merge flow, in words** — no board draws this flow yet (the register owes one
 * from 5.4.1 Body | Shape), so every word here is *invented* for the founder's copy pass, except the
 * block's title and its one line, which are the board's. Nothing here says anything about the ice
 * (D3): a merge is about which record a lake is, never what it is like.
 */

const n = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** A count the preview may have cut short: a floor reads "200+" (the console's one wording). */
type Counted = { count: number; capped: boolean };
const nCounted = ({ count, capped }: Counted, one: string, many: string) =>
  capped ? `${count.toLocaleString('en-US')}+ ${many}` : n(count, one, many);

export const MERGE_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  title: 'Merge into another body',
  lead: 'For a lake drawn twice: everything on it moves to the body you pick.',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  touches: 'Touches',
  open: 'Open →',
  /** The search for a survivor beyond the touching bodies. */
  searchLabel: 'Or find the body that survives',
  searchNone: 'No body by that name',
  /** The search lists its first few: more matched than it shows. */
  searchMore: 'More bodies match · type more of the name',
  searchFailed: 'The search couldn’t be read',
  /** The preview's subhead: the survivor picked. */
  into: (name: string) => `Into ${name}`,
  clear: 'Pick another',
  whatMoves: 'What moves',
  nothingMoves: 'Nothing but the body itself',
  previewFailed: 'What the merge would move couldn’t be read',
  /** The kinds a merge moves, as the preview counts them. */
  kinds: {
    reports: 'Reports',
    hazards: 'Hazards',
    bounties: 'Bounties',
    bodyFeatures: 'Features',
    putIns: 'Put-ins',
    favorites: 'Favorites',
    requests: 'Requests',
    placeNames: 'Place names',
    flags: 'Flags',
    subAreas: 'Bays',
    landmarks: 'Landmarks',
    gpsActivities: 'Skates',
  } satisfies Record<MoveKind, string>,
  keptOnce: 'Kept once',
  favoritesDeduped: (deduped: Counted, survivor: string) =>
    `${nCounted(deduped, 'favorite', 'favorites')} already on ${survivor}`,
  delisted: 'Delisted',
  /** A capped list of names ends "…and more": the server stopped reading, never a whole list. */
  baysClash: ({ names, capped }: { names: readonly string[]; capped: boolean }, survivor: string) =>
    `${names.join(', ')}${capped ? ' …and more' : ''} · ${survivor} has a bay by ${names.length === 1 && !capped ? 'that name' : 'each name'}`,
  /** The preview didn't read the survivor's bays (the load stopped first): not checked, not none. */
  baysClashUnchecked: (survivor: string) =>
    `Not checked here · a bay may be delisted if ${survivor} has one by its name`,
  lists: 'Lists',
  listsAgainstCaps: (l: {
    pins: number;
    aliases: number;
    links: number;
    caps: { pins: number; aliases: number; links: number };
  }) =>
    `Pins ${l.pins} of ${l.caps.pins} · Aliases ${l.aliases} of ${l.caps.aliases} · Links ${l.links} of ${l.caps.links}`,
  staysHere: 'Stays here',
  alerts: (alerts: Counted) => nCounted(alerts, 'access alert', 'access alerts'),
  lots: (lots: Counted) => nCounted(lots, 'linked lot', 'linked lots'),
  /** The confirm, and the reason dialog it opens. */
  mergeInto: (name: string) => `Merge into ${name}`,
  confirm: 'Merge',
  dialogTitle: (loser: string, survivor: string) => `Merge ${loser} into ${survivor}`,
  dialogDescription: (survivor: string) =>
    `Everything on it moves to ${survivor}, and this body stays behind as a pointer to it. Undo moves it back, except rows that change in the meantime: those stay where they are.`,
  reasonLabel: 'Reason · kept in the audit log',
  /** The receipt names both bodies: the survivor here, this body as its subject. */
  merged: (survivor: string) => `Merged into ${survivor}`,
  mergedDetail: 'Everything on it moved · this page now points there',
  /** What a refusal names in its toast ("Not saved · Morey East Bay" — "The merge: …"). */
  what: 'The merge',
  /**
   * An unmerge that left rows where they were, because each had moved again since the merge (fork
   * 1): how many, plainly — said where the unmerge's receipt and its History row read the server's
   * count.
   */
  leftSince: (count: number) =>
    count === 1
      ? '1 row had changed since the merge and stays where it is'
      : `${count.toLocaleString('en-US')} rows had changed since the merge and stay where they are`,
  /** The unmerge's pages still landing: said until its last one, then the count above, if any. */
  unmerging: 'Moving rows back…',
  /** The unmerge finished with nothing left where the merge put it. */
  unmergedAll: 'Every row went back',
  /** Not done, and nothing carrying it on: a page failed or stopped. Its reason is the detail. */
  unmergeStalled: 'The unmerge stopped before it finished',
  /**
   * What stopped it, by the server's code — the quieter line under the headline; a failed page's
   * own error follows it verbatim when the server has one.
   */
  stallWhy: {
    pageFailed: 'A page of it failed partway.',
    pageCanceled: 'Its next page was canceled.',
    pageMissing: 'Its next page has no record.',
    pageStopped: 'A page finished without carrying it on.',
    undone: 'It was undone while it ran.',
    recordGone: 'The merge’s record is gone.',
    recordUnreadable: 'The merge’s record couldn’t be read.',
    mergedAgain: 'The body was merged again while it ran.',
  } satisfies Record<UnmergeStallCode, string>,
  /** Ended by a moderator before it finished: terminal, beside done. */
  unmergeAbandoned: 'Abandoned before it finished',
  /** Ends a stalled unmerge where it stands (destructive, behind a reason). */
  abandon: 'Abandon',
  abandonTitle: 'Abandon this unmerge?',
  /**
   * What abandoning does, from `unmerge.abandon`: both bodies unlocked and their derived facts
   * recomputed; the rows already put back stay put back; the rest stays where the merge put them;
   * the History keeps a row of it — and nothing here takes it back.
   */
  abandonWhat: (leftCount: number, unmoved: string) =>
    `Both bodies are unlocked and can be merged again. Rows already moved back stay on this body; rows the unmerge hadn't reached yet stay where the merge put them${leftCount > 0 ? `, and the ${leftCount.toLocaleString('en-US')} that had changed since stay where they are` : ''}. ${unmoved}. History records what was and wasn't moved back. This can't be undone here.`,
  /**
   * What a stalled unmerge hasn't moved back yet, from `stalled.notReached` — each kind in plain
   * words, in the unmerge's own order — or that it can't be told (the merge's record unreadable).
   */
  unmoved: {
    lead: 'Still not moved back',
    kinds: {
      moved: ['row', 'rows'],
      activities: ['skate', 'skates'],
      favorites: ['favorite', 'favorites'],
      bays: ['bay', 'bays'],
      landmarks: ['landmark', 'landmarks'],
      sides: ['side change', 'side changes'],
    },
    none: 'Nothing is still waiting to move back',
    unknown: 'How much is still not moved back can’t be told',
  },
  abandonReasonLabel: 'Reason · kept in the audit log',
  /** An abandon the server refused: the toast's title, the server's words after it. */
  notAbandoned: 'Not abandoned',
  /** The abandon's own History row: what it never reached, still where the merge put them. */
  notReached: (count: number) =>
    count === 1
      ? '1 row wasn’t moved back and stays where the merge put it'
      : `${count.toLocaleString('en-US')} rows weren’t moved back and stay where the merge put them`,
  everythingReached: 'Every row had been reached',
  notReachedUnread: 'What it didn’t reach couldn’t be read',
  /** Carries a stalled unmerge on from where it stopped. */
  resume: 'Resume',
  /** A resume the server refused: the toast's title, the server's words after it. */
  notResumed: 'Not resumed',
} as const;
