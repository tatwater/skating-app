import { CHORD_MESSAGES, type ChordResult, type LatLng, type SubAreaMouth } from '@skating/core';

import { type ChordState, chordInstruction } from '@/lib/chordDraw';
import type { BBoxLike } from '@/lib/mapSurface';
import { parsePastedPolygon } from '@/lib/polygonDraw';
import type { BayWay } from './ShapeTab';

/**
 * **A bay on the drawing board** (B01-6a): the one piece of state the Shape tab holds while the map
 * draws a bay — what it is for, which way it is drawn, the fields, and the shape as it stands. Pure
 * but for the session counter: the route keeps it in state and steps it with these functions, and
 * the map tool claim is read off it.
 *
 * - **What it is for** (`target`): a new bay (from nothing, from an Inbox ask, or from a landmark
 *   that goes away when it saves, D299), a bay's outline redrawn, or a bay's mouth set or moved.
 * - **The way** fixes the engine: a chord (two shore points, a side, a bow), a traced ring, or a
 *   pasted GeoJSON shape the map only shows. A redraw is a ring or a paste; a mouth is a chord.
 * - **The shape** is what the save sends: a chord's derivation (the server's own, `chordSubArea`),
 *   the finished ring, or the parsed paste. Changing the way starts the shape over.
 */

export type BayTarget =
  | {
      kind: 'new';
      /** The Inbox ask this bay answers: the save approves it and the asks like it. */
      request?: { requestId: string; asks: number };
      /** The landmark this bay is drawn from: the save retires it (D202, D299). */
      promote?: { landmarkId: string; name: string };
    }
  | {
      kind: 'redraw';
      subAreaId: string;
      name: string;
      polygon: GeoJSON.Polygon | null;
      bbox: BBoxLike | null;
    }
  | {
      kind: 'mouth';
      subAreaId: string;
      name: string;
      mouth: SubAreaMouth | null;
      bbox: BBoxLike | null;
    };

export interface BayDraft {
  /** A new value starts the map's drawing over (the tool claim's session). */
  session: number;
  target: BayTarget;
  way: BayWay;
  name: string;
  /** Comma-separated, as typed. */
  aliases: string;
  paste: string;
  /** Where the chord gesture stands; `null` for a ring or a paste. */
  chord: ChordState | null;
  mouth: SubAreaMouth | null;
  shape: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  /** Why the shape as it stands can't be saved: the chord's refusal, a paste that isn't a polygon. */
  refusal: string | null;
  /** The draw engine couldn't load: paste is the way left. */
  ringUnavailable: boolean;
  /** Where the camera goes as the drawing starts. */
  focus: { point: LatLng } | { bbox: BBoxLike } | null;
}

let sessions = 0;

/** The ways a target can be drawn, in the order the picker offers them. */
export function waysFor(target: BayTarget): readonly BayWay[] {
  switch (target.kind) {
    case 'new':
      return ['chord', 'freehand', 'paste'];
    case 'redraw':
      return ['freehand', 'paste'];
    case 'mouth':
      return ['chord'];
  }
}

/** A fresh draft: the target's own first way unless one was asked for, and its fields. */
export function startDraft(
  target: BayTarget,
  options: {
    way?: BayWay;
    name?: string;
    aliases?: readonly string[];
    focus?: { point: LatLng } | { bbox: BBoxLike } | null;
  } = {},
): BayDraft {
  const ways = waysFor(target);
  const way =
    options.way !== undefined && ways.includes(options.way) ? options.way : (ways[0] ?? 'chord');
  const bbox = target.kind === 'new' ? null : target.bbox;
  return {
    session: ++sessions,
    target,
    way,
    name: options.name ?? (target.kind === 'new' ? (target.promote?.name ?? '') : target.name),
    aliases: (options.aliases ?? []).join(', '),
    paste: '',
    chord: null,
    mouth: null,
    shape: null,
    refusal: null,
    ringUnavailable: false,
    focus: options.focus ?? (bbox !== null ? { bbox } : null),
  };
}

