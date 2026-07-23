import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';

export type Role = 'member' | 'moderator' | 'admin';

/**
 * The caller's role from the reactive `profiles.current` query (D37). The client uses this only to
 * decide what chrome to render — every underlying Convex function hard-gates on `role` server-side, so
 * a hidden button is a UX nicety, never the security boundary.
 */
export function useRole(): {
  role: Role | undefined;
  isModerator: boolean;
  isAdmin: boolean;
  isLoading: boolean;
} {
  const profile = useQuery(api.profiles.current, {});
  const role = profile?.role as Role | undefined;
  return {
    role,
    isModerator: role === 'moderator' || role === 'admin',
    isAdmin: role === 'admin',
    isLoading: profile === undefined,
  };
}
