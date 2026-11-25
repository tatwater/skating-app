import type { DecidedState } from '../../inspector/InspectorFrame';
import type { InboxDecidedView } from '../list/inboxTypes';
import { DECIDER_GONE, DECISION_WORDS } from '../words/inboxWords';

/**
 * The server's decided state as the frame takes it: the decider's name, the decision in the Inbox's
 * words, the audit row's id. The Inbox's half of the shared lock (`admin/inspector/lockModel.ts`),
 * left here when the frame moved (B01-6a): the frame no longer knows whose decisions it shows.
 */
export function decidedStateOf(view: InboxDecidedView): DecidedState {
  return {
    by: view.by?.displayName ?? DECIDER_GONE,
    at: view.at,
    decisionWord: DECISION_WORDS[view.decision],
    byMe: view.byMe,
    actionId: view.actionId ?? '',
  };
}
