/**
 * Stage A + Stage B as one `Extractor` (D196): Claude segments, Jev votes per unit. Two round trips
 * per paragraph; the eval compares this against the Claude-only sibling per field and drops Stage B
 * where Claude alone matches it on the enums.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ClaudeCallOptions, ClaudeModelKey } from './claude/client';
import { claudeCostUsd } from './claude/client';
import { runStageA, segmentationMisses, unitText } from './claude/stageA';
import { denseVisits, mapAboutBody } from './claude/wire';
import type { ExtractionInput, ExtractionRun, Extractor } from './contract';
import { ExtractionResultSchema } from './contract';
import { type JevClient, jevCostUsd } from './jev/client';
import { questionsForUnit, reportFromAnswers } from './jev/stageB';
import { attachLandmarks } from './landmarks';

export function claudeThenJevExtractor(
  claude: Anthropic,
  model: ClaudeModelKey,
  jev: JevClient,
  opts: ClaudeCallOptions = {},
): Extractor {
  const name = `claude+jev:${model}`;
  return {
    name,
    async extract(input: ExtractionInput): Promise<ExtractionRun> {
      const started = Date.now();
      const a = await runStageA(claude, model, input, opts);
      let jevInput = 0;
      let jevOutput = 0;
      let jevCost = 0;
      const reports = [];
      const misses = segmentationMisses(a.segmentation);
      for (const unit of denseVisits(a.segmentation.units, input)) {
        const state = [input.title ? `Title: ${input.title}` : '', unitText(unit)]
          .filter(Boolean)
          .join('\n');
        const response = await jev.ask(state, questionsForUnit(unit, input.vocabulary));
        jevInput += response.usage.input_tokens;
        jevOutput += response.usage.output_tokens;
        jevCost += jevCostUsd(response.usage);
        reports.push(reportFromAnswers(unit, response.answers, input, misses));
      }
      const aboutBody = a.segmentation.aboutBody.map((f) => mapAboutBody(f, input));
      const result = attachLandmarks(
        ExtractionResultSchema.parse({ reports, aboutBody, misses }),
        input,
      );
      return {
        result,
        usage: {
          engine: name,
          latencyMs: Date.now() - started,
          costUsd: claudeCostUsd(a.usage, model) + jevCost,
          inputTokens:
            a.usage.inputTokens +
            a.usage.cacheReadInputTokens +
            a.usage.cacheCreationInputTokens +
            jevInput,
          outputTokens: a.usage.outputTokens + jevOutput,
          requests: 1 + a.segmentation.units.length,
        },
      };
    },
  };
}
