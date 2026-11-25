import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

import type { Landed, WriteAnswer } from '../../actions/useDecisionRunner';
import type { DecidedState } from '../../inspector/InspectorFrame';
import type { UndoTarget } from '../../shell/undo';

/**
 * What both 6a handlers share: the item they draw (derived from `api`, as the Inbox's views are),
 * the props a handler takes, and where a decision's receipt points.
 *
 * `HandlerProps` mirrors the briefs' `CorpusHandlerProps`, which W1's registry publishes; once it
 * lands the handlers import that instead and this alias goes.
 */

export type CorpusItem = NonNullable<FunctionReturnType<typeof api.corpusTasks.item>['item']>;

export type HandlerProps = { item: CorpusItem; locked: DecidedState | null; now: number };

/** Every 6a decision's row targets the body; its answer is the decision's own row and undo offer. */
export const landedOn = (bodyId: string, answer: WriteAnswer): Landed => ({
  target: { targetType: 'waterbody', targetId: bodyId } satisfies UndoTarget,
  answer,
});
