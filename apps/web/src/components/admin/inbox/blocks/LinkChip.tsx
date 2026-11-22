import { type ComponentProps, cloneElement, type ReactElement } from 'react';

import { buttonVariants } from '@/components/kit/button';
import { cn } from '@/lib/utils';

/**
 * **A console link in the kit's link face** — *Open in Body →* and every handler's link like it: the
 * router's own `<Link>` (built where the handler knows the route's place), drawn as the kit's link
 * chip, its arrow after the label. One helper for every Inbox handler.
 */
export function LinkChip({
  link,
  label,
  slot,
  newTab = false,
}: {
  link: ReactElement;
  label: string;
  slot: string;
  newTab?: boolean;
}) {
  return cloneElement(
    link as ReactElement<ComponentProps<'a'>>,
    {
      'data-slot': slot,
      className: cn(buttonVariants({ variant: 'link', size: 'xs' }), 'no-underline'),
      ...(newTab ? { target: '_blank', rel: 'noopener' } : {}),
      children: (
        <span data-slot="label" className="inline-flex items-center gap-[inherit]">
          {label}
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        </span>
      ),
    } as ComponentProps<'a'>,
  );
}
