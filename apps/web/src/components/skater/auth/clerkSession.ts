import type { SetActiveNavigate } from '@clerk/shared/types';
import { type AuthOutcome, classifyClerkError, failed, OK } from './authFlow';

/** The one method a finished sign-in or sign-up shares. */
interface Finalizable {
  finalize: (params: { navigate: SetActiveNavigate }) => Promise<{ error: unknown }>;
}

/**
 * Makes the finished attempt the active session. It does not navigate within the app, on purpose:
 * Clerk calls `navigate` *before* it sets the session, so a route change here would meet `AuthGate`
 * still reading "signed out" and bounce back to the form. The session flipping is what moves the
 * screen. The one redirect kept is the external one `decorateUrl` asks for, Safari's cookie refresh,
 * which is a full page load and so can't race.
 *
 * A session with a task (a forced organization, a required second factor) isn't signed in yet, and
 * this flow can't complete one. The instance configures none, so that's a failure to report rather
 * than a screen to build.
 */
export async function finishSession(resource: Finalizable): Promise<AuthOutcome> {
  let pendingTask = false;
  const { error } = await resource.finalize({
    navigate: ({ session, decorateUrl }) => {
      if (session.currentTask) {
        pendingTask = true;
        return;
      }
      const url = decorateUrl('/');
      if (url.startsWith('http')) window.location.href = url;
    },
  });
  if (error) return failed(classifyClerkError(error));
  return pendingTask ? failed('incomplete') : OK;
}
