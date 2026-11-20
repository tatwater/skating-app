import type { DeploymentTarget } from './deployment';
import type { ConvexCaller } from './runLogger';
import type { ImportRunCoverage, ImportRunKind, RunCount, RunFailure, RunStage } from './types';

export interface RunReceipt {
  kind: ImportRunKind;
  label: string;
  status?: 'succeeded' | 'failed';
  campaignId?: string;
  startedAt?: number;
  finishedAt?: number;
  counts?: RunCount[];
  stages?: RunStage[];
  failures?: RunFailure[];
  failuresTotal?: number;
  coverage?: ImportRunCoverage;
  error?: string;
  notes?: string[];
  /** Override the row's deployment label, not the destination of the write. */
  deployment?: string;
  isProd?: boolean;
}

/** File a completed run, leaving the caller to decide what a failed receipt means. */
export function writeRunReceipt(
  receipt: RunReceipt,
  target: DeploymentTarget,
  call: ConvexCaller,
): string {
  const startedAt = receipt.startedAt ?? Date.now();
  const runId = call<string>(
    'importRuns:start',
    omitMissingFields({
      kind: receipt.kind,
      label: receipt.label,
      campaignId: receipt.campaignId,
      deployment: receipt.deployment ?? target.label,
      isProd: receipt.isProd ?? target.isProd,
      stages: receipt.stages ?? [],
      notes: receipt.notes,
    }),
  );

  call(
    'importRuns:finish',
    omitMissingFields({
      runId,
      status: receipt.status ?? 'succeeded',
      counts: receipt.counts,
      failures: receipt.failures,
      failuresTotal: receipt.failuresTotal,
      coverage: receipt.coverage,
      error: receipt.error,
      notes: receipt.notes,
    }),
  );

  // Start and finish stamp the server clock. Leave those times alone for live runs, but do not
  // present an archived fetch as something that happened just now.
  if (receipt.startedAt !== undefined || receipt.finishedAt !== undefined) {
    call('importRuns:restamp', {
      runId,
      startedAt,
      finishedAt: receipt.finishedAt ?? startedAt,
    });
  }
  return runId;
}

// Convex optional fields must be absent, not null. Shell callers can use null instead of building
// optional fields conditionally. Only the top-level fields are normalized.
function omitMissingFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  );
}
