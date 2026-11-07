import { Field as FieldPrimitive } from '@base-ui/react/field';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's text input: shadcn's Input, Input Group and Field on Base UI, re-skinned to **the
 * underline — the standard input** (not a boxed field).
 *
 * - **Text over one rule.** The rule rests in `line2`, the placeholder in `fg3`; focus turns the
 *   rule to the bright ink, with no ring. The rule is the field's only boundary, and `line2` sits
 *   at about 1.7:1 on the field, so **focus also thickens it**: a second hairline under the first
 *   (a shadow, so nothing moves), giving a 2 px boundary in the bright ink — far past 3:1.
 * - **The surface's button height** (`h-btn`), so an input and a button side by side share a
 *   baseline and a bottom edge; no horizontal inset, so its text lines up with its label.
 * - **Field** wires the label (a kicker), the description and the error to the control, with
 *   Base UI's validity: an invalid field's rule and message turn red.
 * - **InputGroup** carries the rule for an input with company: a leading icon (an input that
 *   finds or takes something leads with one), a key hint that shows **only while the field has
 *   focus** (unless that key is what puts focus there), and the autosave status — typing, saving,
 *   saved, not saved — in a slot that **reserves the longest status**, so the field never shifts.
 */

/** Inside an `InputGroup`, an input drops its own rule and height: the group draws them. */
const InGroup = createContext(false);

/**
 * The rule, shared by a lone input and a group (which carries the rule for both). Each adds its
 * own hover: hover lifts a *resting* rule only, so it is gated off every state that outranks it
 * (focus, an error, a save, disabled) instead of racing them in the cascade.
 */
const RULE = [
  'border-0 border-b border-solid border-line2 rounded-none',
  'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
];

function Input({ className, ...props }: InputPrimitive.Props) {
  const grouped = useContext(InGroup);
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'w-full min-w-0 bg-transparent px-0 outline-none',
        'text-body leading-none font-regular text-fg placeholder:text-fg3',
        'data-disabled:cursor-default data-disabled:text-fg-disabled',
        !grouped && [
          'h-btn',
          ...RULE,
          '[@media(hover:hover)]:hover:not-focus:not-data-invalid:not-aria-invalid:not-data-disabled:border-fg3',
          'focus:border-fg focus:shadow-[0_1px_0_0_var(--fg)]',
          'data-invalid:border-bad data-invalid:focus:shadow-[0_1px_0_0_var(--bad)]',
          'aria-invalid:border-bad aria-invalid:focus:shadow-[0_1px_0_0_var(--bad)]',
          'data-disabled:border-line',
        ],
        className,
      )}
      {...props}
    />
  );
}

/** The autosave states, and how each reads. */
const STATUS_TEXT = {
  typing: 'Typing',
  saving: 'Saving',
  saved: 'Saved',
  failed: 'Not saved',
} as const;
type InputStatus = keyof typeof STATUS_TEXT;

type InputGroupProps = ComponentProps<'div'> & {
  /**
   * Autosave: what's happening to the value. A field that autosaves keeps it set (`saved` at
   * rest), so the slot never comes and goes.
   */
  status?: InputStatus;
};

/**
 * An input with company, on one rule: `InputGroupIcon`, the `Input`, then `InputGroupKbd` and the
 * autosave `status`. Clicking anywhere on the group focuses the input.
 */
function InputGroup({ className, status, children, onPointerDown, ...props }: InputGroupProps) {
  return (
    <div
      data-slot="input-group"
      data-status={status}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        const input = event.currentTarget.querySelector('input');
        // (A group always holds its input; `?.` only satisfies the type.)
        if (event.target === input || input?.disabled !== false) return;
        event.preventDefault(); // keep the press from blurring the input it is about to focus
        input.focus();
      }}
      className={cn(
        'group/input relative flex h-btn w-full min-w-0 cursor-text items-center gap-(--space-1_5)',
        RULE,
        '[@media(hover:hover)]:hover:not-focus-within:not-has-data-invalid:not-has-aria-invalid:not-has-data-disabled:not-data-[status=typing]:not-data-[status=saving]:not-data-[status=failed]:border-fg3',
        'focus-within:border-fg focus-within:shadow-[0_1px_0_0_var(--fg)]',
        'data-[status=typing]:border-fg2 data-[status=saving]:border-fg2',
        'data-[status=failed]:border-bad focus-within:data-[status=failed]:shadow-[0_1px_0_0_var(--bad)]',
        'has-data-invalid:border-bad has-aria-invalid:border-bad',
        'has-data-disabled:cursor-default has-data-disabled:border-line',
        className,
      )}
      {...props}
    >
      <InGroup.Provider value={true}>{children}</InGroup.Provider>
      {status !== undefined && <Status status={status} />}
    </div>
  );
}

/**
 * The status slot: every status is laid out in one grid cell, only the current one visible, so
 * the slot is always as wide as the longest — the input beside it never moves as the value saves.
 */
function Status({ status }: { status: InputStatus }): ReactNode {
  return (
    <span
      data-slot="input-status"
      className="grid shrink-0 font-(family-name:--family-mono) text-mono-sm leading-none text-fg3 group-data-[status=saved]/input:text-fg2 group-data-[status=failed]/input:text-bad"
    >
      {(Object.keys(STATUS_TEXT) as InputStatus[]).map((s) => (
        <span
          key={s}
          aria-hidden={s !== status}
          className={cn('col-start-1 row-start-1 text-right', s !== status && 'invisible')}
        >
          {STATUS_TEXT[s]}
        </span>
      ))}
      <span className="sr-only" aria-live="polite">
        {STATUS_TEXT[status]}
      </span>
    </span>
  );
}

/** The leading icon of an input that finds or takes something: the row step, in `fg2`. */
function InputGroupIcon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="input-icon"
      aria-hidden="true"
      className={cn('inline-flex shrink-0 text-row leading-none text-fg2', className)}
      {...props}
    />
  );
}

type InputGroupKbdProps = ComponentProps<typeof Kbd> & {
  /** Show it at rest too — only for the key that puts focus here ("/"). */
  always?: boolean;
};

/** A key hint inside the field (⏎). It shows only while the field has focus. */
function InputGroupKbd({
  className,
  always = false,
  variant = 'dim',
  ...props
}: InputGroupKbdProps) {
  return (
    <Kbd
      aria-hidden
      variant={variant}
      className={cn(!always && 'hidden group-focus-within/input:inline-flex', className)}
      {...props}
    />
  );
}

/** A labeled field: label, control, description and error, wired for a reader and validity. */
function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn('flex min-w-0 flex-col gap-(--space-1_5)', className)}
      {...props}
    />
  );
}

/** The field's name, as a kicker. Written capitalized; set in caps. */
function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(
        'text-kick leading-none font-medium tracking-kick text-fg3 uppercase data-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    />
  );
}

/** A line under the control that says what it's for — only when it isn't obvious. */
function FieldDescription({ className, ...props }: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn('text-assist leading-(--lead-list) text-fg3', className)}
      {...props}
    />
  );
}

/** What's wrong, in red, under the control. Shows when the field is invalid (or `match` says). */
function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn('text-assist leading-(--lead-list) text-bad', className)}
      {...props}
    />
  );
}

export {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupIcon,
  InputGroupKbd,
  type InputGroupProps,
  type InputStatus,
};
