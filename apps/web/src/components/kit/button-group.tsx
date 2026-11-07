import { cva } from 'class-variance-authority';
import { type ComponentProps, type KeyboardEvent, useLayoutEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's ButtonGroup: shadcn's Button Group, re-skinned to the boards' **joined buttons** — kit
 * `Button`s that share one edge and read as one control.
 *
 * - **One shared hairline.** Each member after the first pulls back by a hair (`stroke-hair`), so
 *   two outlines meet as one 1 px edge: a split button ("Copy log" and its caret), a cron's
 *   buttons, the map's zoom pair (vertical), the imagery pager.
 * - **Square where they meet.** Inner corners are square on every surface; the outer corners take
 *   the surface's control radius, as a joined `ToggleGroup` does — square on the console.
 * - **The lit member rises** over its neighbors, so its filled face and focus ring are never cut
 *   by the next member's edge; an open menu's trigger stays risen while its menu is up.
 * - **Members are ordinary kit Buttons** (or a `DropdownMenuTrigger` rendering one) and keep their
 *   own variants, sizes, keys and tooltips; the group adds no look of its own.
 * - **One tab stop, arrow keys inside** (roving focus): ←→ (↑↓ when vertical) move between the
 *   members and wrap, Home and End go to the ends; Tab leaves the group. A disabled member is
 *   skipped unless it stays focusable. Inside a kit `Toolbar` the bar roves instead — render each
 *   member as a `ToolbarButton` there and the group only joins them.
 * - It is a `group` to a reader: give it a label that names what the buttons act on.
 */
const groupVariants = cva(
  [
    'isolate inline-flex w-fit',
    '*:rounded-none *:hover:z-1 *:focus-visible:z-1 *:data-popup-open:z-1',
  ],
  {
    variants: {
      orientation: {
        horizontal: [
          'flex-row items-stretch *:not-first:-ml-(--stroke-hair)',
          '*:first:rounded-l-control *:last:rounded-r-control',
        ],
        vertical: [
          'flex-col items-stretch *:not-first:-mt-(--stroke-hair)',
          '*:first:rounded-t-control *:last:rounded-b-control',
        ],
      },
    },
    defaultVariants: { orientation: 'horizontal' },
  },
);

type Orientation = 'horizontal' | 'vertical';

type ButtonGroupProps = ComponentProps<'div'> & {
  /** Side by side (the default), or stacked — the map's zoom pair. */
  orientation?: Orientation;
};

/** What roving focus moves between: the group's own focusable members. */
const MEMBER = 'button, a[href], [role="button"]';

/** Every member, focusable now or not. */
function allMembers(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(MEMBER)].filter(
    (el) => el.closest('[data-slot="button-group"]') === group,
  );
}

/** The members focus can move to: a natively disabled button can't take it. */
function members(group: HTMLElement): HTMLElement[] {
  return allMembers(group).filter((el) => !(el instanceof HTMLButtonElement && el.disabled));
}

/** The keys that move focus, per orientation: one step back, one step on. */
const STEP_KEYS: Record<Orientation, { back: string; on: string }> = {
  horizontal: { back: 'ArrowLeft', on: 'ArrowRight' },
  vertical: { back: 'ArrowUp', on: 'ArrowDown' },
};

function ButtonGroup({
  className,
  orientation = 'horizontal',
  ref,
  onFocus,
  onKeyDown,
  ...props
}: ButtonGroupProps) {
  const own = useRef<HTMLDivElement | null>(null);
  const active = useRef<HTMLElement | null>(null);

  // The one member that takes Tab: the last one focused, else the first that can be.
  const sync = () => {
    const group = own.current;
    // (A mounted group always has its node; the guard is for the type.)
    /* v8 ignore next */
    if (group === null) return;
    if (group.closest('[role="toolbar"]') !== null) return;
    const list = members(group);
    const current =
      active.current !== null && list.includes(active.current) ? active.current : list[0];
    for (const el of allMembers(group)) el.tabIndex = el === current ? 0 : -1;
  };

  // Every render: a member may have come, gone or been disabled since.
  useLayoutEffect(sync);

  const setRef = (el: HTMLDivElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref != null) ref.current = el;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form fields; this groups actions, as shadcn's Button Group does
    <div
      ref={setRef}
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(groupVariants({ orientation }), className)}
      onFocus={(event) => {
        onFocus?.(event);
        const target = event.target as HTMLElement;
        if (!members(event.currentTarget).includes(target)) return;
        active.current = target;
        sync();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        const group = event.currentTarget;
        if (event.defaultPrevented || group.closest('[role="toolbar"]') !== null) return;
        const list = members(group);
        const at = list.indexOf(event.target as HTMLElement);
        if (at === -1) return;
        const { back, on } = STEP_KEYS[orientation];
        const next =
          event.key === on
            ? list[(at + 1) % list.length]
            : event.key === back
              ? list[(at - 1 + list.length) % list.length]
              : event.key === 'Home'
                ? list[0]
                : event.key === 'End'
                  ? list.at(-1)
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        next.focus();
      }}
      {...props}
    />
  );
}

export { ButtonGroup, type ButtonGroupProps };
