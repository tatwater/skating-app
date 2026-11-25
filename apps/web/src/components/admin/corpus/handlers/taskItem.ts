import type { Landed, WriteAnswer } from '../../actions/useDecisionRunner';
import type { UndoTarget } from '../../shell/undo';

/**
 * Where both 7a handlers' decisions land: every one's row targets the body, and its answer is the
 * decision's own row and undo offer. (The item and the props are the registry's:
 * `CorpusItemOf` in `corpusTypes`, `CorpusHandlerProps` in `inspector/handlerRegistry`.)
 */
export const landedOn = (bodyId: string, answer: WriteAnswer): Landed => ({
  target: { targetType: 'waterbody', targetId: bodyId } satisfies UndoTarget,
  answer,
});
