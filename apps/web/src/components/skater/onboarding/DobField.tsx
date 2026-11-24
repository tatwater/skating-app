import {
  DATE_OF_BIRTH_MESSAGES,
  type DateOfBirthFields,
  DOB_MONTHS,
  ONBOARDING_COPY,
} from '@skating/core';
import { useId } from 'react';

import { cn } from '@/lib/utils';

import { Input } from '../../kit/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { NEED_INPUT } from '../auth/AuthField';

/** What the field says under itself: core's problem, as the boards draw it. */
export type DobNeed = 'invalid' | 'underage' | null;

const MONTH_ITEMS = DOB_MONTHS.map((label, i) => ({ value: i + 1, label }));

/** A Select trigger that needs fixing is amber like the inputs beside it, never the kit's red. */
const NEED_TRIGGER = 'aria-invalid:border-warn data-invalid:border-warn';

/**
 * **The date of birth, three ways at once** (boards 10.1, 10.2; D298): the month picked by name, the
 * day and the year typed as numbers. One label names the group; each part carries its own name
 * (*Month*, *Day*, *Year*). Under it, the hint ("Gli is for skaters 18 and older…") until there is
 * something to fix, then the amber line — and on the under-18 board every part's rule turns amber.
 *
 * `ph-no-capture` on the group **and on the month's list**, which portals out of it: autocapture
 * records a clicked element's text, and a birth month is the one thing here it must never carry.
 */
export function DobField({
  value,
  onChange,
  need,
}: {
  value: DateOfBirthFields;
  onChange: (next: DateOfBirthFields) => void;
  need: DobNeed;
}) {
  const id = useId();
  const copy = ONBOARDING_COPY.account;
  const invalid = need !== null;
  return (
    <fieldset
      aria-describedby={`${id}-note`}
      data-slot="dob-field"
      className="ph-no-capture m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
    >
      <legend className="mb-2 p-0 font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
        {copy.dateOfBirth}
      </legend>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <Select
            items={MONTH_ITEMS}
            value={value.month}
            onValueChange={(month) => onChange({ ...value, month: month as number | null })}
          >
            <SelectTrigger
              aria-label={copy.month}
              aria-invalid={invalid || undefined}
              className={cn('text-row', NEED_TRIGGER)}
            >
              <SelectValue placeholder={copy.month} />
            </SelectTrigger>
            <SelectContent className="ph-no-capture max-h-[min(var(--available-height),18rem)]">
              {MONTH_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          aria-label={copy.day}
          aria-invalid={invalid || undefined}
          name="bday-day"
          autoComplete="bday-day"
          inputMode="numeric"
          maxLength={2}
          value={value.day}
          onValueChange={(day) => onChange({ ...value, day })}
          className={cn(
            'w-16 flex-none font-(family-name:--family-mono) font-medium text-row',
            NEED_INPUT,
          )}
        />
        <Input
          aria-label={copy.year}
          aria-invalid={invalid || undefined}
          name="bday-year"
          autoComplete="bday-year"
          inputMode="numeric"
          maxLength={4}
          value={value.year}
          onValueChange={(year) => onChange({ ...value, year })}
          className={cn(
            'w-[5.5rem] flex-none font-(family-name:--family-mono) font-medium text-row',
            NEED_INPUT,
          )}
        />
      </div>
      {need !== null ? (
        <span
          id={`${id}-note`}
          role="alert"
          data-slot="dob-need"
          className="text-[0.8125rem] text-warn leading-[1.4]"
        >
          {DATE_OF_BIRTH_MESSAGES[need]}
        </span>
      ) : (
        <span id={`${id}-note`} className="text-[0.78125rem] text-fg3 leading-[1.4]">
          {copy.dateOfBirthHint}
        </span>
      )}
    </fieldset>
  );
}
