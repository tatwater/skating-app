/**
 * **Where a consent was given from: the IP of the caller's Clerk session** (D297; B03 §9.2, R4).
 *
 * Convex gives a mutation no caller address, and the session id is not in our token (the apps ask
 * Clerk for the `convex` JWT template, and Clerk can't put the session-bound `sid` in a custom
 * template). Clerk's Backend API does know: a session's `latest_activity.ip_address`. So a scheduled
 * action, seconds after the write, asks for it — the session the token names (`sid`, if the instance
 * ever moves to Clerk's Convex integration), else the one the client names (both SDKs expose
 * `sessionId`), each used **only if it is the caller's**, else the caller's most recently active
 * session. What is stored is that session's latest-activity IP: evidence of where the session was,
 * not the request's own address, and the match says which session it was.
 *
 * The request pattern is `clerkAdmin.ts`' (`clerkRequest`: `CLERK_SECRET_KEY`, a timeout, the parsed
 * body). **Never throws**: every outcome is an answer — `captured`, or `unavailable` with why — because
 * the acceptance has already committed and must never wait on this or fail for it.
 */

import { clerkRequest } from '../clerkAdmin';

export type SessionMatch = 'token_sid' | 'client_session' | 'most_recent_session';

export type SessionIp =
  | { kind: 'captured'; address: string; match: SessionMatch }
  | { kind: 'unavailable'; reason: 'no_key' | 'no_session' | 'no_activity' | 'error' };

/** The slice of Clerk's session JSON this reads. */
interface ClerkSession {
  id?: unknown;
  user_id?: unknown;
  last_active_at?: unknown;
  latest_activity?: { ip_address?: unknown } | null;
}

/**
 * A session id as Clerk mints them (`sess_…`): letters, digits and underscores. Anything else from a
 * client is ignored rather than put in a request path.
 */
const SESSION_ID = /^[A-Za-z0-9_]{1,128}$/;

/** Longer than any IPv6 address with a zone; a longer value is not an address. */
const IP_MAX_LENGTH = 64;

function ipOf(session: ClerkSession): string | null {
  const ip = session.latest_activity?.ip_address;
  return typeof ip === 'string' && ip.length > 0 && ip.length <= IP_MAX_LENGTH ? ip : null;
}

function captured(session: ClerkSession, match: SessionMatch): SessionIp {
  const address = ipOf(session);
  return address === null
    ? { kind: 'unavailable', reason: 'no_activity' }
    : { kind: 'captured', address, match };
}

/**
 * The caller's session IP (R4). `tokenSessionId` is a `sid` claim, if the token carries one;
 * `clientSessionId` is what the client said its Clerk session is. Both are verified against
 * `clerkUserId` before use. A named session Clerk doesn't know (404) or that belongs to someone else
 * falls through to the next; any other failure is `error`, never a guess.
 */
export async function sessionIpFor({
  clerkUserId,
  tokenSessionId,
  clientSessionId,
}: {
  clerkUserId: string;
  tokenSessionId?: string;
  clientSessionId?: string;
}): Promise<SessionIp> {
  try {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) return { kind: 'unavailable', reason: 'no_key' };
    const named: [SessionMatch, string | undefined][] = [
      ['token_sid', tokenSessionId],
      ['client_session', clientSessionId],
    ];
    for (const [match, id] of named) {
      if (id === undefined || !SESSION_ID.test(id)) continue;
      const answer = await clerkRequest(key, `/sessions/${id}`, 'GET', (s) => s === 404);
      if (!answer.ok) return { kind: 'unavailable', reason: 'error' };
      if (answer.status === 404) continue;
      const session = (answer.body ?? {}) as ClerkSession;
      if (session.user_id !== clerkUserId) continue;
      return captured(session, match);
    }
    const params = new URLSearchParams({ user_id: clerkUserId, status: 'active' });
    const answer = await clerkRequest(key, `/sessions?${params}`, 'GET');
    if (!answer.ok) return { kind: 'unavailable', reason: 'error' };
    const body = answer.body as ClerkSession[] | { data?: ClerkSession[] } | null;
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    let latest: ClerkSession | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const session of list) {
      // Asked for this user's sessions; anyone else's in the answer is not theirs to use.
      if (session?.user_id !== clerkUserId) continue;
      const at = typeof session.last_active_at === 'number' ? session.last_active_at : 0;
      if (at > latestAt) {
        latest = session;
        latestAt = at;
      }
    }
    if (latest === null) return { kind: 'unavailable', reason: 'no_session' };
    return captured(latest, 'most_recent_session');
  } catch (err) {
    // `clerkRequest` doesn't throw; this is for anything unforeseen. The error, not the request.
    console.warn('clerkSessions: the session lookup threw', err instanceof Error ? err.name : '');
    return { kind: 'unavailable', reason: 'error' };
  }
}
