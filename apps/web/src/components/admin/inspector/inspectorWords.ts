/**
 * The words the shared inspector frame says itself, whichever mode draws it (the Inbox's, then
 * Corpus's, B01-7a). Moved here from `inbox/words/inboxWords.ts` with the frame; a mode's own words
 * (what each decision is called) stay in the mode and reach the lock as `DecidedState.decisionWord`.
 */

export const BACK_TO_QUEUE = 'Back to the queue';

/** The decided lock's line: "Decided by Sarah Berman · 14:42 · approved". */
export const decidedBy = (name: string) => `Decided by ${name}`;
