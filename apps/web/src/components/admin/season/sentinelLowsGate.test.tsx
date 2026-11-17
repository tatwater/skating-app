import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * **D275's one line, flipped.** Should the founder keep the sentinels' lows to admins, the constant
 * becomes `'season.read'` and nothing else moves: a moderator's Home never asks for the read, and the
 * row is simply absent — no error, no empty row, as the Machinery card is left out.
 */

const asked = vi.hoisted(() => [] as string[]);

vi.mock('@skating/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/core')>()),
  SENTINEL_LOWS_CAPABILITY: 'season.read',
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  type Ref = Parameters<typeof getFunctionName>[0];
  return {
    useQuery: (ref: Ref, args: unknown) => {
      if (args !== 'skip') asked.push(getFunctionName(ref));
      return undefined;
    },
    useQueries: (queries: Record<string, { query: Ref }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([name, q]) => {
          asked.push(getFunctionName(q.query));
          return [name, undefined];
        }),
      ),
  };
});

describe('the sentinels’ lows kept to admins', () => {
  it('a moderator’s Home never asks, and its row is withheld', async () => {
    const { can } = await import('@skating/core');
    const { useOverviewHome } = await import('@/components/admin/overview/useOverviewHome');
    const moderator = (cap: Parameters<typeof can>[1]) => can('moderator', cap);
    const { result } = renderHook(() =>
      useOverviewHome({ season: 2026, now: Date.UTC(2026, 9, 13), can: moderator }),
    );
    expect(result.current.lows).toBe('withheld');
    expect(asked).not.toContain('sentinelLows:forSeason');
    // (Home leaves a withheld row out: `OverviewHome.test.tsx`.)

    // An admin still reads it.
    asked.length = 0;
    const admin = (cap: Parameters<typeof can>[1]) => can('admin', cap);
    const { result: theirs } = renderHook(() =>
      useOverviewHome({ season: 2026, now: Date.UTC(2026, 9, 13), can: admin }),
    );
    expect(theirs.current.lows).toEqual({ kind: 'loading' });
    expect(asked).toContain('sentinelLows:forSeason');
  });
});
