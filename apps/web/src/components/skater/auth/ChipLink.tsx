import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-regular-svg-icons';
import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { buttonVariants } from '../../kit/button';

/**
 * The kit's `link` chip, as a real link. The kit `Button` rendered as an `<a>` keeps Base UI's
 * `role="button"`, and Space on it would press it, so a reader hears a button where there's a page
 * to go to. This dresses the router's `<Link>` (or a plain `<a>`) in the same variant, with the same
 * "→", or the new-tab glyph and its spoken note. A kit candidate: every navigation chip wants it.
 */
export function ChipLink({
  link,
  external = false,
  children,
}: {
  /** The element that navigates: `<Link to="/about" />`, or `<a href target="_blank" />`. */
  link: ReactElement<{ className?: string; children?: ReactNode }>;
  external?: boolean;
  children: ReactNode;
}) {
  return cloneElement(link, {
    className: buttonVariants({ variant: 'link', size: 'xs' }),
    children: (
      <span data-slot="label" className="inline-flex items-center gap-[inherit]">
        {children}
        {external ? (
          <>
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.9em]" />
            <span className="sr-only">(opens in a new tab)</span>
          </>
        ) : (
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        )}
      </span>
    ),
  });
}
