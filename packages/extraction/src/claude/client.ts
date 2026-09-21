/**
 * The Anthropic client and one structured-output call — the engine's only network surface.
 *
 * `ANTHROPIC_API_KEY` comes from the process env (the Convex dev env for the action, the shell for
 * the eval harness — `set -a; source packages/convex/.env.local; set +a`). Never echoed, never
 * logged. Excluded from unit coverage; the eval harness exercises it against the real API.
 *
 * Caching: the system prompt is marked `cache_control` because it is the stable prefix, but note
 * the minimum cacheable prefix is model-dependent — 4,096 tokens on Haiku 4.5, 1,024 on Sonnet 5 —
 * so on Haiku this prefix does **not** cache and `cache_creation_input_tokens` stays 0. That is the
 * finding of the 2026-09-19 mention inventory (the §1.3 warning was misdiagnosed: the order was
 * right, the prompt was short). Corpus-scale passes go through the Batch API instead.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

export const CLAUDE_MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
} as const;
export type ClaudeModelKey = keyof typeof CLAUDE_MODELS;

/** Per-MTok rates (the claude-api skill's table, 2026-06) and the standard cache multipliers. */
export const CLAUDE_RATES: Record<ClaudeModelKey, { inputPerMTok: number; outputPerMTok: number }> =
  {
    haiku: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
    sonnet: { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  };
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function claudeCostUsd(usage: ClaudeUsage, model: ClaudeModelKey): number {
  const r = CLAUDE_RATES[model];
  return (
    (usage.inputTokens * r.inputPerMTok +
      usage.cacheCreationInputTokens * r.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadInputTokens * r.inputPerMTok * CACHE_READ_MULTIPLIER +
      usage.outputTokens * r.outputPerMTok) /
    1_000_000
  );
}

export function createClaudeClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set (load packages/convex/.env.local into the shell first).',
    );
  }
  return new Anthropic();
}

export interface StructuredCall<T> {
  data: T;
  usage: ClaudeUsage;
  model: string;
}

/** One structured-output call: a cached system block, one user turn, a Zod schema. */
export async function callStructured<T>(
  client: Anthropic,
  model: ClaudeModelKey,
  schema: z.ZodType<T>,
  system: string,
  user: string,
  maxTokens = 16_000,
): Promise<StructuredCall<T>> {
  const response = await client.messages.parse({
    model: CLAUDE_MODELS[model],
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: zodOutputFormat(schema) },
  });
  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error(`structured output failed to parse (stop_reason: ${response.stop_reason})`);
  }
  // Re-run the schema so defaults are applied whatever the SDK's parser did — the mapping code
  // relies on `.default([])` having filled every list.
  return {
    data: schema.parse(response.parsed_output),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model: response.model,
  };
}
