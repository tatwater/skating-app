import { MASCOMA_ID, NEIGHBOR_ID } from '../../frame/bodyFixtures';
import type { MergeAnswer, MergeBodyRef, MergePreview, MoveKind } from './mergeModel';

/**
 * **`bodyConsole.mergePreview`'s answers, as the server types them** — for stories and tests only.
 * Mascoma Lake (the console's body) merging into Crystal Lake (the body that touches it), and the
 * other answers the preview can give, each in the server's own words and codes.
 */

const ref = (waterBodyId: string, name: string, place: string): MergeBodyRef => ({
  waterBodyId: waterBodyId as MergeBodyRef['waterBodyId'],
  name,
  place,
  type: 'lakePond',
  areaSqM: 4_400_000,
  removed: false,
  point: null,
});

export const CRYSTAL = ref(NEIGHBOR_ID, 'Crystal Lake', 'Enfield, NH');
export const MASCOMA = ref(MASCOMA_ID, 'Mascoma Lake', 'Enfield, NH');

const none = { count: 0, capped: false };
const moves = (m: Partial<Record<MoveKind, number>>): Record<MoveKind, typeof none> => ({
  reports: { count: m.reports ?? 0, capped: false },
  hazards: { count: m.hazards ?? 0, capped: false },
  bounties: { count: m.bounties ?? 0, capped: false },
  bodyFeatures: { count: m.bodyFeatures ?? 0, capped: false },
  putIns: { count: m.putIns ?? 0, capped: false },
  favorites: { count: m.favorites ?? 0, capped: false },
  requests: { count: m.requests ?? 0, capped: false },
  placeNames: { count: m.placeNames ?? 0, capped: false },
  flags: { count: m.flags ?? 0, capped: false },
  subAreas: { count: m.subAreas ?? 0, capped: false },
  landmarks: { count: m.landmarks ?? 0, capped: false },
  gpsActivities: { count: m.gpsActivities ?? 0, capped: false },
});

/** Mascoma into Crystal: a few of each, a favorite kept once, a bay by a name Crystal has. */
export const MERGE_TO_CRYSTAL: Extract<MergePreview, { ok: true }> = {
  ok: true,
  survivor: CRYSTAL,
  loser: MASCOMA,
  moves: moves({
    reports: 3,
    hazards: 1,
    putIns: 1,
    favorites: 2,
    requests: 1,
    subAreas: 2,
    landmarks: 1,
    gpsActivities: 1,
  }),
  favoritesDeduped: { count: 1, capped: false },
  baysClashing: { names: ['West cove'], capped: false },
  lists: { pins: 3, aliases: 4, links: 2, caps: { pins: 10, aliases: 20, links: 10 } },
  staysBehind: {
    accessAlerts: { count: 1, capped: false },
    parkingLots: { count: 2, capped: false },
  },
  tooBig: false,
  refusal: null,
  code: null,
};

/** A duplicate with nothing on it: only the lists to say. */
export const MERGE_NOTHING_MOVES: Extract<MergePreview, { ok: true }> = {
  ...MERGE_TO_CRYSTAL,
  moves: moves({}),
  favoritesDeduped: { count: 0, capped: false },
  baysClashing: { names: [], capped: false },
  staysBehind: {
    accessAlerts: { count: 0, capped: false },
    parkingLots: { count: 0, capped: false },
  },
};

/** Too much to move in one go: the counts past the read's bound, and the merge refused. */
export const MERGE_HEAVY: Extract<MergePreview, { ok: true }> = {
  ...MERGE_TO_CRYSTAL,
  moves: { ...MERGE_TO_CRYSTAL.moves, reports: { count: 1_000, capped: true } },
  tooBig: true,
  // The write's own sentence and code (`MERGE_TOO_BIG`, `lib/mergeLoad`).
  refusal:
    'Too much moves for one merge here. Merge it from the duplicates queue in parts, or ask an admin.',
  code: 'tooBig',
};

/** The server refuses it outright (`merge`'s own sentence). */
export const MERGE_REFUSED: MergePreview = {
  ok: false,
  refusal: 'Survivor is itself merged — pick the canonical body',
  code: 'survivorMerged',
};

/** The merge's answer: its own audit row, and the unmerge offered with a reason asked. */
export const MERGE_ANSWER: MergeAnswer = {
  survivorId: NEIGHBOR_ID as MergeAnswer['survivorId'],
  actionId: 'ma_merge_mascoma' as MergeAnswer['actionId'],
  undoable: true,
  undoNeedsReason: true,
};
