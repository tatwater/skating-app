import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAngleRight } from '@fortawesome/sharp-regular-svg-icons';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Collapsible: shadcn's Base UI collapsible, re-skinned to the boards' **groups an admin
 * opens or closes** (a Body's Hazards groups — "Archived this winter", "Known features").
 *
 * - **The head is a ruled row**: a `line` rule over it, the chevron, the group's name in caps
 *   (medium, head tracking, `fg2`), and its count at the right in mono `fg3`. The whole row is the
 *   control. Hover and keyboard focus light the name to `fg1`; focus adds the ring.
 * - **The chevron says which** (FontAwesome Sharp Regular's angle): it points right while the group
 *   is closed and turns down when it opens — the same shape, turned, on `duration-fast`.
 * - **The reveal** grows the panel from nothing to its measured height on `duration-base` with the
 *   standard easing, and shrinks it back on close. Under reduced motion every motion token is zero,
 *   so it opens and closes at once.
 * - **A closed group reserves nothing**: the panel leaves the page once it has shrunk, so the next
 *   group's head sits right under this one. Pass `hiddenUntilFound` to keep a closed panel in the
 *   page for the browser's find-in-page (it still takes no room).
 */
function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

/** The chevron: right while closed, down while open. For a trigger drawn some other way. */
function CollapsibleChevron({ className }: { className?: string }) {
  return (
    <span
      data-slot="collapsible-chevron"
      aria-hidden="true"
      className={cn(
        'inline-flex w-(--type-kick) shrink-0 justify-center',
        'transition-[rotate] duration-(--duration-fast) ease-standard',
        'group-data-panel-open/collapsible:rotate-90',
        className,
      )}
    >
      <FontAwesomeIcon icon={faAngleRight} className="h-(--type-kick)" />
    </span>
  );
}

type CollapsibleTriggerProps = CollapsiblePrimitive.Trigger.Props & {
  /** How many the group holds, at the right of its head ("4"). */
  count?: ReactNode;
};

/** The group's head: rule, chevron, name, count. The whole row opens and closes the group. */
function CollapsibleTrigger({ className, count, children, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        'group/collapsible flex w-full cursor-pointer items-center gap-(--space-2) text-left outline-none',
        'border-0 border-t border-solid border-line bg-transparent px-0 py-(--space-2)',
        'text-kick leading-none font-medium tracking-head text-fg2 uppercase',
        'transition-[color,box-shadow] duration-(--duration-fast) ease-standard',
        'lit:text-fg1 focus-visible:shadow-focus',
        'data-disabled:cursor-default data-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    >
      <CollapsibleChevron />
      <span data-slot="collapsible-label" className="min-w-0 truncate">
        {children}
      </span>
      {count !== undefined && (
        <span
          data-slot="collapsible-count"
          className="ml-auto font-(family-name:--family-mono) text-mono-sm leading-none font-medium tracking-normal text-fg3 normal-case"
        >
          {count}
        </span>
      )}
    </CollapsiblePrimitive.Trigger>
  );
}

/** What the group holds. Grows open on the motion tokens; gone from the page while closed. */
function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(
        'h-(--collapsible-panel-height) overflow-hidden',
        'transition-[height] duration-(--duration-base) ease-standard',
        'data-starting-style:h-0 data-ending-style:h-0',
        className,
      )}
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
};
