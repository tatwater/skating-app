/**
 * **The verify stage** (B05 §2.5), `cli/verify.ts`' frame: the preflight (`preflightVerify`) under
 * the campaign's lock, then the row, then the checks (`checks`, the CLI's: the public URL, the
 * private bucket through `rclone serve http`, the report and the viewer page) — so a refusal opens
 * no row and writes no report. A check that fails is the verdict, not a refusal: the report is
 * written (it is where the verdict's detail lives; no later stage reads it) and the row closes
 * failed, and the stage exits 1.
 *
 * Writes, in order: row open → the report → the viewer → row close.
 */

import { assembleScope } from '../assemble/orchestrate';
import { withCampaignLock } from '../campaignLock';
import { preflightVerify, type VerifyPlan } from '../preflight';
import { parseStageArgs, type StageArgs } from '../stages';
import type { RunRow, StageWorld } from '../world';

/** The checks themselves, with the row to beat; resolves with the exit status. */
export type VerifyChecks = (
  args: StageArgs,
  plan: VerifyPlan,
  row: RunRow | null,
) => Promise<number>;

export async function runVerifyStage(
  argv: readonly string[],
  world: StageWorld,
  checks: VerifyChecks,
): Promise<number> {
  const args = parseStageArgs(argv, 'verify');
  return withCampaignLock(
    world.scratch,
    args.campaign,
    'verify',
    world.process,
    world.now(),
    async () => {
      const plan = preflightVerify(args, world);
      const row =
        plan.deployment === null
          ? null
          : world.row({
              kind: 'aerial_assemble',
              label: `verify ${args.campaign}${args.pilot ? ` (pilot ${args.pilot})` : ''}`,
              campaignId: args.campaign,
              target: plan.deployment,
              scope: assembleScope(args.pilot),
            });
      row?.start();
      // A verify that throws (an unreadable record, a malformed shard index, rclone's server failing
      // to start) fails its row rather than leaving it running: the other stages' rows do the same.
      try {
        return await checks(args, plan, row);
      } catch (e) {
        row?.failed(e);
        throw e;
      }
    },
  );
}
