import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft } from '@fortawesome/sharp-light-svg-icons';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';

import type { LakeAct } from './lakeSearch';

/** What each action is called on its pane. */
export const LAKE_ACT_TITLES: Readonly<Record<LakeAct | 'request', string>> = {
  hazard: 'Report a hazard',
  bounty: 'Post a bounty',
  imagery: 'Latest imagery',
  'access-problem': 'Report an access problem',
  request: 'Request a lake',
};

/**
 * An action over the lake's sidebar (`?act=`, row 3) — views stack, so it opens as an inset over
 * the tab it came from. **The flows themselves aren't here yet**: this pane is the frame they land
 * in, with its way back. Back and Esc both leave by dropping the param (the page's Esc handler);
 * focus moves into the pane on open, since an action is a route and Base UI's focus return doesn't
 * come free (§1.8).
 */
export function ActionPane({
  act,
  backTo,
  onBack,
}: {
  act: LakeAct | 'request';
  /** Where Back goes: the lake's name, or "Explore". */
  backTo: string;
  onBack: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new action takes the focus again.
  useEffect(() => {
    back.current?.focus();
  }, [act]);
  return (
    <section
      aria-label={LAKE_ACT_TITLES[act]}
      data-slot="lake-action"
      data-act={act}
      className="flex flex-col gap-(--space-4) border border-solid border-line2 bg-panel p-(--space-4)"
    >
      <div className="flex items-center gap-(--space-2)">
        <Button ref={back} variant="bare" size="sm" data-attr="lake-action-back" onClick={onBack}>
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" className="h-[0.9em]" />
          Back to {backTo}
        </Button>
        <Kbd className="ms-auto" aria-hidden="true">
          Esc
        </Kbd>
      </div>
      <h2 className="m-0 text-disp leading-none font-semibold tracking-disp text-fg uppercase">
        {LAKE_ACT_TITLES[act]}
      </h2>
      <p className="m-0 text-row text-fg2">Coming soon.</p>
    </section>
  );
}
