import { NumberField as NumberFieldPrimitive } from '@base-ui/react/number-field';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAngleDown, faAngleUp, faArrowsLeftRight } from '@fortawesome/sharp-regular-svg-icons';
import { type ReactNode, useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's NumberField: Base UI's Number Field (shadcn doesn't wrap it), in the register of the
 * ledger's and the Rates sheet's number entry and the thresholds sheet's draft column.
 *
 * - **The underline, like `Input`**: the value over one rule, `line2` at rest, the bright ink and a
 *   doubled rule on focus, red when invalid. The surface's button height (`h-btn`), so a number
 *   field beside a button shares its bottom edge.
 * - **The input holds only its number.** The value is mono with tabular figures; a currency sign
 *   sits inside the rule before it (`prefix`, or `currency`), quiet; the **unit hangs outside**
 *   the rule in its own slot (`unit`, e.g. "$/mo"), so a column of fields reads straight down.
 *   Pass `unitSlot` to give every row's unit the same width.
 * - **Changed vs saved**: with `saved`, a value that differs from it lights — the rule and the
 *   value turn to the bright ink — so a draft row reads as changed (the table shows the saved
 *   value beside only those rows).
 * - **The keyboard is Base UI's**: ↑↓ step, ⇧ for a large step, ⌥ for a small one, Home and End
 *   go to `min` and `max`. Formatting follows `format`, `decimals` or `currency`, and settles on
 *   blur.
 * - **Steppers and scrubbing are off by default** (the boards draw neither). `steppers` adds a
 *   joined pair of square buttons with kicker-sized angles after the unit; `scrub` makes the
 *   label a handle you drag sideways to change the value.
 */

type NumberFieldProps = Omit<NumberFieldPrimitive.Root.Props, 'render' | 'children'> & {
  /** The kicker over the field; its accessible name. Without one, pass `aria-label`. */
  label?: ReactNode;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  placeholder?: string;
  /** A sign inside the rule before the number ("$"). `currency` sets it for you. */
  prefix?: ReactNode;
  /** The unit, outside the rule after the number ("$/mo", "cm", "per day"). */
  unit?: ReactNode;
  /** A fixed width for the unit slot (a CSS length), so units line up down a column. */
  unitSlot?: string;
  /** An ISO currency ("USD"): the sign as `prefix`, and the currency's decimals unless set. */
  currency?: string;
  /** Show exactly this many decimals (settles on blur). */
  decimals?: number;
  /** The value on record: a different value reads as changed. */
  saved?: number | null;
  /** Where the number sits in its rule: `start` in a form, `end` in a table column. */
  align?: 'start' | 'end';
  /** A joined pair of stepper buttons after the unit. Off by default. */
  steppers?: boolean;
  /** Drag the label sideways to change the value. Needs a `label`. Off by default. */
  scrub?: boolean;
  /** The input's own classes (its width, in a table). */
  inputClassName?: string;
};

/** The rule's states: mirrors `Input`'s rule, carried here by the group around prefix + input. */
const RULE = [
  'border-0 border-b border-solid border-line2 rounded-none',
  'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
  // Hover lifts a resting rule only: gated off every state below, never racing them.
  '[@media(hover:hover)]:hover:not-focus-within:not-group-data-changed/number:not-group-data-invalid/number:not-has-aria-invalid:not-group-data-readonly/number:not-group-data-disabled/number:border-fg3',
  'focus-within:border-fg focus-within:shadow-[0_1px_0_0_var(--fg)]',
  'group-data-changed/number:border-fg',
  'group-data-invalid/number:border-bad group-data-invalid/number:focus-within:shadow-[0_1px_0_0_var(--bad)]',
  'has-aria-invalid:border-bad has-aria-invalid:focus-within:shadow-[0_1px_0_0_var(--bad)]',
  'group-data-readonly/number:border-dotted group-data-readonly/number:border-line2 group-data-readonly/number:shadow-none',
  'group-data-disabled/number:border-line',
];

const LABEL =
  'text-kick leading-none font-medium tracking-kick text-fg3 uppercase group-data-disabled/number:text-fg-disabled';

/** A currency's narrow sign and its usual decimals, in the field's locale. */
function currencyParts(currency: string, locale: Intl.LocalesArgument) {
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  });
  // A currency format always has its sign and its decimals; the fallbacks are for the types.
  /* v8 ignore next 2 */
  const sign = fmt.formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
  return { sign, decimals: fmt.resolvedOptions().minimumFractionDigits ?? 2 };
}

