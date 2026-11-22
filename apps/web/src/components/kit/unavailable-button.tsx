import type { ReactNode } from 'react';

import { Button, type ButtonProps } from './button';
import { type ToastManager, toast } from './toast';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/**
 * The entry point to something that isn't built yet: drawn exactly as the board draws the working
 * control — same face, same key — and never a dead click.
 *
 * - **It says so, plainly, three ways.** Hover or focus shows a tooltip under its title; a press (or
 *   its key) shows a toast in the same words; a reader hears it through `aria-disabled` and the
 *   description. Nothing else happens.
 * - **Two titles, by what is missing.** A tool that isn't built says *Not available yet* (the
 *   default) and `what` is the operator's sentence — what the tool will do once it exists
 *   ("Dropping a landmark on the map comes with the map tools"). A link into a console mode that
 *   isn't built (*Open in Reports →*, a *History →* naming Reports) passes `title={COMING_SOON}`
 *   and says *Coming soon*; it needs no sentence (D286). No dates, no promises.
 * - **It stays focusable**, so a keyboard reader reaches it and learns why it does nothing.
 * - **Drawn as the board draws it**: any `Button` variant — `variant="link"` for a link chip, which
 *   ends in its arrow as a live one does. `ComingSoonLink` is that link, ready made.
 */

/** The title a tool that isn't built yet wears, on its tooltip and its toast. */
const NOT_YET = 'Not available yet';

/** The title a link into a console mode that isn't built yet wears (D286). */
const COMING_SOON = 'Coming soon';

type UnavailableTitle = typeof NOT_YET | typeof COMING_SOON;

/** A tool says what it will do; a link into an unbuilt mode may say nothing more than its title. */
type UnavailableWords =
  | {
      /** What the tool will do, in a sentence: the tooltip's body and the toast's description. */
      what: ReactNode;
      /** The tooltip's and the toast's title. Default *Not available yet*. */
      title?: typeof NOT_YET;
    }
  | {
      /** Anything worth adding under the title; usually nothing. */
      what?: ReactNode;
      title: typeof COMING_SOON;
    };

type UnavailableButtonProps = Omit<ButtonProps, 'onClick' | 'disabled' | 'children' | 'title'> &
  UnavailableWords & {
    children: ReactNode;
    /** The toast queue; the app's own unless a story or a test passes one. */
    manager?: ToastManager;
  };

/**
 * A handler prop's third state, beside a function (the write) and `undefined` (the viewer can't):
 * the write isn't built yet, so the control is drawn and says *Not available yet*. One marker for
 * every view that draws such a control.
 */
const UNAVAILABLE = 'unavailable' as const;
type Unavailable = typeof UNAVAILABLE;

/**
 * Shows the toast that says it isn't here yet — what a press, or its key, does. A pane binding the
 * control's key calls this with the control's own words.
 */
function sayUnavailable(
  what: ReactNode,
  manager?: ToastManager,
  title: UnavailableTitle = NOT_YET,
): void {
  toast(what == null ? { title } : { title, description: what }, manager);
}

/** The toast a link into an unbuilt mode shows: *Coming soon* — what its press or its key does. */
function sayComingSoon(manager?: ToastManager): void {
  sayUnavailable(undefined, manager, COMING_SOON);
}

function UnavailableButton({
  what,
  title = NOT_YET,
  manager,
  children,
  ...props
}: UnavailableButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...props}
            data-unavailable=""
            data-unavailable-title={title}
            aria-disabled="true"
            // After the spread: a press only ever speaks, whatever a caller passes.
            onClick={() => sayUnavailable(what, manager, title)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent title={title}>{what}</TooltipContent>
    </Tooltip>
  );
}

type ComingSoonLinkProps = Omit<UnavailableButtonProps, 'variant' | 'title' | 'what'> & {
  /** Anything worth adding under *Coming soon*; usually nothing. */
  what?: ReactNode;
};

/**
 * A link into a console mode that isn't built yet (D286): the outlined link chip, its arrow and its
 * size as the live link's (`xs`, the chip in a pane head), saying *Coming soon* on hover, focus and
 * press. Pass the label without the arrow ("Open in Reports"); the chip draws it.
 */
function ComingSoonLink({ size = 'xs', ...props }: ComingSoonLinkProps) {
  return <UnavailableButton variant="link" size={size} title={COMING_SOON} {...props} />;
}

export {
  COMING_SOON,
  ComingSoonLink,
  type ComingSoonLinkProps,
  NOT_YET,
  sayComingSoon,
  sayUnavailable,
  UNAVAILABLE,
  type Unavailable,
  UnavailableButton,
  type UnavailableButtonProps,
  type UnavailableTitle,
};
