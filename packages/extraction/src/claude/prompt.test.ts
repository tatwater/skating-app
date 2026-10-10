import { describe, expect, it } from 'vitest';
import { defaultVocabulary } from '../contract';
import { systemPrompt, userPrompt } from './prompt';

describe('systemPrompt', () => {
  const vocab = defaultVocabulary();
  it('is deterministic and names every vocabulary value', () => {
    const a = systemPrompt(vocab);
    expect(systemPrompt(vocab)).toBe(a);
    for (const list of Object.values(vocab)) for (const v of list) expect(a).toContain(v);
  });
  it('never says the ice is safe', () => {
    expect(systemPrompt(vocab).toLowerCase()).not.toMatch(/ice is safe|safe to skate|good to go/);
  });
  // The first verified labels (A10-9): the rules the founder's review found the engines breaking.
  it('carries the reviewed rules: non-reports, other days, weather, crossings, the parts not skated', () => {
    const p = systemPrompt(vocab);
    expect(p).toContain('a season summary, a retrospective');
    expect(p).toContain('Decide sentence by sentence, never for the email as a whole');
    expect(p).toContain('A different day is a different visit');
    expect(p).toContain('Weather is not an observation of the ice');
    expect(p).toContain('going around it, or over land, is a pressure_ridge');
    expect(p).toContain('a number alone ("4 inches") says neither');
    expect(p).toContain('is a hazard with a where, not dont_go');
    expect(p).toContain('only a part of the lake they did not skate');
    expect(p).toContain('topic" one of parking, access, feature, character, other');
  });
});

describe('userPrompt', () => {
  it('lists candidates with aliases, places and bays, the written time, the title and the text', () => {
    const p = userPrompt({
      title: 'Morey 1/10',
      text: 'Skated it.',
      bodyCandidates: [
        {
          ref: 'r1',
          name: 'Lake Morey',
          aliases: ['Morey'],
          place: 'Fairlee, VT',
          subAreas: [{ id: 'sa1', name: 'The Cove', aliases: ['the cove'] }],
        },
      ],
      vocabulary: defaultVocabulary(),
      writtenAtMs: Date.UTC(2026, 0, 10, 22),
      timeZone: 'America/New_York',
    });
    expect(p).toContain(
      '- ref "r1": Lake Morey (also: Morey) — Fairlee, VT; bays: The Cove [id sa1] (also: the cove)',
    );
    expect(p).toContain('Written at: 2026-01-10T22:00:00.000Z (time zone America/New_York)');
    expect(p).toContain('Title:\nMorey 1/10');
    expect(p).toContain('Text:\nSkated it.');
  });
  it('says so when no candidates are offered', () => {
    const p = userPrompt({
      text: 'x',
      bodyCandidates: [],
      vocabulary: defaultVocabulary(),
      timeZone: 'UTC',
    });
    expect(p).toContain('none offered');
    expect(p).not.toContain('Written at');
  });
});
