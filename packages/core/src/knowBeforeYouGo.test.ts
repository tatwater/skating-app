import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isCurrentKnowBeforeYouGo,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_HASHES,
  KNOW_BEFORE_YOU_GO_SHA256,
  knowBeforeYouGoAnswers,
  knowBeforeYouGoHashInput,
} from './knowBeforeYouGo';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const { questions } = KNOW_BEFORE_YOU_GO;

describe('the committed hash', () => {
  it('is the SHA-256 of the current questions — or the test says what to add', () => {
    const actual = sha256(knowBeforeYouGoHashInput(KNOW_BEFORE_YOU_GO));
    const recorded = KNOW_BEFORE_YOU_GO_HASHES[KNOW_BEFORE_YOU_GO.version];
    const hint =
      recorded === undefined
        ? `New questions. Add this line to KNOW_BEFORE_YOU_GO_HASHES in packages/core/src/knowBeforeYouGo.ts:\n  '${KNOW_BEFORE_YOU_GO.version}': '${actual}',`
        : `The questions changed but their version didn't. Set KNOW_BEFORE_YOU_GO.version to today's date, run this test again, and add the line it prints (keep the old line).`;
    expect(recorded, hint).toBe(actual);
    expect(KNOW_BEFORE_YOU_GO_SHA256).toBe(actual);
  });

  it('keeps every published version as a dated key with a 64-digit hex hash', () => {
    for (const [version, hash] of Object.entries(KNOW_BEFORE_YOU_GO_HASHES)) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('hashes every field, so any edit moves it, and not the key order of the source', () => {
    const base = knowBeforeYouGoHashInput(KNOW_BEFORE_YOU_GO);
    const first = questions[0];
    if (!first) throw new Error('no questions');
    for (const edit of [
      { id: 'x' },
      { prompt: 'x' },
      { right: 'x' },
      { wrong: 'x' },
      { why: 'x' },
      { say: 'x' },
      { rightFirst: !first.rightFirst },
    ]) {
      const edited = {
        ...KNOW_BEFORE_YOU_GO,
        questions: [{ ...first, ...edit }, ...questions.slice(1)],
      };
      expect(knowBeforeYouGoHashInput(edited)).not.toBe(base);
    }
    expect(knowBeforeYouGoHashInput({ ...KNOW_BEFORE_YOU_GO, version: '2099-01-01' })).not.toBe(
      base,
    );
    const reordered = {
      questions: questions.map((q) => ({
        rightFirst: q.rightFirst,
        say: q.say,
        why: q.why,
        wrong: q.wrong,
        right: q.right,
        prompt: q.prompt,
        id: q.id,
      })),
      version: KNOW_BEFORE_YOU_GO.version,
    };
    expect(knowBeforeYouGoHashInput(reordered)).toBe(base);
  });

  it('names the current questions, and nothing else, as current', () => {
    const version = KNOW_BEFORE_YOU_GO.version;
    expect(isCurrentKnowBeforeYouGo({ version, hash: KNOW_BEFORE_YOU_GO_SHA256 })).toBe(true);
    expect(
      isCurrentKnowBeforeYouGo({ version: '2020-01-01', hash: KNOW_BEFORE_YOU_GO_SHA256 }),
    ).toBe(false);
    expect(isCurrentKnowBeforeYouGo({ version, hash: '0'.repeat(64) })).toBe(false);
  });
});

describe('the questions', () => {
  it('are seven, with distinct ids, a dated version, and every field written', () => {
    expect(KNOW_BEFORE_YOU_GO.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(questions).toHaveLength(7);
    expect(new Set(questions.map((q) => q.id)).size).toBe(7);
    for (const q of questions) {
      expect(q.id).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const text of [q.prompt, q.right, q.wrong, q.why, q.say]) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
        // Straight apostrophes are a sign of a paste that skipped the typography.
        expect(text).not.toMatch(/'/);
      }
      expect(q.right).not.toBe(q.wrong);
    }
  });

  it('do not always put the right answer first', () => {
    const firsts = questions.map((q) => q.rightFirst);
    expect(firsts).toContain(true);
    expect(firsts).toContain(false);
  });

  it('are the reviewed seven, by id, in order', () => {
    expect(questions.map((q) => q.id)).toEqual([
      'one-look',
      'check-it-yourself',
      'empty-map',
      'notes-not-answers',
      'your-call',
      'shore-plan',
      'gear',
    ]);
  });
});

describe('knowBeforeYouGoAnswers', () => {
  it('draws the answers in the data’s order, marking which is right', () => {
    for (const q of questions) {
      const [one, two] = knowBeforeYouGoAnswers(q);
      expect(one.right).toBe(q.rightFirst);
      expect(two.right).toBe(!q.rightFirst);
      expect([one, two].find((a) => a.right)?.text).toBe(q.right);
      expect([one, two].find((a) => !a.right)?.text).toBe(q.wrong);
    }
  });
});
