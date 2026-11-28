/**
 * PLACEHOLDER (B01-8b-2, W1) — **stand-ins for W2's cron card and runs drawer**, so the Imagery
 * page's stories and tests run before W2's `machinery/crons/*` lands. At integration the executor
 * swaps the one import in `./crons.ts` to `../crons` and deletes this file.
 *
 * The seam (W2 builds it): `<CronCard job={CronJobView} onOpenRuns={() => void} />` and
 * `<CronRunsDrawer job={string} open={boolean} onClose={() => void} />`, named exports of
 * `machinery/crons/index.ts`. **The page also passes `runNow`** (optional, additive): the poll's
 * *Run now* — `null` drawn disabled (imagery isn't running), absent not drawn — which W2's card and
 * drawer foot are asked to honor (the seam request in W1's report).
 *
 * Drawn plainly, from the card's own fields, close to the board's look: never a kit candidate.
 */

import { useState } from 'react';

import { Button } from '@/components/kit/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/kit/sheet';
import { cn } from '@/lib/utils';

import type { CronJobView, RunNowProp } from './imageryModel';
import { NOT_RECORDED_YET, RUN_NOW } from './imageryWords';

export function CronCard({
  job,
  onOpenRuns,
  runNow,
}: {
  job: CronJobView;
  onOpenRuns: () => void;
  runNow?: RunNowProp;
}) {
  const [busy, setBusy] = useState(false);
  const state = job.liveness.state;
  return (
    <div
      data-slot="cron-card"
      data-job={job.job}
      data-state={state}
      className="flex min-w-0 items-center gap-(--space-2_5) py-(--space-2_5) pe-(--space-4)"
    >
      <i
        aria-hidden="true"
        className={cn('size-(--space-1_5) shrink-0 bg-fg2', state === 'running' && 'bg-fg')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span className="truncate text-row font-medium text-fg">{job.title}</span>
        <span className="truncate text-assist text-fg3">{job.job}</span>
      </span>
      <span className="font-(family-name:--family-mono) text-mono-sm text-fg3">
        {state === 'never' ? NOT_RECORDED_YET : state}
      </span>
      <Button size="xs" onClick={onOpenRuns}>
        Runs
      </Button>
      {runNow !== undefined && (
        <Button
          size="xs"
          data-slot="cron-run-now"
          disabled={runNow === null}
          loading={busy}
          onClick={() => {
            if (runNow === null || busy) return;
            setBusy(true);
            void runNow.onPress().then(() => setBusy(false));
          }}
        >
          {RUN_NOW}
        </Button>
      )}
    </div>
  );
}

export function CronRunsDrawer({
  job,
  open,
  onClose,
}: {
  job: string;
  open: boolean;
  onClose: () => void;
  runNow?: RunNowProp;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent size="drawer" data-slot="cron-runs-drawer" data-job={job}>
        <SheetHeader>
          <SheetTitle>{job}</SheetTitle>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}
