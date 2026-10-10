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
  /** Released 2026-09-28; same price as Sonnet 5, a 512-token cache minimum, thinking off is `between_tools`. */
  sonnet55: 'claude-sonnet-5-5',
} as const;
export type ClaudeModelKey = keyof typeof CLAUDE_MODELS;

/** Per-MTok rates (platform.claude.com pricing, checked 2026-09-29) and the standard cache multipliers. */
export const CLAUDE_RATES: Record<ClaudeModelKey, { inputPerMTok: number; outputPerMTok: number }> =
  {
    haiku: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
    sonnet: { inputPerMTok: 2.0, outputPerMTok: 10.0 },
    sonnet55: { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  };

/**
 * How hard the model thinks before it answers. The Sonnets think adaptively by default at `high`
 * effort, and that thinking is spent from the same `max_tokens` as the JSON — the first eval's
 * five truncated answers were long emails where thinking left too little room. `thinking: 'off'` is
 * each model's lowest setting (Sonnet 5 `disabled`, Sonnet 5.5 `between_tools`, which with no tools
 * means no thinking); Haiku 4.5 thinks only when asked and takes no effort parameter.
 */
export interface ClaudeCallOptions {
  effort?: 'low' | 'medium' | 'high';
  thinking?: 'adaptive' | 'off';
}

/** The answer stopped before it was whole — out of tokens, or declined — so there is nothing to parse. */
export class ClaudeIncompleteError extends Error {
  constructor(
    readonly stopReason: string,
    readonly outputTokens: number,
  ) {
    super(
      `structured output incomplete (stop_reason: ${stopReason}, ${outputTokens} output tokens)`,
    );
  }
}

function thinkingParam(model: ClaudeModelKey, opts: ClaudeCallOptions): object {
  if (model === 'haiku' || opts.thinking !== 'off') return {};
  // SDK 0.127 predates Sonnet 5.5, so its thinking union has no `between_tools` member.
  return { thinking: { type: model === 'sonnet55' ? 'between_tools' : 'disabled' } };
}
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

/**
 * One structured-output call: a cached system block, one user turn, a Zod schema. Streamed, so a
 * large `max_tokens` never meets the HTTP timeout, and the stop reason is read before the JSON: a
 * truncated or declined answer is a `ClaudeIncompleteError` that says so, where the SDK's parse
 * helper throws "Unterminated string in JSON" and hides why.
 */
export async function callStructured<T>(
  client: Anthropic,
  model: ClaudeModelKey,
  schema: z.ZodType<T>,
  system: string,
  user: string,
  opts: ClaudeCallOptions = {},
  maxTokens = 32_000,
): Promise<StructuredCall<T>> {
  const { parse, ...format } = zodOutputFormat(schema);
  const params = {
    model: CLAUDE_MODELS[model],
    max_tokens: model === 'haiku' ? Math.min(maxTokens, 64_000) : maxTokens,
    system: [
      { type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } },
    ],
    messages: [{ role: 'user' as const, content: user }],
    output_config: {
      format,
      ...(opts.effort && model !== 'haiku' ? { effort: opts.effort } : {}),
    },
    ...thinkingParam(model, opts),
  };
  const response = await client.messages
    .stream(params as unknown as Parameters<typeof client.messages.stream>[0])
    .finalMessage();
  if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') {
    throw new ClaudeIncompleteError(String(response.stop_reason), response.usage.output_tokens);
  }
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  // The helper's own parse (JSON + the Zod check), then the schema again so every `.default([])` the
  // mapping code relies on is filled.
  return {
    data: schema.parse(parse(text)),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model: response.model,
  };
}
