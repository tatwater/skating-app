import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * PostHog's class for "do not collect this" — the SDK's text collector walks up from each node and
 * skips any subtree carrying it, so a masked element's text is left out of its *ancestors'*
 * captured text too, not just its own.
 */
const PH_NO_CAPTURE = 'ph-no-capture';

/**
 * A person's name or handle on screen, excluded from analytics capture (D235).
 *
 * ## Why this is a component and not a class people remember to add
 *
 * Autocapture is on (founder call), and it records the on-screen text of whatever was clicked.
 * A display name rendered inside a clickable feed card therefore reaches PostHog as element
 * text — other skaters' names, 16- and 17-year-olds' included, since D41 sets the floor at 16 —
 * and `PRIVACY.md` says plainly that we do not send names.
 *
 * A dozen `className="ph-no-capture"`s spread across the components that render a name would hold
 * that line exactly until the next component renders one, at which point the published commitment
 * quietly becomes false with nothing failing. One component is the only version of this rule that
 * a new call site has to opt *out* of rather than remember to opt in to.
 *
 * Use it for anything that identifies a person: a display name, an `@username`, an avatar's
 * initial. Not for a lake, a town or a hazard — those are places, and the notice discloses them.
 */
export function PersonName({
  children,
  className,
}: {
  /** The name or handle. Text, not a whole card — the mask covers everything inside. */
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn(PH_NO_CAPTURE, className)}>{children}</span>;
}

/**
 * The same mask for an element this cannot wrap — an avatar whose `alt` and initial both carry the
 * name, where the class belongs on the element itself rather than on a span around it. Autocapture
 * collects element *attributes* as well as text, so `alt={displayName}` leaks without this.
 */
export const personNameClass = PH_NO_CAPTURE;
