import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ReactNode, type Ref, useCallback } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Tooltip: shadcn's Base UI tooltip, re-skinned to the console's button tip (the plate
 * that replaced the action bar's explaining lines).
 *
 * - **Not inverted.** A plate in the panel ground with a `line2` edge and the plate shadow —
 *   never shadcn's ink-on-paper; **square** (a container) and **no arrow**.
 * - **Kicker title, then the words**: an optional caps title, ~6 px, then the body in the assist
 *   step. A title-less tip is just the words.
 * - **Never in navigation.** Rails, lane sidebars and tab rows carry no tooltips — a name that
 *   needs explaining is renamed. In development the trigger reports one placed in a `nav`,
 *   `[role=navigation]`, `[role=tablist]` or `[role=menubar]`.
 * - **A text trigger** (`variant="text"`) draws the dotted rule that hugs its text: an inline-block
 *   a line tall, so the rule sits just under the baseline, clear of descenders.
 * - It fades on the motion tokens (instant when the pointer moves between tips, and under reduced
 *   motion).
 */

/** Tips under one provider share their delay: once one is open, the next opens at once. */
const TooltipProvider = TooltipPrimitive.Provider;

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

const triggerVariants = cva('', {
  variants: {
    variant: {
      /** The trigger brings its own look (a Button through `render`, an icon). */
      plain: '',
      /** Text with more on hover: the dotted rule that hugs its text. */
      text: [
        'inline-block cursor-help border-b border-dotted border-fg3 pb-px leading-[1.1] outline-none',
        'focus-visible:shadow-focus',
      ],
    },
  },
  defaultVariants: { variant: 'plain' },
});

/** Where a tooltip may not go: navigation of any kind. */
const NAVIGATION = 'nav, [role="navigation"], [role="tablist"], [role="menubar"]';

/** Reports (in development) a trigger placed inside navigation. Exported for its test. */
function reportTooltipInNavigation(el: Element | null): boolean {
  if (el?.closest(NAVIGATION) == null) return false;
  console.error(
    'Kit Tooltip: tooltips never appear in navigation (rails, lane sidebars, tab rows). Rename the item, or let the page it opens say what it is.',
    el,
  );
  return true;
}

type TooltipTriggerProps = TooltipPrimitive.Trigger.Props & VariantProps<typeof triggerVariants>;

function TooltipTrigger({ className, variant = 'plain', ref, ...props }: TooltipTriggerProps) {
  const guard = useCallback(
    (el: HTMLElement | null) => {
      // A production build drops the check; that branch is the build's, not a behavior to test.
      /* v8 ignore next */
      if (import.meta.env.DEV) reportTooltipInNavigation(el);
      assignRef(ref, el);
    },
    [ref],
  );
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      ref={guard}
      className={cn(triggerVariants({ variant }), className)}
      {...props}
    />
  );
}

type TooltipContentProps = Omit<TooltipPrimitive.Popup.Props, 'title'> &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> &
  Pick<TooltipPrimitive.Portal.Props, 'container'> & {
    /** A caps title over the words ("Promote"). */
    title?: ReactNode;
  };

function TooltipContent({
  className,
  title,
  side = 'top',
  sideOffset = 8,
  align = 'center',
  alignOffset = 0,
  container,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        // Above every layer, sheets and viewers included: a tip belongs to whatever it points at.
        className="isolate z-[calc(var(--z-viewer)+1)]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'flex w-max max-w-[20rem] flex-col gap-(--space-1_5) px-(--space-3) py-(--space-2_5) text-left',
            'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
            // The plate names its face, as every kit popup does: portaled to `body`, it would
            // otherwise inherit the legacy `system-ui` rule there, never the kit's Saira.
            'font-(family-name:--family-sans)',
            'transition-opacity duration-(--duration-fast) ease-standard data-instant:duration-0',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          {title != null && (
            <span
              data-slot="tooltip-title"
              className="text-kick leading-none font-medium tracking-head text-fg uppercase"
            >
              {title}
            </span>
          )}
          <span
            data-slot="tooltip-body"
            className="text-assist leading-(--lead-list) font-regular tracking-normal text-fg2 normal-case"
          >
            {children}
          </span>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref != null) ref.current = value;
}

export {
  reportTooltipInNavigation,
  Tooltip,
  TooltipContent,
  type TooltipContentProps,
  TooltipProvider,
  TooltipTrigger,
  type TooltipTriggerProps,
};
