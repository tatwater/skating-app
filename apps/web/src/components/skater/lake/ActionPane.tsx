import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft } from '@fortawesome/sharp-light-svg-icons';
import { type ReactNode, useEffect, useRef } from 'react';

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
  autoFocus = true,
  children,
}: {
  act: LakeAct | 'request';
  /** Where Back goes: the lake's name, or "Explore". */
  backTo: string;
  onBack: () => void;
  /** Take the focus on open (always, in the app; a side-by-side story gives it to one quad). */
  autoFocus?: boolean;
  /** The action's own body (agent J's flows); the placeholder until one lands. */
  children?: ReactNode;
}) {
  const back = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new action takes the focus again.
  useEffect(() => {
    if (!autoFocus) return;
    // Whatever opened the action (the header's link, the dock) gets the focus back when it closes;
    // if that's gone, the sidebar's first control does, so the keyboard never drops to <body>.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pane = back.current?.closest<HTMLElement>('[data-slot="lake-sidebar"]') ?? null;
    back.current?.focus();
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else pane?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
    };
  }, [act, autoFocus]);
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
      {children ?? <p className="m-0 text-row text-fg2">Coming soon.</p>}
    </section>
  );
}