function NumberField({
  className,
  label,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  placeholder,
  prefix,
  unit,
  unitSlot,
  currency,
  decimals,
  saved,
  align = 'start',
  steppers = false,
  scrub = false,
  inputClassName,
  format,
  locale,
  id: idProp,
  ...props
}: NumberFieldProps) {
  const ownId = useId();
  const id = idProp ?? ownId;
  const money = currency === undefined ? undefined : currencyParts(currency, locale);
  const places = decimals ?? money?.decimals;
  const shown: Intl.NumberFormatOptions | undefined =
    format ??
    (places === undefined
      ? undefined
      : { minimumFractionDigits: places, maximumFractionDigits: places });
  const sign = prefix ?? money?.sign;

  const labelEl =
    label === undefined ? null : (
      <label htmlFor={id} data-slot="number-field-label" className={LABEL}>
        {label}
      </label>
    );

  return (
    <NumberFieldPrimitive.Root
      // Our own id only when our own label points at it; inside a kit `Field`, the field's
      // label wires itself to the input.
      id={label === undefined ? idProp : id}
      format={shown}
      locale={locale}
      {...props}
      render={(rootProps, state) => (
        <div
          {...rootProps}
          data-slot="number-field"
          data-changed={
            saved !== undefined && state.value !== saved && state.value !== null ? '' : undefined
          }
          className={cn('group/number flex min-w-0 flex-col gap-(--space-1_5)', className)}
        />
      )}
    >
      {labelEl !== null &&
        (scrub ? (
          <NumberFieldPrimitive.ScrubArea
            data-slot="number-field-scrub"
            className="w-fit cursor-ew-resize select-none group-data-disabled/number:cursor-default [&_label]:cursor-[inherit]"
          >
            {labelEl}
            <NumberFieldPrimitive.ScrubAreaCursor className="text-fg drop-shadow-[0_0_2px_var(--bg)]">
              <FontAwesomeIcon icon={faArrowsLeftRight} className="h-(--type-row)" />
            </NumberFieldPrimitive.ScrubAreaCursor>
          </NumberFieldPrimitive.ScrubArea>
        ) : (
          labelEl
        ))}
      <div data-slot="number-field-row" className="flex min-w-0 items-center">
        <NumberFieldPrimitive.Group
          data-slot="number-field-group"
          className={cn('flex h-btn min-w-0 flex-1 cursor-text items-center gap-(--space-1)', RULE)}
        >
          {sign !== undefined && (
            <span
              data-slot="number-field-prefix"
              aria-hidden="true"
              className="shrink-0 font-(family-name:--family-mono) text-row leading-none text-fg3 group-data-disabled/number:text-fg-disabled"
            >
              {sign}
            </span>
          )}
          <NumberFieldPrimitive.Input
            data-slot="number-field-input"
            aria-label={ariaLabel}
            aria-invalid={ariaInvalid}
            placeholder={placeholder}
            className={cn(
              'h-full w-full min-w-0 bg-transparent px-0 outline-none',
              'font-(family-name:--family-mono) text-row leading-none font-regular text-fg1 tabular-nums placeholder:text-fg3',
              'group-data-changed/number:text-fg focus:text-fg',
              'data-disabled:cursor-default data-disabled:text-fg-disabled',
              align === 'end' && 'text-right',
              inputClassName,
            )}
          />
        </NumberFieldPrimitive.Group>
        {unit !== undefined && (
          <span
            data-slot="number-field-unit"
            style={unitSlot === undefined ? undefined : { width: unitSlot }}
            // 7 px off the value, as every value + unit pair sits (no 7 px token: 0.6em of
            // the unit's own step, so it scales with it).
            className="shrink-0 pl-[0.6em] text-assist leading-none whitespace-nowrap text-fg3 group-data-disabled/number:text-fg-disabled"
          >
            {unit}
          </span>
        )}
        {steppers && (
          <span data-slot="number-field-steppers" className="ml-(--space-2) flex shrink-0">
            <NumberFieldPrimitive.Decrement data-slot="number-field-decrement" className={STEP}>
              <FontAwesomeIcon icon={faAngleDown} className="h-(--type-kick)" />
            </NumberFieldPrimitive.Decrement>
            <NumberFieldPrimitive.Increment
              data-slot="number-field-increment"
              className={cn(STEP, '-ml-px')}
            >
              <FontAwesomeIcon icon={faAngleUp} className="h-(--type-kick)" />
            </NumberFieldPrimitive.Increment>
          </span>
        )}
      </div>
    </NumberFieldPrimitive.Root>
  );
}

/**
 * A stepper: a square of the surface's small button height, rimmed like an outlined action,
 * lighting to the raised face on hover. Not in the tab order (the arrow keys step).
 */
const STEP = cn(
  'relative inline-flex size-btn-sm cursor-pointer items-center justify-center rounded-control outline-none select-none',
  'border border-solid border-line2 text-fg2',
  'transition-[background-color,color,border-color] duration-(--duration-fast) ease-standard',
  'lit:z-1 lit:border-fg3 lit:bg-raise lit:text-fg',
  'pressed:bg-lift-12 pressed:duration-(--duration-instant)',
  'data-disabled:cursor-default data-disabled:border-line data-disabled:text-fg-disabled',
);

export { NumberField, type NumberFieldProps };
