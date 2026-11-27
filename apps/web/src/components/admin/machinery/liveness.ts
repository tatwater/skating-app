import {
  campaignLiveness,
  type RunLiveness,
  type RunLivenessInput,
  runLiveness,
} from '@skating/core';

import type { LaneTailView, RunRowView } from './machineryTypes';

/**
 * **Machinery's one re-reading of core's stall rule.** The server answers every read with its
 * verdict at the minute it was asked (`callerNow`), and with the inputs that verdict was read from
 * (`livenessInputs`); the web re-reads those inputs by the same rule on its own clock, so a run turns
 * late or stalled on the second it does rather than at the next minute's answer. The run list and
 * both run pages read a row through this function alone, so the list and the page open beside it can
 * never disagree about a run's state at the same clock.
 *
 * A row the server sends no inputs for (ended, marked, rebuilt) keeps the server's verdict: it can't
 * come alive again.
 */

/** Core's one-run rule, as the pages take it (a story may pin its own). */
export type LivenessRule = (run: RunLivenessInput, now: number) => RunLiveness;

export const CORE_RULE: LivenessRule = runLiveness;

type Rereadable = Pick<RunRowView, 'kind' | 'liveness' | 'livenessInputs'>;

/** A row's liveness at `now`: re-read from its inputs, else the server's. */
export function livenessAt(
  row: Rereadable,
  now: number,
  rule: LivenessRule = CORE_RULE,
): RunRowView['liveness'] {
  const inputs = row.livenessInputs;
  if (inputs === undefined || inputs === null) return row.liveness;
  return row.kind === 'campaign'
    ? campaignLiveness(inputs.self, inputs.passes, now, rule)
    : rule(inputs.self, now);
}

/** Every row of a list at `now` (the same object back when nothing moved). */
export function rowsAt<R extends Rereadable>(rows: readonly R[], now: number): R[] {
  return rows.map((row) => {
    const liveness = livenessAt(row, now);
    return liveness === row.liveness ? row : { ...row, liveness };
  });
}

/**
 * A sidebar tail at `now`: a live one re-read from the inputs it carries, by the rule the list reads
 * its rows by, so the tail and the list beside it change on the same second. A finished tail (ok,
 * failed, never) keeps the server's word.
 */
export function laneTailAt(
  tail: LaneTailView,
  now: number,
  rule: LivenessRule = CORE_RULE,
): LaneTailView {
  const inputs = tail.livenessInputs;
  if (inputs === undefined) return tail;
  const liveness =
    tail.kind === 'campaign'
      ? campaignLiveness(inputs.self, inputs.passes, now, rule)
      : rule(inputs.self, now);
  if (liveness.state === 'finished' || liveness.state === tail.state) return tail;
  return { ...tail, state: liveness.state };
}
