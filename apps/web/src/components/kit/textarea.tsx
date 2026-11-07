import { Field as FieldPrimitive } from '@base-ui/react/field';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Textarea: shadcn's Textarea on Base UI's field control, re-skinned to **the boxed text
 * area** — the one place the console boxes a field (a reason, a note, a reply, a pasted block).
 * Single-line text is the underline (`Input`); more than a line is this box.
 *
 * - **A hairline box in `line2`**, square (a field is a container), on the page ground, the
 *   placeholder in `fg3`. Hover (on a device that hovers) lifts the edge to `fg3`.
 * - **Focus brightens the edge one step, to `fg2`** — never the bright ink, and no ring or glow:
 *   the box is already a boundary, and a white edge reads as a selected cell. `fg2` clears 3:1 on
 *   the ground in every theme, so the focused box still passes as a boundary.
 * - **Invalid edges in red** (Base UI's validity inside a kit `Field`, or `aria-invalid`), and stays
 *   red under focus — the error outranks the focus look. Disabled fades its text and edge.
 * - **Row type, body leading**, inset `space-2_5` × `space-2` (rem, so it breathes with the user's
 *   font size — D233). It starts four rem tall and the person can drag it taller; it never grows
 *   sideways.
 * - Inside a kit `Field` it is the field's control: `FieldLabel`, `FieldDescription` and
 *   `FieldError` wire to it, and native validity (`required`, `maxLength`) flows through.
 * - **`variant="underline"`** is the standard input's register for writing that *is* the page —
 *   the report sheet's story: text over one `line2` rule, no inset, focus turning the rule to the
 *   bright ink and doubling it (a shadow, so nothing moves), exactly as `Input` does.
 */
type TextareaProps = Omit<FieldPrimitive.Control.Props, 'render'> &
  Pick<ComponentProps<'textarea'>, 'rows' | 'cols' | 'wrap'> & {
    variant?: 'box' | 'underline';
  };

function Textarea({ className, rows, cols, wrap, variant = 'box', ...props }: TextareaProps) {
  const underline = variant === 'underline';
  return (
    <FieldPrimitive.Control
      data-slot="textarea"
      data-variant={variant}
      render={<textarea rows={rows} cols={cols} wrap={wrap} />}
      className={cn(
        'block w-full resize-y rounded-none border-solid font-(family-name:--family-sans) text-row leading-body font-regular text-fg',
        'shadow-none outline-none placeholder:text-fg3',
        underline
          ? [
              'min-h-[3rem] border-0 border-b border-line2 bg-transparent px-0 py-(--space-1_5)',
              'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
              '[@media(hover:hover)]:hover:not-focus:border-fg3 focus:border-fg focus:shadow-[0_1px_0_0_var(--fg)]',
            ]
          : [
              'min-h-[4rem] border border-line2 bg-bg px-(--space-2_5) py-(--space-2)',
              'transition-[border-color] duration-(--duration-fast) ease-standard',
              '[@media(hover:hover)]:hover:border-fg3 focus:border-fg2 focus:hover:border-fg2',
            ],
        'data-invalid:border-bad data-invalid:hover:border-bad',
        'aria-invalid:border-bad aria-invalid:hover:border-bad',
        'data-disabled:cursor-default data-disabled:border-line data-disabled:hover:border-line',
        'data-disabled:text-fg-disabled',
        'data-disabled:placeholder:text-fg-disabled',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea, type TextareaProps };
