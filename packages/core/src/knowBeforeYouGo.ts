/**
 * **Know Before You Go** (D296): the seven questions every skater answers when they join and again
 * at the start of each season. "You know this, we're just making sure" — never a test to pass, and
 * never a claim about the ice (D3). Both apps ask these, in this order, and the records name this
 * version and its hash.
 *
 * ## Editing the questions each summer
 *
 * 1. Change the words below. Each question has a `prompt`, the `right` and `wrong` answers (both in
 *    the first person, the way a skater would say them), the `why` shown after either pick, and the
 *    `say` line listed on the last screen. `rightFirst` says which answer sits on top (so the right
 *    one isn't always first); change it freely. Keep each `id` as it is unless the question itself
 *    is new: ids are how the screens and tests name a question.
 * 2. Set `version` to today's date (`YYYY-MM-DD`).
 * 3. Run core's tests (`pnpm --filter @skating/core test`). `knowBeforeYouGo.test.ts` fails and
 *    prints one line, `'<version>': '<sha256>'`. Add that line to `KNOW_BEFORE_YOU_GO_HASHES`
 *    below. Never edit an old line: each is a version skaters answered, and their records name it.
 *
 * A new version never re-asks anyone mid-season: whoever answered this season stays answered, and
 * the next season's asking uses the new words. Every published line stays answerable: a phone built
 * before the edit still asks the old words, and its completion counts and names them
 * (`isPublishedKnowBeforeYouGo`). There are always seven questions with two answers each; the test
 * holds that too.
 */

import { claimMatches, ledgerHash } from './legal/hashLedger';

export interface KnowBeforeYouGoQuestion {
  /** Stable name for the question: screens and tests refer to it. */
  id: string;
  prompt: string;
  /** The answer to pick, in the first person. */
  right: string;
  /** The other answer. Picking it explains `why` and waits for the right one; it is never stored. */
  wrong: string;
  /** Shown after either pick: after "Correct." or after "Not quite.". */
  why: string;
  /** The question's one-line summary on the last screen. */
  say: string;
  /** Whether `right` is drawn above `wrong`. */
  rightFirst: boolean;
}

export interface KnowBeforeYouGo {
  /** The date these words were written, `YYYY-MM-DD`. */
  version: string;
  questions: readonly KnowBeforeYouGoQuestion[];
}

export const KNOW_BEFORE_YOU_GO: KnowBeforeYouGo = {
  version: '2026-11-24',
  questions: [
    {
      id: 'one-look',
      prompt: 'Someone posts a report from a lake you’re eyeing. What is it?',
      right: 'What one skater saw there, at that moment.',
      wrong: 'A sign the lake is good to skate.',
      why: 'A report is one person’s look at one spot. The rest of the lake, and the rest of the day, are yours to check.',
      say: 'A report is what one skater saw, at one spot, at one moment.',
      rightFirst: true,
    },
    {
      id: 'check-it-yourself',
      prompt: 'The most recent report says five inches of black ice. You’re going today. Now what?',
      right: 'I’ll check it myself. Ice can change quickly.',
      wrong: 'Five inches is five inches. I’m set.',
      why: 'Sun, wind, rain, and current can change ice in hours. A report tells you how it was, not how it is.',
      say: 'I check the ice myself, whatever the most recent report says.',
      rightFirst: true,
    },
    {
      id: 'empty-map',
      prompt: 'The map shows no hazards on a lake. What does that tell you?',
      right: 'Only that nobody has reported one yet.',
      wrong: 'That there aren’t any.',
      why: 'Gli only knows what skaters tell it. An empty map is not an all-clear.',
      say: 'No hazards on the map only means nobody has reported one yet.',
      rightFirst: false,
    },
    {
      id: 'notes-not-answers',
      prompt: 'Is Gli an accurate reflection of what the ice is doing?',
      right: 'No. It’s other skaters’ notes and some raw data to help me make my own decisions.',
      wrong: 'Yes. If it’s on Gli, I can count on it.',
      why: 'Gli gathers what people saw. It can’t tell you whether the ice will hold.',
      say: 'Gli is other skaters’ notes and raw data to help me make my own decisions.',
      rightFirst: false,
    },
    {
      id: 'your-call',
      prompt: 'Who makes the call to step onto the ice?',
      right: 'Me, every time. My call, my risk.',
      wrong: 'Whoever posted the latest report.',
      why: 'Nobody can make that call for you. Ice is never 100% safe.',
      say: 'Stepping onto the ice is my call and my risk, every time.',
      rightFirst: true,
    },
    {
      id: 'shore-plan',
      prompt: 'You’re heading out. Who knows your plan?',
      right: 'Someone on shore knows where I’ll be and when I’m due back.',
      wrong: 'Nobody. I’ve got my phone.',
      why: 'If something goes wrong, the person who knows where you are is the one who can send help.',
      say: 'Someone on shore knows where I’ll be and when I’m due back.',
      rightFirst: false,
    },
    {
      id: 'gear',
      prompt: 'What comes onto the ice with you?',
      right: 'A helmet, ice claws, a throw rope, and a pole to test with.',
      wrong: 'Just my skates. The reports looked great.',
      why: 'That gear is how you, or a friend, get back out. Bring it every time.',
      say: 'I bring a helmet, ice claws, a throw rope, and a pole, every time.',
      rightFirst: true,
    },
  ],
};

