import type { LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers always pass htmlFor tying it to an input.
    <label className={cn('text-sm font-medium text-foreground', className)} {...props} />
  );
}
