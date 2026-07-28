import { api } from '@skating/convex/api';
import { isLeaving, LEAVING_NOTICE } from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';

/**
 * The line that stands where a compose affordance used to be, while a deletion is pending (D62
 * amendment).
 *
 * It exists because the alternative to a button is not *nothing* — a lake drawer that quietly lost
 * "Add a report" reads as a broken build, and the person most likely to see it is the one who has
 * already been told the app is behaving oddly on their account. So the empty space is labelled, and
 * the label carries the way back rather than only the bad news.
 *
 * Deliberately not a toast or a modal: this is a *state*, not an event. It should be as boring as the
 * rest of the drawer and it should still be there tomorrow.
 */
export function LeavingNotice() {
  return (
    <p className="text-foreground-muted text-sm">
      {LEAVING_NOTICE.replace(' Cancel it in Settings to post again.', '')}{' '}
      <Link to="/settings" className="text-foreground underline underline-offset-4">
        Cancel it in Settings
      </Link>{' '}
      to post again.
    </p>
  );
}

/** Whether the signed-in account is read-only. The client mirror of `requireContributor`. */
export function useIsLeaving(): boolean {
  return isLeaving(useQuery(api.profiles.current, {}));
}
