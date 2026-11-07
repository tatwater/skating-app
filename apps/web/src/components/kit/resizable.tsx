import {
  type Ref,
  type RefCallback,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Group,
  type GroupImperativeHandle,
  type GroupProps,
  type Layout,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
} from 'react-resizable-panels';

import { cn } from '@/lib/utils';

/**
 * The kit's Resizable: shadcn's `resizable` (react-resizable-panels v4) for the console shell's
 * panes — the lanes, the middle list, the inspector, the map.
 *
 * - **Sizes in px** (or any unit the library takes): a panel's `defaultSize`, `minSize`,
 *   `maxSize` and `collapsedSize` are numbers in px, or strings with a unit ("24rem", "30%").
 * - **Sizes as props.** `defaultLayout` seeds the group from a persisted layout (the shell reads
 *   it from a cookie on the server, so nothing shifts on load); `layout` holds it controlled —
 *   a change from outside is applied, and `onLayoutChanged` reports the user's (once per drag or
 *   key press; it carries the requested layout, the one worth persisting). Layouts are the
 *   library's: panel id → percent of the group. Give every panel an `id`.
 * - **Collapse**: a `collapsible` panel folds to its `collapsedSize` when dragged past its
 *   minimum, and the separator's keyboard folds and unfolds it too.
 * - **The separator is a hairline** — one pixel of `line`, the panes' own edge — brightening to
 *   `fg3` under the pointer and to the bright ink while held. Its **pointer area reaches the hit
 *   pad** past either side (`--gap-hit-x` across a column edge, `--gap-hit-y` across a row edge),
 *   and the library's own target follows the same width, so where the cursor changes is where a
 *   drag starts.
 * - **From the keyboard**: the separator is a tab stop (`role=separator` with its value); ←→
 *   (↑↓ in a column) resize in 5% steps, Home and End go to the ends, Enter folds or unfolds
 *   the pane before it when that pane is collapsible, and F6 moves to the next separator.
 *   Focus doubles the hairline in the bright ink — the input's focus mark, turned on its side.
 * - Below `lg` the shell stacks its panes instead of grouping them; that's the shell's call, not
 *   this component's.
 */

type ResizablePanelGroupProps = Omit<GroupProps, 'defaultLayout'> & {
  /** The layout to start from (a persisted one), panel id → percent. */
  defaultLayout?: Layout;
  /** A controlled layout: when it changes, the group takes it. */
  layout?: Layout;
};

/** Sub-pixel layout rounds; two layouts this close are the same layout. */
const SAME_LAYOUT = 0.01;

function sameLayout(a: Layout, b: Layout): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => b[k] !== undefined && Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < SAME_LAYOUT)
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === 'function') ref(value);
  else if (ref != null) (ref as { current: T }).current = value;
}

function ResizablePanelGroup({
  className,
  defaultLayout,
  layout,
  groupRef,
  elementRef,
  resizeTargetMinimumSize,
  orientation = 'horizontal',
  ...props
}: ResizablePanelGroupProps) {
  const handle = useRef<GroupImperativeHandle | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  const setHandle = useCallback<RefCallback<GroupImperativeHandle>>(
    (value) => {
      handle.current = value;
      assignRef(groupRef, value);
    },
    [groupRef],
  );
  const setElement = useCallback<RefCallback<HTMLDivElement>>(
    (value) => {
      element.current = value;
      assignRef(elementRef, value);
    },
    [elementRef],
  );

  // The library's drag target, in px, matched to the separator's drawn pointer area (a hairline
  // plus the hit pad on each side), so the cursor and the drag agree.
  const [target, setTarget] = useState<{ coarse: number; fine: number }>();
  useLayoutEffect(() => {
    const el = element.current;
    /* v8 ignore next */
    if (el === null) return;
    const pad = resolveLength(
      el,
      orientation === 'horizontal' ? 'var(--gap-hit-x)' : 'var(--gap-hit-y)',
    );
    const fine = 1 + 2 * pad;
    setTarget({ fine, coarse: Math.max(fine, COARSE_MIN_PX) });
  }, [orientation]);

  // Controlled: take a new `layout` when it differs from what the group shows.
  useEffect(() => {
    const group = handle.current;
    if (layout === undefined || group === null) return;
    if (!sameLayout(group.getLayout(), layout)) group.setLayout(layout);
  }, [layout]);

  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={orientation}
      defaultLayout={layout ?? defaultLayout}
      groupRef={setHandle}
      elementRef={setElement}
      resizeTargetMinimumSize={resizeTargetMinimumSize ?? target}
      className={cn('flex size-full min-h-0 min-w-0', className)}
      {...props}
    />
  );
}

/** A finger's target never shrinks below the library's coarse default. */
const COARSE_MIN_PX = 20;

/** A CSS length in px, resolved in `scope`'s theme. */
function resolveLength(scope: Element, length: string): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;width:${length};height:0`;
  scope.append(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}

/** A pane. Its content should own its scrolling (a kit `ScrollArea`). */
function ResizablePanel({ className, ...props }: PanelProps) {
  return (
    <Panel data-slot="resizable-panel" className={cn('min-h-0 min-w-0', className)} {...props} />
  );
}

/**
 * The separator: a hairline with a hit pad and a focus mark. In a row of panes it's a column
 * edge (`aria-orientation="vertical"`); in a column, a row edge.
 */
function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative z-(--z-raised) shrink-0 bg-line outline-none',
        'transition-[background-color,box-shadow] duration-(--duration-fast) ease-standard',
        'aria-[orientation=vertical]:w-px aria-[orientation=vertical]:self-stretch',
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
        // The pointer area: the hit pad past either side of the line.
        "before:absolute before:content-['']",
        'aria-[orientation=vertical]:before:inset-y-0 aria-[orientation=vertical]:before:-inset-x-(--gap-hit-x)',
        'aria-[orientation=horizontal]:before:inset-x-0 aria-[orientation=horizontal]:before:-inset-y-(--gap-hit-y)',
        'data-[separator=hover]:bg-fg3',
        'data-[separator=active]:bg-fg',
        // Focus: the line in the bright ink, doubled by a hairline on each side (a shadow, so
        // nothing moves).
        'data-[separator=focus]:bg-fg',
        'aria-[orientation=vertical]:data-[separator=focus]:shadow-[1px_0_0_0_var(--fg),-1px_0_0_0_var(--fg)]',
        'aria-[orientation=horizontal]:data-[separator=focus]:shadow-[0_1px_0_0_var(--fg),0_-1px_0_0_var(--fg)]',
        'data-[separator=disabled]:bg-line',
        className,
      )}
      {...props}
    />
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup, type ResizablePanelGroupProps };
