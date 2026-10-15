/**
 * Undo handlers for the Body console's levers: a body's identity, water, access ruling, standing and removal; sub-areas; landmarks (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`;
 * the shapes are `undoTypes.ts`'s.
 */

import type { ModerationAction, ModerationTargetType } from './audit';
import type { TargetUndo, UndoHandler } from './undoTypes';

/** Verb-level handlers (verbs only this area writes). */
export const BODY_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {};

/** `hide` / `remove` / `restore` for the target kinds this area owns. */
export const BODY_TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {};
