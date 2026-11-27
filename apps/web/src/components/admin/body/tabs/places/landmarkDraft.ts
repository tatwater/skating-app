import type { LandmarkKind, LatLng } from '@skating/core';

import { askClosedLine, type SavedAskOutcome } from '../../consoleWords';

/**
 * **A landmark being dropped** (B01-6b): the one piece of state the Places tab holds while the map
 * places a new landmark — what it answers, the fields, and the point as it stands. Pure but for the
 * session counter: the tab keeps it in state and steps it with these functions, and the map's point
 * tool claim is read off it.
 *
 * - **What it answers** (`target`): nothing (a moderator's own drop), an emailed name (the save
 *   marks it placed), or a skater's proposal (the save approves every ask for that place). A
 *   proposal's point starts where the skater put it, and can be placed again.
 * - **The kind is chosen, never assumed** (the board's *Choose a kind*): a label's glyph is what
 *   skaters read it by, so a guessed one would be a wrong answer on the map.
 */

export type LandmarkTarget =
  | { kind: 'new' }
  | { kind: 'place-name'; corpusNameId: string; messages: number }
  | { kind: 'proposal'; requestId: string; askers: number };

export interface LandmarkDraft {
  /** A new value starts the map's drawing over (the tool claim's session). */
  session: number;
  target: LandmarkTarget;
  name: string;
  kind: LandmarkKind | null;
  aliases: string[];
  point: LatLng | null;
  /** Where the camera goes as the placing starts. */
  focus: { point: LatLng } | null;
}

let sessions = 0;

/** A fresh drop: its fields as the ask had them, the point where the ask put it. */
export function startLandmarkDraft(
  target: LandmarkTarget,
  options: { name?: string; aliases?: readonly string[]; point?: LatLng | null } = {},
): LandmarkDraft {
  const point = options.point ?? null;
  return {
    session: ++sessions,
    target,
    name: options.name ?? '',
    kind: null,
    aliases: [...(options.aliases ?? [])],
    point,
    focus: point !== null ? { point } : null,
  };
}

/** The map's pick: the point is here now. */
export function withPoint(draft: LandmarkDraft, point: LatLng): LandmarkDraft {
  return { ...draft, point };
}

/** The other spellings as the server takes them: trimmed, none empty, none the name itself. */
export function aliasList(draft: LandmarkDraft): string[] {
  const name = draft.name.trim().toLocaleLowerCase();
  return draft.aliases
    .map((a) => a.trim())
    .filter((a) => a !== '' && a.toLocaleLowerCase() !== name);
}

/** Whether the drop can be saved now, or the one thing it still needs. */
export function landmarkSaveBlocker(draft: LandmarkDraft): string | null {
  if (draft.name.trim() === '') return 'It needs a name';
  if (draft.kind === null) return 'Choose what kind of place it is';
  if (draft.point === null) return 'Click the map where it is';
  return null;
}

/** The mode bar while a landmark is dropped. */
export function dropModeBar(draft: LandmarkDraft): { mode: string; line: string } {
  return {
    mode: 'Landmark mode',
    line:
      draft.point === null
        ? 'Click the map where it is.'
        : 'Click somewhere else, or drag the mark, to move it.',
  };
}

/** The mode bar while a landmark is moved. */
export function moveModeBar(name: string): { mode: string; line: string } {
  return {
    mode: 'Landmark mode',
    line: `Click where ${name} really is, or drag it. Each move saves.`,
  };
}

/** The card's heading: what this drop is for. */
export function dropHeading(draft: LandmarkDraft): string {
  switch (draft.target.kind) {
    case 'new':
      return 'A new landmark';
    case 'place-name':
      return 'A name from the emails';
    case 'proposal':
      return 'A skater’s proposal';
  }
}

/** The card's one line under the heading, when the drop answers someone. */
export function dropNote(draft: LandmarkDraft): string | null {
  const t = draft.target;
  if (t.kind === 'place-name') {
    return t.messages === 1
      ? 'Adding it takes the name off the list. One email uses it.'
      : `Adding it takes the name off the list. ${t.messages.toLocaleString('en-US')} emails use it.`;
  }
  if (t.kind === 'proposal') {
    return t.askers === 1
      ? 'Adding it answers the skater who asked. Keep the name they asked for, or add it as another spelling.'
      : `Adding it answers all ${t.askers.toLocaleString('en-US')} skaters who asked. Keep the name they asked for, or add it as another spelling.`;
  }
  return null;
}

/** The receipt's words once the drop lands: its title, and what else it did. */
export function droppedReceipt(
  draft: LandmarkDraft,
  /** What the save did to the ask it answers (`landmarks.create`'s `request`). */
  request?: SavedAskOutcome,
): { title: string; description?: string } {
  const name = draft.name.trim();
  switch (draft.target.kind) {
    case 'new':
      return { title: `Added · ${name}` };
    case 'place-name':
      return { title: `Placed · ${name}`, description: 'The name is off the emails’ list.' };
    case 'proposal':
      return {
        title: `Added · ${name}`,
        description: askClosedLine(request) ?? 'The skaters who asked for it are answered.',
      };
  }
}
