import type { ReactNode } from 'react';

import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonText } from '@/components/kit/skeleton';

import type { CampaignPageView, RunPageView } from '../machineryTypes';
import { NOTHING_OPEN, NOTHING_OPEN_HINT, RUN_FAILED, RUN_MISSING } from '../words/machineryWords';

/**
 * **The detail column's states** (board 6.2's right column): nothing open, a read on its way, a
 * failed read with *Try again*, a run that isn't there — and, once read, the campaign page or the
 * run page.
 *
 * The two pages are W2's (`CampaignView`, `RunView`); this frame hands each its read whole through
 * `pages`, so the route that wires the reads (`CorpusRunsRoute`) and the pages that draw them never
 * share a file.
 */

export type RunDetailState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; retrying: boolean }
  | { kind: 'missing' }
  | { kind: 'campaign'; view: CampaignPageView }
  | { kind: 'run'; view: RunPageView };

/** How the run pages are drawn: `CampaignView` and `RunView` (the route's live ones, a story's). */
export type RunPages = {
  campaign: (view: CampaignPageView) => ReactNode;
  run: (view: RunPageView) => ReactNode;
};

export function RunDetail({ state, pages }: { state: RunDetailState; pages: RunPages }) {
  switch (state.kind) {
    case 'none':
      return (
        <div
          data-slot="run-detail-none"
          className="flex flex-col gap-(--space-2) px-gutter pt-(--space-7)"
        >
          <p className="m-0 text-body leading-body font-medium text-fg1">{NOTHING_OPEN}</p>
          <p className="m-0 text-assist leading-list text-fg3">{NOTHING_OPEN_HINT}</p>
        </div>
      );
    case 'loading':
      return (
        <div
          data-slot="run-detail-loading"
          aria-busy="true"
          className="flex flex-col gap-(--space-3) px-gutter pt-(--space-4)"
        >
          <SkeletonText className="text-disp" width="40%" />
          <SkeletonText className="text-body" width="70%" />
        </div>
      );
    case 'failed':
      return (
        <RetryNote
          data-slot="run-detail-error"
          className="px-gutter pt-(--space-4)"
          onRetry={state.retry}
          pending={state.retrying}
        >
          {RUN_FAILED}
        </RetryNote>
      );
    case 'missing':
      return (
        <div className="px-gutter pt-(--space-4)">
          <Note data-slot="run-detail-missing">{RUN_MISSING}</Note>
        </div>
      );
    case 'campaign':
      return pages.campaign(state.view);
    case 'run':
      return pages.run(state.view);
  }
}
