import type { PersonAction } from './levers';
import { momentWords, ROLE_ARTICLE } from './personModel';
import { WORDS } from './personWords';

/**
 * The undo toast's words for each write, from the operator's side: what was done to whom
 * ("Sarah Berman can edit the ledger"), then the consequence. The words are `personWords`'.
 */

export type ReceiptWords = { title: string; description?: string };

const RIGHT_VERB = WORDS.rightVerb;

export function receiptFor(
  action: PersonAction,
  person: { displayName: string; defaultBountyLimit: number },
  now: number,
  timeZone?: string,
): ReceiptWords {
  const name = person.displayName;
  switch (action.kind) {
    case 'right':
      return action.allowed
        ? { title: WORDS.canAgain(name, RIGHT_VERB[action.permission]) }
        : {
            title: WORDS.cannot(name, RIGHT_VERB[action.permission]),
            description: WORDS.restOfRights,
          };
    case 'bountyLimit':
      return action.limit === null
        ? { title: WORDS.bountyBack(name, person.defaultBountyLimit) }
        : { title: WORDS.bountyIs(name, action.limit) };
    case 'suspend':
      return {
        // What happened, by the dialog's mode: more time on a running end, an end set on an
        // open-ended one, or a new window on one that ran its course.
        title: !action.extend
          ? WORDS.suspended(name)
          : action.shape === 'setEnd'
            ? WORDS.endSet(name)
            : action.shape === 'renew'
              ? WORDS.suspendedAgain(name)
              : WORDS.extended(name),
        description: WORDS.liftsOnItsOwnReceipt(momentWords(action.until, now, timeZone)),
      };
    case 'lift':
      return { title: WORDS.canSignIn(name) };
    case 'ban':
      return { title: WORDS.isBanned(name), description: WORDS.keptForAppeal };
    case 'role':
      return { title: WORDS.isNow(name, ROLE_ARTICLE[action.role]) };
    case 'ledger':
      return action.grant
        ? // The board's own words.
          { title: `${name} can edit the ledger`, description: WORDS.ledgerPassOn }
        : { title: WORDS.cannotEditLedger(name) };
  }
}
