/**
 * The Claude-only extractor (D196) — one structured-output call returning the whole contract.
 *
 * The sibling the eval measures Stage A + Jev against: if this matches Jev on the enums, Stage B
 * is not earned and is dropped. Its confidences are self-reported and uncalibrated by construction;
 * whether they are good enough to set floors from is exactly what §1.3 finds out.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ExtractionInput, ExtractionRun, Extractor } from '../contract';
import { type ClaudeModelKey, callStructured, claudeCostUsd } from './client';
import { systemPrompt, userPrompt } from './prompt';
import { mapWireResult, WireResultSchema } from './wire';

export function claudeOnlyExtractor(client: Anthropic, model: ClaudeModelKey): Extractor {
  return {
    name: `claude-only:${model}`,
    async extract(input: ExtractionInput): Promise<ExtractionRun> {
      const started = Date.now();
      const call = await callStructured(
        client,
        model,
        WireResultSchema,
        systemPrompt(input.vocabulary),
        userPrompt(input),
      );
      return {
        result: mapWireResult(call.data, input),
        usage: {
          engine: `claude-only:${model}`,
          latencyMs: Date.now() - started,
          costUsd: claudeCostUsd(call.usage, model),
          inputTokens:
            call.usage.inputTokens +
            call.usage.cacheReadInputTokens +
            call.usage.cacheCreationInputTokens,
          outputTokens: call.usage.outputTokens,
          requests: 1,
        },
      };
    },
  };
}
