/**
 * Undo handlers for roles, access alerts, approaches, posted rules, known features, recurrence and hazard merges (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`;
 * the shapes are `undoTypes.ts`'s.
 */

import type { ModerationAction, ModerationTargetType } from './audit';
import type { TargetUndo, UndoHandler } from './undoTypes';

/** Verb-level handlers (verbs only this area writes). */
export const CORPUS_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {};

/** `hide` / `remove` / `restore` for the target kinds this area owns. */
export const CORPUS_TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {};
