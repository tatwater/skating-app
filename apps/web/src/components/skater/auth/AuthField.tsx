import type { ReactNode } from 'react';
import { Field, FieldError, FieldLabel } from '../../kit/input';

/**
 * The kit's input tone on row 8's boards: a field that wants fixing is **amber, not red** ("the rule
 * is the ink on focus and amber when it needs fixing"). Nothing here failed for good; it waits on the
 * person typing. Passed to the kit `Input`'s `className`, where tailwind-merge resolves it over the
 * kit's own invalid red.
 */
export const NEED_INPUT =
  'data-invalid:border-warn aria-invalid:border-warn data-invalid:focus:shadow-[0_1px_0_0_var(--warn)] aria-invalid:focus:shadow-[0_1px_0_0_var(--warn)]';

/** The same tone for an `InputGroup`, which carries the rule for its input. */
export const NEED_GROUP =
  'has-data-invalid:border-warn has-aria-invalid:border-warn has-data-invalid:focus-within:shadow-[0_1px_0_0_var(--warn)] has-aria-invalid:focus-within:shadow-[0_1px_0_0_var(--warn)]';

/**
 * A labeled field whose message is set by the caller: the label wires to the control and the message
 * to its description through Base UI's `Field`, and `after` is whatever the message offers (a taken
 * username's alternatives).
 */
export function AuthField({
  label,
  need,
  after,
  children,
}: {
  label: string;
  /** What's wrong, in the person's terms. Absent while the field is fine. */
  need?: string | null | undefined;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field invalid={need != null}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {need != null && (
        <FieldError match role="alert" className="text-[0.8125rem] text-warn leading-[1.4]">
          {need}
        </FieldError>
      )}
      {after}
    </Field>
  );
}
