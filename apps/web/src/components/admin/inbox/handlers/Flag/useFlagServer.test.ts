import { renderHook } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { expect, test, vi } from 'vitest';

/**
 * Each lever's write is the Inbox's own, by name — a takedown pointed at another mutation (the old
 * `moderation.resolveFlag`, say) would leave every behavior test green, so the names are pinned here.
 */
test('each of the four writes is its own Inbox mutation', async () => {
  vi.resetModules();
  vi.doMock('convex/react', () => ({
    // Each returned function says which mutation it stands for.
    useMutation: (ref: unknown) => ({ mutation: getFunctionName(ref as never) }),
  }));
  const { useFlagServer } = await import('./useFlagWrites');
  const { result } = renderHook(() => useFlagServer());
  const named = Object.fromEntries(
    Object.entries(result.current).map(([k, v]) => [
      k,
      (v as unknown as { mutation: string }).mutation,
    ]),
  );
  expect(named).toEqual({
    dismissFlags: 'inboxWrites:dismissFlags',
    takeDown: 'inboxWrites:takeDown',
    alertVerdict: 'inboxWrites:alertVerdict',
    restoreAndDismiss: 'inboxWrites:restoreAndDismiss',
  });
  vi.doUnmock('convex/react');
});
