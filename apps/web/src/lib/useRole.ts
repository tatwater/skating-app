import { api } from '@skating/convex/api';
import { isLeaving } from '@skating/core';
import { useQuery } from 'convex/react';

export type Role = 'member' | 'moderator' | 'admin';

/**
 * The caller's role from the reactive `profiles.current` query (D37). The client uses this only to
 * decide what chrome to render — every underlying Convex function hard-gates on `role` server-side, so
 * a hidden button is a UX nicety, never the security boundary.
 *
 * **`isModerator` and `canModerate` are not the same question**, and the split mirrors a seam the
 * server draws (`requireRole` vs `requireContributorRole`). A departing operator keeps their *reads* —
 * the admin tree, the queues, the analytics — because reviewing the state of things on the way out is
 * reasonable and because reading is most of what "you can still change your mind" means. What they
 * lose is every privileged **write**.
 *
 * So navigation and read-only chrome gate on `isModerator`; anything that submits gates on
 * `canModerate`. Using the first for an action button would show a control the server now refuses,
 * which is the exact failure the "hide exactly what the server blocks" rule exists to prevent.
 */
export function useRole(): {
  role: Role | undefined;
  /** The caller's own profile id — used to hide self-targeting operator controls. */
  userId: string | undefined;
  /** Holds the role — gates navigation and read-only operator chrome. */
  isModerator: boolean;
  isAdmin: boolean;
  /** Holds the role **and** is not mid-deletion — gates every operator action. */
  canModerate: boolean;
  /** The reason `canModerate` is false while `isModerator` is true. */
  leaving: boolean;
  isLoading: boolean;
} {
  const profile = useQuery(api.profiles.current, {});
  const role = profile?.role as Role | undefined;
  const isModerator = role === 'moderator' || role === 'admin';
  const leaving = isLeaving(profile);
  return {
    role,
    userId: profile?._id,
    isModerator,
    isAdmin: role === 'admin',
    canModerate: isModerator && !leaving,
    leaving,
    isLoading: profile === undefined,
  };
}
