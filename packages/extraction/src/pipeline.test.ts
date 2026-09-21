import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { claudeOnlyExtractor } from './claude/claudeOnly';
import { defaultVocabulary, type ExtractionInput } from './contract';
import type { JevClient } from './jev/client';
import { claudeThenJevExtractor } from './pipeline';

const input: ExtractionInput = {
  title: 'Morey',
  text: 'Skated Morey. Black ice at the north end, 3-4 inches by the auger.',
  bodyCandidates: [{ ref: 'morey', name: 'Lake Morey', aliases: [], subAreas: [] }],
  vocabulary: defaultVocabulary(),
  writtenAtMs: Date.UTC(2026, 0, 10, 22),
  timeZone: 'America/New_York',
};

/** A fake Anthropic client whose `messages.parse` returns a canned parsed output. */
function fakeClaude(parsed: unknown, calls: unknown[] = []): Anthropic {
  return {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params);
        return {
          parsed_output: parsed,
          stop_reason: 'end_turn',
          model: 'claude-fake',
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Anthropic;
}

describe('claudeOnlyExtractor', () => {
  it('runs one call, maps the wire result, and prices it at the model rate', async () => {
    const calls: { model?: string; system?: unknown }[] = [];
    const client = fakeClaude(
      {
        reports: [
          {
            bodyRef: 'morey',
            visit: 0,
            fields: {
              iceTypes: [
                {
                  value: { type: 'black_ice', where: { sector: 'N' } },
                  confidence: 0.9,
                  quote: 'Black ice at the north end',
                  quoteField: 'text',
                },
              ],
            },
          },
        ],
        misses: [],
      },
      calls,
    );
    const run = await claudeOnlyExtractor(client, 'haiku').extract(input);
    expect(run.result.reports[0]?.fields.iceTypes[0]?.value).toEqual({
      type: 'black_ice',
      where: { sector: 'N' },
    });
    expect(run.usage).toMatchObject({
      engine: 'claude-only:haiku',
      requests: 1,
      inputTokens: 1000,
      outputTokens: 200,
    });
    expect(run.usage.costUsd).toBeCloseTo((1000 * 1 + 200 * 5) / 1e6, 9);
    expect(calls[0]?.model).toBe('claude-haiku-4-5');
  });

  it('fails loudly when the model returns nothing parseable', async () => {
    const client = fakeClaude(null);
    await expect(claudeOnlyExtractor(client, 'sonnet').extract(input)).rejects.toThrow(
      /structured output/,
    );
  });
});

describe('claudeThenJevExtractor', () => {
  it('segments with Claude, votes with Jev per unit, and sums the usage', async () => {
    const client = fakeClaude({
      units: [
        {
          bodyRef: 'morey',
          visit: 0,
          sentences: ['Skated Morey.', 'Black ice at the north end, 3-4 inches by the auger.'],
          measurements: [
            { quote: '3-4 inches by the auger', kind: 'ice_thickness', minInches: 3, maxInches: 4 },
          ],
          compassPhrases: [{ quote: 'the north end', sector: 'N' }],
        },
      ],
      misses: [{ kind: 'field', text: 'windy', wouldNeed: 'wind' }],
    });
    const asked: string[] = [];
    const jev: JevClient = {
      async ask(state, questions) {
        asked.push(state);
        expect(Object.keys(questions)).toContain('iceTypes.black_ice');
        return {
          model: 'jev-1',
          answers: {
            'iceTypes.black_ice': { type: 'noul', noul: 0.96 },
            'iceTypes.black_ice.where': {
              type: 'choice',
              choice: 'p0',
              confidence: 0.9,
              probabilities: { p0: 0.9, none: 0.1 },
            },
            quality: {
              type: 'choice',
              choice: 'none',
              confidence: 0.6,
              probabilities: { none: 0.6, great: 0.4 },
            },
            'm0.method': {
              type: 'choice',
              choice: 'measured',
              confidence: 0.9,
              probabilities: { measured: 0.9 },
            },
          },
          usage: { input_tokens: 300, output_tokens: 50 },
        };
      },
    };
    const run = await claudeThenJevExtractor(client, 'haiku', jev).extract(input);
    expect(asked).toEqual([
      'Title: Morey\nSkated Morey. Black ice at the north end, 3-4 inches by the auger.',
    ]);
    const [r] = run.result.reports;
    expect(r?.fields.iceTypes).toEqual([
      expect.objectContaining({
        value: { type: 'black_ice', where: { sector: 'N' } },
        confidence: 0.96,
      }),
    ]);
    expect(r?.fields.quality).toEqual([]);
    expect(r?.fields.thickness[0]?.value).toEqual({
      method: 'measured',
      minCm: 7.62,
      maxCm: 10.16,
    });
    expect(run.result.misses).toEqual([{ kind: 'field', text: 'windy', wouldNeed: 'wind' }]);
    expect(run.usage).toMatchObject({
      engine: 'claude+jev:haiku',
      requests: 2,
      inputTokens: 1300,
      outputTokens: 250,
    });
  });
});
