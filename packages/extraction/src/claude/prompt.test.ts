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