/** Another way: the shape starts over (the engine is re-attached), the fields stay. */
export function withWay(draft: BayDraft, way: BayWay): BayDraft {
  if (way === draft.way || !waysFor(draft.target).includes(way)) return draft;
  return {
    ...draft,
    session: ++sessions,
    way,
    paste: '',
    chord: null,
    mouth: null,
    shape: null,
    refusal: null,
    focus: null,
  };
}

/** The chord engine's settled change: the mouth, and the shape it derives — or why it makes none. */
export function withChord(
  draft: BayDraft,
  state: ChordState,
  mouth: SubAreaMouth | null,
  preview: ChordResult | null,
): BayDraft {
  const refused = preview !== null && !preview.ok ? CHORD_MESSAGES[preview.reason] : null;
  const pickRefusal = state.refusal !== undefined ? CHORD_MESSAGES[state.refusal] : null;
  return {
    ...draft,
    chord: { ...state },
    mouth,
    shape: preview?.ok ? preview.polygon : null,
    refusal: refused ?? pickRefusal,
  };
}

/** The ring engine's change: the traced ring, or nothing once it was removed. */
export function withRing(draft: BayDraft, polygon: GeoJSON.Polygon | null): BayDraft {
  return { ...draft, shape: polygon, refusal: null };
}

/** The paste box's text, parsed as it is typed: the shape, or why it isn't one. */
export function withPaste(draft: BayDraft, paste: string): BayDraft {
  if (paste.trim() === '') return { ...draft, paste, shape: null, refusal: null };
  const parsed = parsePastedPolygon(paste);
  return parsed.ok
    ? { ...draft, paste, shape: parsed.polygon, refusal: null }
    : { ...draft, paste, shape: null, refusal: parsed.error };
}

/** The aliases as the server takes them: trimmed, none empty. */
export function aliasList(draft: BayDraft): string[] {
  return draft.aliases
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Whether the draft can be saved now, or the one thing it still needs. */
export function saveBlocker(draft: BayDraft): string | null {
  if (draft.target.kind === 'new' && draft.name.trim() === '') return 'A bay needs a name';
  // Why the shape as it stands won't do comes before what is still missing: a refused paste or
  // chord says its reason, never "nothing yet".
  if (draft.refusal !== null) return draft.refusal;
  if (draft.way === 'chord' && draft.mouth === null) return 'The mouth isn’t drawn yet';
  if (draft.shape === null)
    return draft.way === 'paste' ? 'Nothing pasted yet' : 'Nothing drawn yet';
  return null;
}

/** What the mode bar says: the mode, what to do next, and the step. */
export function bayModeBar(draft: BayDraft): { mode: string; line: string; step?: string } {
  const mode =
    draft.target.kind === 'mouth'
      ? 'Mouth'
      : draft.target.kind === 'redraw'
        ? 'Redraw'
        : 'Bay mode';
  if (draft.way === 'chord') {
    const state = draft.chord ?? { step: 'a' as const, sagittaM: 0 };
    const step = { a: 1, b: 2, side: 3, done: 4 }[state.step];
    return { mode, line: chordInstruction(state), step: `Step ${step} of 4` };
  }
  if (draft.way === 'freehand') {
    if (draft.ringUnavailable)
      return { mode, line: 'The draw tool couldn’t load. Paste the outline instead.' };
    return {
      mode,
      line:
        draft.shape === null
          ? 'Click around the bay’s edge, and click the first point again to close it.'
          : 'Drag a point to move it, or the middle of an edge to add one.',
    };
  }
  return {
    mode,
    line:
      draft.shape === null
        ? 'Paste a polygon in the panel.'
        : 'The pasted shape, as it will be saved.',
  };
}

/** The receipt's words once the save lands. */
export function savedTitle(draft: BayDraft): string {
  const name = draft.name.trim();
  switch (draft.target.kind) {
    case 'new':
      return `Bay drawn · ${name}`;
    case 'redraw':
      return `Bay redrawn · ${draft.target.name}`;
    case 'mouth':
      return `Mouth set · ${draft.target.name}`;
  }
}
