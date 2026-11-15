import type { ReactNode } from 'react';

import type { ToastManager } from '@/components/kit/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { NOT_YET, sayUnavailable } from '@/components/kit/unavailable-button';
import { cn } from '@/lib/utils';

/**
 * **A field that isn't built yet** — a kit candidate (B01-3, the Body console's tabs), the
 * `UnavailableButton`'s pattern for a field: drawn exactly where the board draws the working field,
 * in its disabled face, and never a dead control.
 *
 * - **It says so, plainly, three ways.** Hover or focus shows the tooltip titled *Not available
 *   yet*; a press (or ⏎ / Space on it) shows the toast in the same words; a reader hears it through
 *   `aria-disabled` and the description. Nothing else happens.
 * - **It stays focusable**: the wrapper takes focus (the field inside is the caller's, passed
 *   `disabled`, and takes no pointer), so a keyboard reader reaches it and learns why.
 * - **`what` is the operator's sentence** — what the field will do once it exists. No dates, no
 *   promises.
 */

type UnavailableFieldProps = {
  /** What the field will do, in a sentence: the tooltip's body and the toast's description. */
  what: ReactNode;
  /** The field, drawn in its disabled face (`disabled`). */
  children: ReactNode;
  /** The field's name for a reader. */
  label: string;
  /** The toast queue; the app's own unless a story or a test passes one. */
  manager?: ToastManager;
  className?: string;
};

function UnavailableField({ what, children, label, manager, className }: UnavailableFieldProps) {
  const say = () => sayUnavailable(what, manager);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would take a legend and a box; this only wraps one field to say it is unavailable.
          <div
            role="group"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: reachable so a keyboard reader learns it is unavailable; the field inside is disabled and can't take focus.
            tabIndex={0}
            aria-label={label}
            aria-disabled="true"
            data-slot="unavailable-field"
            data-unavailable=""
            onClick={say}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                // The press's own path, so ⏎, Space and a click can't say different things.
                e.currentTarget.click();
              }
            }}
            className={cn(
              'block min-w-0 cursor-default outline-none focus-visible:shadow-focus',
              // The field inside is the caller's, disabled: the wrapper takes every press.
              '[&>*]:pointer-events-none',
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent title={NOT_YET}>{what}</TooltipContent>
    </Tooltip>
  );
}

export { UnavailableField, type UnavailableFieldProps };
