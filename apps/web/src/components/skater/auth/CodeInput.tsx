import { OTPField } from '@base-ui/react/otp-field';
import type { Ref } from 'react';

/** Clerk's email codes are six digits. */
export const CODE_LENGTH = 6;

const SLOTS = Array.from({ length: CODE_LENGTH }, (_, i) => i);

/**
 * The six-digit code: six underlined slots on Base UI's OTP field, the slot being typed into lit.
 * One tab stop however many slots (the field roves), paste and the phone's autofill fill all six,
 * and it gets its name and its error from the surrounding `Field`. A kit candidate — Settings' change
 * of email (7.3) wants the same control.
 */
export function CodeInput({
  value,
  onValueChange,
  disabled = false,
  rootRef,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  rootRef?: Ref<HTMLDivElement>;
}) {
  return (
    <OTPField.Root
      ref={rootRef}
      length={CODE_LENGTH}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      disabled={disabled}
      data-slot="code-input"
      className="flex gap-[0.625rem]"
    >
      {SLOTS.map((slot) => (
        <OTPField.Input
          key={slot}
          // The first slot takes its name from the field's label; Base UI refuses one here.
          aria-label={slot === 0 ? undefined : `Digit ${slot + 1} of ${CODE_LENGTH}`}
          className="h-[3.375rem] w-full min-w-0 rounded-none border-0 border-line2 border-b border-solid bg-transparent text-center font-(family-name:--family-mono) font-medium text-disp text-fg leading-none outline-none transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard focus:border-fg focus:shadow-[0_1px_0_0_var(--fg)] data-disabled:text-fg-disabled data-invalid:border-warn aria-invalid:border-warn data-invalid:focus:shadow-[0_1px_0_0_var(--warn)] aria-invalid:focus:shadow-[0_1px_0_0_var(--warn)]"
        />
      ))}
    </OTPField.Root>
  );
}
