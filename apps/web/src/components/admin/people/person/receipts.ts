import type { PersonAction } from './levers';
import { momentWords, ROLE_ARTICLE } from './personModel';

/**
 * The undo toast's words for each write, from the operator's side: what was done to whom
 * ("Sarah Berman can edit the ledger"), then the consequence. Never "You"; never a word about the
 * ice.
 */

export type ReceiptWords = { title: string; description?: string };

const RIGHT_VERB = {
  reports: 'post reports',
  hazards: 'mark hazards',
  comments: 'comment',
  flagging: 'flag',
} as const;

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
        ? { title: `${name} can ${RIGHT_VERB[action.permission]} again` }
        : {
            title: `${name} can’t ${RIGHT_VERB[action.permission]}`,
            description: 'Everything else they can do stays as it is',
          };
    case 'bountyLimit':
      return action.limit === null
        ? { title: `${name}’s bounty limit is back to the default (${person.defaultBountyLimit})` }
        : { title: `${name}’s bounty limit is ${action.limit}` };
    case 'suspend':
      return {
        title: action.extend ? `${name}’s suspension is extended` : `${name} is suspended`,
        description: `It lifts on its own ${momentWords(action.until, now, timeZone)}`,
      };
    case 'lift':
      return { title: `${name} can sign in again` };
    case 'ban':
      return { title: `${name} is banned`, description: 'The account is kept for an appeal' };
    case 'role':
      return { title: `${name} is now ${ROLE_ARTICLE[action.role]}` };
    case 'ledger':
      return action.grant
        ? {
            title: `${name} can edit the ledger`,
            description: 'They can give it to other admins too',
          }
        : { title: `${name} can’t edit the ledger` };
  }
}