/**
 * Every version skaters have answered, with its SHA-256 (of `knowBeforeYouGoHashInput`, UTF-8, hex).
 * Append only; see the header for how a new line gets here.
 */
export const KNOW_BEFORE_YOU_GO_HASHES: Readonly<Record<string, string>> = {
  '2026-11-24': '63e02a586d70e7b9acff8b504c6754fa0776aa2fddaeae15ed13e1fdb1ae7ce1',
};

/** The current questions' SHA-256: what a client sends with a completion and a record stores. */
export const KNOW_BEFORE_YOU_GO_SHA256: string = ledgerHash(
  KNOW_BEFORE_YOU_GO_HASHES,
  KNOW_BEFORE_YOU_GO.version,
);

/**
 * The exact text the hash is taken over: the version and every field of every question, in a fixed
 * order (an array per question, so reordering the object's keys in this file changes nothing).
 */
export function knowBeforeYouGoHashInput(set: KnowBeforeYouGo): string {
  return JSON.stringify([
    set.version,
    set.questions.map((q) => [q.id, q.prompt, q.right, q.wrong, q.why, q.say, q.rightFirst]),
  ]);
}

/**
 * Whether a client's `{ version, hash }` names a published version of the questions — any line of
 * `KNOW_BEFORE_YOU_GO_HASHES`, not only this build's. A phone built before the summer's edit still
 * asks last year's words, and its skater answered those: the completion records the version they
 * answered, and it counts (a new version never re-asks anyone mid-season). An unknown version, a
 * wrong hash, or the unpublished sentinel is refused (`claimMatches`). `ledger` is for tests that
 * need a ledger with more than one line.
 */
export function isPublishedKnowBeforeYouGo(
  claim: { version: string; hash: string },
  ledger: Readonly<Record<string, string>> = KNOW_BEFORE_YOU_GO_HASHES,
): boolean {
  return claimMatches({ version: claim.version, hash: ledgerHash(ledger, claim.version) }, claim);
}

/** A question's two answers in the order they are drawn: the first is key 1, the second key 2. */
export function knowBeforeYouGoAnswers(
  question: KnowBeforeYouGoQuestion,
): [{ text: string; right: boolean }, { text: string; right: boolean }] {
  const right = { text: question.right, right: true };
  const wrong = { text: question.wrong, right: false };
  return question.rightFirst ? [right, wrong] : [wrong, right];
}
