import { Toolbar as ToolbarPrimitive } from '@base-ui/react/toolbar';
import { type ComponentProps, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

/**
 * The kit's Toolbar: Base UI's Toolbar (shadcn doesn't wrap it), re-skinned to the console's
 * **action bar** (`.actbar`).
 *
 * - **A solid plate**: `plate-solid` ground, one `line` edge all round, the action-bar shadow,
 *   square. `floating` locks it to its pane's foot — `space-2` clear of the bottom and both sides,
 *   tight to its buttons, centered — over the pane's scroller (give that scroller room at its end).
 * - **Every button rests alike**: `ToolbarButton` is a kit `Button`, outlined by default; none
 *   reads as primary until it's focused or armed (the corner-dot look comes from the button).
 *   `full` is the one-action bar: it spans the pane and its one button fills it, still outlined.
 * - **Groups and hairlines**: `ToolbarGroup` holds related actions (a kicker may lead it,
 *   `ToolbarLabel`); `ToolbarSeparator` is a `line` hairline between groups. Buttons sit `space-2`
 *   apart, a group's members `space-2_5`, and a hairline `space-1` further out on each side.
 * - **One tab stop, arrow keys inside** (roving focus): ←→ move between every control in the
 *   bar — buttons, a kit `ToggleGroup`'s options, a `ToolbarItem` (a Select or menu trigger);
 *   Home and End go to the ends. A disabled button stays focusable, so the arrows don't skip it.
 * - **Overflow**: `ToolbarOverflow` takes a list of actions and shows as many as fit, folding the
 *   rest into a "More" menu at the end when the bar runs out of room. It measures, so nothing
 *   jumps as the pane is resized.
 * - **No explaining line and no reason input in a bar**: what a button does is its tooltip, and a
 *   reason is asked in the dialog that taking something away opens.
 */

type ToolbarProps = Omit<ToolbarPrimitive.Root.Props, 'orientation'> & {
  /** Lock the bar to its (positioned) pane's foot, centered, `space-2` clear of the edges. */
  floating?: boolean;
  /** One action: the bar spans its pane and the action fills it. */
  full?: boolean;
};

function Toolbar({ className, floating = false, full = false, onKeyDown, ...props }: ToolbarProps) {
  return (
    <ToolbarPrimitive.Root
      data-slot="toolbar"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || (event.key !== 'Home' && event.key !== 'End')) return;
        // A text field keeps Home and End for its caret.
        if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]'))
          return;
        // Base UI's toolbar roves with the arrows only; Home and End go to its ends here.
        const bar = event.currentTarget;
        const items = [...bar.querySelectorAll<HTMLElement>('[tabindex]')].filter(
          (el) => el.closest('[role="toolbar"]') === bar && !el.closest('[inert]'),
        );
        const target = event.key === 'Home' ? items[0] : items.at(-1);
        // (A bar always holds a control; the guard is for the type.)
        /* v8 ignore next */
        if (target === undefined) return;
        event.preventDefault();
        target.focus();
      }}
      data-floating={floating ? '' : undefined}
      data-full={full ? '' : undefined}
      className={cn(
        'flex max-w-full min-w-0 items-center gap-(--space-2)',
        'rounded-container border border-solid border-line bg-plate-solid shadow-actbar',
        'px-(--space-2_5) py-(--space-2)',
        full ? 'w-full [&>*]:flex-1' : 'w-fit',
        floating && [
          'absolute inset-x-(--space-2) bottom-(--space-2) z-(--z-actbar)',
          'max-w-[calc(100%-2*var(--space-2))]',
          full ? 'w-auto' : 'mx-auto',
        ],
        className,
      )}
      {...props}
    />
  );
}

function ToolbarGroup({ className, ...props }: ToolbarPrimitive.Group.Props) {
  return (
    <ToolbarPrimitive.Group
      data-slot="toolbar-group"
      className={cn('flex min-w-0 items-center gap-(--space-2_5)', className)}
      {...props}
    />
  );
}

