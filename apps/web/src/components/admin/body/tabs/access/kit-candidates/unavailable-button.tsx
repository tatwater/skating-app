import type { ReactNode } from 'react';

import { Button, type ButtonProps } from '@/components/kit/button';
import { type ToastManager, toast } from '@/components/kit/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';

/**
 * **Kit candidate.** The entry point to a tool that isn't built yet: drawn exactly as the board
 * draws the working button — same face, same key — and never a dead click.
 *
 * - **It says so, plainly, three ways.** Hover or focus shows a tooltip titled *Not available
 *   yet*; a press (or its key) shows a toast in the same words; a reader hears it through
 *   `aria-disabled` and the description. Nothing else happens.
 * - **It stays focusable**, so a keyboard reader reaches it and learns why it does nothing.
 * - **`what` is the operator's sentence** — what the tool will do once it exists ("Dropping a
 *   landmark on the map comes with the map tools"). No dates, no promises.
 *
 * Kit-shaped (tokens only, no page data) so promoting it is a file move: `kit/unavailable-button`.
 */

type UnavailableButtonProps = Omit<ButtonProps, 'onClick' | 'disabled' | 'children'> & {
  /** What the tool will do, in a sentence: the tooltip's body and the toast's description. */
  what: ReactNode;
  children: ReactNode;
  /** The toast queue; the app's own unless a story or a test passes one. */
  manager?: ToastManager;
};

/** The title both the tooltip and the toast wear. */
const NOT_YET = 'Not available yet';

/** Shows the toast that says the tool isn't here yet — what a press, or its key, does. */
function sayUnavailable(what: ReactNode, manager?: ToastManager): void {
  toast({ title: NOT_YET, description: what }, manager);
}

function UnavailableButton({ what, manager, children, ...props }: UnavailableButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-unavailable=""
            aria-disabled="true"
            onClick={() => sayUnavailable(what, manager)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent title={NOT_YET}>{what}</TooltipContent>
    </Tooltip>
  );
}

export { NOT_YET, sayUnavailable, UnavailableButton, type UnavailableButtonProps };
