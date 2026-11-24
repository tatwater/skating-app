import { ONBOARDING_COPY } from '@skating/core';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { ENTRY_PRIMARY, EntryHead, EntryScreen, WIDE } from './EntryScreen';

/** A full reload: the only way this tab gets the new bundle, and the new words with it. */
export function reloadPage(): void {
  window.location.reload();
}

/**
 * **Time for an update** (not drawn): where a step stops when the server refuses `client_outdated`
 * — this tab's bundled terms, Privacy Notice or questions aren't the ones the server knows, and no
 * amount of reading them again can change that. Blocking on purpose: nothing on it re-arms the step,
 * and its one button reloads the page, which fetches the new bundle. It never says what changed (a
 * Privacy Notice change alone isn't new terms).
 */
export function OutdatedStep({
  kicker,
  email,
  onReload,
  onSignOut,
  className,
}: {
  /** The step it stopped: the terms or the questions. */
  kicker: string;
  email: string | null;
  onReload: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.outdated;
  return (
    <EntryScreen
      width="receipt"
      className={className}
      email={email}
      onSignOut={onSignOut}
      head={
        <EntryHead kicker={kicker} title={copy.heading}>
          <p data-slot="outdated-line" className="m-0">
            {copy.web}
          </p>
        </EntryHead>
      }
      actions={
        <Button
          variant="primary"
          autoFocus
          className={cn(ENTRY_PRIMARY, WIDE)}
          onClick={onReload}
          data-attr="entry-reload"
        >
          {copy.reload}
        </Button>
      }
    />
  );
}
