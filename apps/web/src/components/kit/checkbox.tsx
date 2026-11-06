import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { CheckboxGroup as CheckboxGroupPrimitive } from '@base-ui/react/checkbox-group';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faMinus } from '@fortawesome/sharp-solid-svg-icons';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Checkbox: shadcn's Base UI checkbox, re-skinned to the restore sheet's square box.
 *
 * - **Square, 1.4 kickers** (14 px on the console): sized from the surface's kicker step, so it is
 *   denser on admin with no size prop. Pressable, so it takes the control radius (square on the
 *   console, 2 px on skater).
 * - **Checked** fills with the bright ink and knocks the FontAwesome Sharp check out of it;
 *   **indeterminate** (a "restore all" parent with some children picked) does the same with a dash.
 * - **Optical spacing.** The box is the visual; the pointer area grows by the hit pad (`hit`). A
 *   `CheckboxRow` makes the label part of the target and centers the box on the label's first line.
 */
const BOX = [
  'hit inline-flex shrink-0 cursor-pointer items-center justify-center outline-none',
  'size-[calc(var(--type-kick)*1.4)] rounded-control border border-solid border-fg2 text-bg',
  'transition-[background-color,border-color] duration-(--duration-instant) ease-standard',
  'lit:not-data-checked:not-data-indeterminate:border-fg focus-visible:shadow-focus',
  'data-checked:border-fg data-checked:bg-fg data-indeterminate:border-fg data-indeterminate:bg-fg',
  'data-invalid:border-bad aria-invalid:border-bad',
  'data-disabled:cursor-default data-disabled:border-line2',
  'data-disabled:data-checked:bg-line2 data-disabled:data-indeterminate:bg-line2',
];

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn(BOX, className)} {...props}>
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex text-[calc(var(--type-kick)*0.9)] leading-none"
      >
        <FontAwesomeIcon icon={faCheck} className="h-[1em] in-data-indeterminate:hidden" />
        <FontAwesomeIcon icon={faMinus} className="hidden h-[1em] in-data-indeterminate:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

type CheckboxRowProps = CheckboxPrimitive.Root.Props & {
  /** What checking it means ("Restore all", a hidden post's title). */
  label: ReactNode;
  /** A sub-line under the label, written capitalized. */
  description?: ReactNode;
};

/**
 * A checkbox with its label: the whole row toggles it. The box centers on the label's first line,
 * so a sub-line hangs under the label, not under the box.
 */
function CheckboxRow({ label, description, className, disabled, ...props }: CheckboxRowProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's Checkbox is the control; a wrapping label is its documented pattern.
    <label
      data-slot="checkbox-row"
      data-disabled={disabled ? '' : undefined}
      className={cn(
        'group/row grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-(--space-2_5)',
        'text-body leading-[1.25] text-fg1 has-data-checked:text-fg',
        'data-disabled:cursor-default data-disabled:text-fg-disabled',
        className,
      )}
    >
      {/* One line of the label tall, so the box centers on the first line. */}
      <span data-slot="checkbox-line" className="flex h-[1.25em] items-center">
        <Checkbox disabled={disabled} {...props} />
      </span>
      <span data-slot="checkbox-label" className="flex min-w-0 flex-col gap-(--space-1)">
        {label}
        {description != null && (
          <span
            data-slot="checkbox-description"
            className="text-assist leading-(--lead-list) text-fg3 group-has-data-checked/row:text-fg2 group-data-disabled/row:text-fg-disabled"
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * Checkboxes that share one value (an array). With `allValues`, a child `Checkbox` marked `parent`
 * checks or clears them all and shows indeterminate when some are picked ("Restore all").
 */
function CheckboxGroup({ className, ...props }: CheckboxGroupPrimitive.Props) {
  return (
    <CheckboxGroupPrimitive
      data-slot="checkbox-group"
      className={cn('flex flex-col gap-heading', className)}
      {...props}
    />
  );
}

export { Checkbox, CheckboxGroup, CheckboxRow, type CheckboxRowProps };
