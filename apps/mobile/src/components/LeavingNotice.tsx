import { api } from '@skating/convex/api';
import { isLeaving, LEAVING_NOTICE } from '@skating/core';
import { useQuery } from 'convex/react';
import { Paragraph } from 'tamagui';

/**
 * The line that stands where a compose affordance used to be, while a deletion is pending (D62
 * amendment). Mobile twin of the web component — same copy, same reasoning.
 *
 * The alternative to a button is not *nothing*: a lake sheet that quietly lost "Add a report" reads
 * as a broken build. So the empty space is labelled, and the label names the way back. It points at
 * the You tab rather than deep-linking, because that's where the Cancel button lives and a person
 * mid-deletion has already been there once.
 */
export function LeavingNotice() {
  return (
    <Paragraph color="$foregroundMuted" fontSize={13}>
      {LEAVING_NOTICE.replace('in Settings', 'on the You tab')}
    </Paragraph>
  );
}

/** Whether the signed-in account is read-only. The client mirror of `requireContributor`. */
export function useIsLeaving(): boolean {
  return isLeaving(useQuery(api.profiles.current, {}));
}
