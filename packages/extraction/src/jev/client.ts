/**
 * The TypeSafe Jev client — one REST endpoint, no SDK for TypeScript (the vendor ships Python).
 *
 * `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`:
 * a `state` (text) and a map of typed questions, answered in parallel and in isolation against
 * the same state. Three primitives (docs.typesafe.ai/primitives): `choice` returns the chosen
 * option, a probability distribution over the options and a `confidence` (the distribution's
 * peakedness); `noul` returns a 0–1 probability that a statement is true and **no confidence**;
 * `score` places the state on an ordered rubric. Adding questions barely changes the latency.
 *
 * `TYPESAFE_API_KEY` comes from the process env like the Anthropic key; never echoed. Pricing is
 * not in the docs — `usage` is returned and recorded, and the cost column is filled once the
 * console says what a token costs. Excluded from unit coverage; the eval exercises it.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria?: string }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevClient {
  ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResponse>;
}

/**
 * USD per MTok, from the TypeSafe console after the first eval run (2026-09-21): 310 requests,
 * 1,993,299 tokens, $0.0532 — a blended 2.7¢ per MTok, ~40× under Haiku's input rate. The console
 * reports one total, so input and output carry the same blended rate until it says otherwise.
 */
export const JEV_RATES = { inputPerMTok: 0.0267, outputPerMTok: 0.0267 };

export function jevCostUsd(usage: JevResponse['usage']): number {
  return (
    (usage.input_tokens * JEV_RATES.inputPerMTok + usage.output_tokens * JEV_RATES.outputPerMTok) /
    1_000_000
  );
}

export function createJevClient(fetchImpl: typeof fetch = fetch): JevClient {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new Error(
      'TYPESAFE_API_KEY is not set (load packages/convex/.env.local into the shell first).',
    );
  }
  return {
    async ask(state, questions) {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      });
      if (!response.ok) {
        // The body may carry the reason; the key never appears in it.
        const text = await response.text().catch(() => '');
        throw new Error(`Jev ${response.status}: ${text.slice(0, 300)}`);
      }
      return (await response.json()) as JevResponse;
    },
  };
}
