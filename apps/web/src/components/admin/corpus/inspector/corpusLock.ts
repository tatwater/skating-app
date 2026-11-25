import type { CorpusTaskLane } from '@skating/core';

import type { DecidedState } from '../../inspector/InspectorFrame';
import type { CorpusDecidedView } from '../corpusTypes';
import { DECIDER_GONE, DECISION_WORDS } from '../words/corpusWords';

/**
 * The server's decided state as the shared frame takes it (`admin/inspector/`): the decider's name,
 * the decision in Corpus's words for its lane, the audit row's id. Corpus's half of the shared lock,
 * as `inbox/inspector/inboxLock.ts` is the Inbox's.
 */
export function decidedStateOf(lane: CorpusTaskLane, view: CorpusDecidedView): DecidedState {
  return {
    by: view.by?.displayName ?? DECIDER_GONE,
    at: view.at,
    decisionWord: DECISION_WORDS[lane][view.decision],
    byMe: view.byMe,
    actionId: view.actionId,
  };
}