/** A group's kicker ("Suspend", "Season"), before its controls. Not focusable. */
function ToolbarLabel({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="toolbar-label"
      className={cn(
        'shrink-0 text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

/** The hairline between groups: `line`, a little shorter than a button, `space-1` out each side. */
function ToolbarSeparator({ className, ...props }: ToolbarPrimitive.Separator.Props) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={cn('mx-(--space-1) h-(--space-5) w-px shrink-0 bg-line', className)}
      {...props}
    />
  );
}

type ToolbarButtonProps = ButtonProps;

/** A kit `Button` that takes part in the bar's arrow keys. Outlined, like every bar button. */
function ToolbarButton({
  variant = 'outline',
  size = 'default',
  armed,
  loading,
  external,
  className,
  ...props
}: ToolbarButtonProps) {
  return (
    <ToolbarPrimitive.Button
      render={
        <Button
          variant={variant}
          size={size}
          armed={armed}
          loading={loading}
          external={external}
          className={className}
        />
      }
      {...props}
    />
  );
}

/**
 * Any other control in the bar's arrow keys: pass the control as `render` — a kit
 * `SelectTrigger`, or a `DropdownMenuTrigger` rendering a `Button`.
 */
function ToolbarItem(props: ToolbarPrimitive.Button.Props) {
  return <ToolbarPrimitive.Button data-slot="toolbar-item" {...props} />;
}

type ToolbarAction = {
  /** Stable across renders: the overflow keeps its place by it. */
  id: string;
  label: string;
  onClick?: () => void;
  /** The key that does it ("P"); shown in the menu once it has folded. */
  kbd?: string;
  /** Destructive: outlined at rest, red only when highlighted in the menu or armed. */
  danger?: boolean;
  disabled?: boolean;
};

type ToolbarOverflowProps = {
  actions: readonly ToolbarAction[];
  /** The menu button's label. */
  moreLabel?: string;
  className?: string;
};

/**
 * As many of `actions` as fit, in order; the rest fold into a "More" menu at the end. The widths
 * come from a hidden copy of every button (and of "More"), so what shows is decided before paint
 * and never oscillates: the group keeps the natural width of all its actions, and shrinks only
 * when the bar is out of room.
 */
function ToolbarOverflow({ actions, moreLabel = 'More', className }: ToolbarOverflowProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(actions.length);
  const [natural, setNatural] = useState<number>();
  const shape = actions.map((a) => `${a.id}:${a.label}:${a.kbd ?? ''}`).join('|');

  const compute = useCallback(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    // Both are always rendered; the guard is for the type.
    /* v8 ignore next */
    if (box === null || measure === null) return;
    const widths = [...measure.children].map((c) => c.getBoundingClientRect().width);
    const more = widths.pop() ?? 0;
    const gap = parseFloat(getComputedStyle(measure).columnGap) || 0;
    const span = (n: number) =>
      widths.slice(0, n).reduce((a, b) => a + b, 0) + gap * Math.max(0, n - 1);
    const all = span(widths.length);
    setNatural(all);
    const room = box.getBoundingClientRect().width + 0.5; // sub-pixel layout rounds
    if (all <= room) {
      setFit(widths.length);
      return;
    }
    let n = widths.length - 1;
    while (n > 0 && span(n) + gap + more > room) n--;
    setFit(n);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the actions change
  useLayoutEffect(() => {
    compute();
    const box = boxRef.current;
    const measure = measureRef.current;
    /* v8 ignore next */
    if (box === null || measure === null) return;
    const observer = new ResizeObserver(compute);
    observer.observe(box);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [compute, shape]);

  const shown = actions.slice(0, fit);
  const folded = actions.slice(fit);
  return (
    <div
      ref={boxRef}
      data-slot="toolbar-overflow"
      data-folded={folded.length > 0 ? folded.length : undefined}
      style={natural === undefined ? undefined : { width: natural }}
      className={cn('relative flex min-w-0 shrink items-center gap-(--space-2)', className)}
    >
      {shown.map((a) => (
        <ToolbarButton key={a.id} variant={a.danger ? 'danger' : 'outline'} {...buttonProps(a)}>
          {a.label}
        </ToolbarButton>
      ))}
      {folded.length > 0 && (
        <DropdownMenu>
          <ToolbarItem
            render={<DropdownMenuTrigger render={<Button />} />}
            aria-label={`${moreLabel} actions`}
          >
            {moreLabel}
            <DropdownMenuCaret />
          </ToolbarItem>
          {/* The bar sits at the pane's foot: the menu opens upward, on its right edge. */}
          <DropdownMenuContent side="top" align="end">
            {folded.map((a) => (
              <DropdownMenuItem
                key={a.id}
                kbd={a.kbd}
                aria-keyshortcuts={a.kbd}
                variant={a.danger ? 'danger' : 'default'}
                disabled={a.disabled}
                onClick={a.onClick}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* The measuring copy: every action, then "More". Clipped to the group, never seen. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-0 overflow-hidden"
      >
        <div ref={measureRef} inert className="flex w-max items-center gap-(--space-2)">
          {actions.map((a) => (
            <Button key={a.id} tabIndex={-1}>
              {a.label}
            </Button>
          ))}
          <Button tabIndex={-1}>
            {moreLabel}
            <DropdownMenuCaret />
          </Button>
        </div>
      </div>
    </div>
  );
}

function buttonProps(a: ToolbarAction): Partial<ButtonProps> {
  return { onClick: a.onClick, disabled: a.disabled, 'aria-keyshortcuts': a.kbd };
}

export {
  Toolbar,
  type ToolbarAction,
  ToolbarButton,
  type ToolbarButtonProps,
  ToolbarGroup,
  ToolbarItem,
  ToolbarLabel,
  ToolbarOverflow,
  type ToolbarOverflowProps,
  type ToolbarProps,
  ToolbarSeparator,
};
