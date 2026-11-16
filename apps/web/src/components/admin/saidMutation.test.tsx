import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refuse: null as null | (() => void),
  toasts: [] as { title: string; description?: string }[],
}));
vi.mock('convex/react', async () => {
  const { ConvexError } = await import('convex/values');
  return {
    useMutation: () => () =>
      new Promise((_, reject) => {
        mocks.refuse = () => reject(new ConvexError('Not allowed'));
      }),
  };
});
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => mocks.toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { askFrom, drawn, keepAsking, PagePlace, type Place } from './place';
import { ReasonDialog } from './ReasonDialog';
import { useSaidMutation } from './saidMutation';

beforeEach(() => {
  mocks.refuse = null;
  mocks.toasts.length = 0;
});

/** A Legacy page's write, refused; its place drawn or not when the answer comes. */
async function refused(place: { drawn: boolean } | null) {
  const where = place === null ? null : { here: () => place.drawn };
  const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore, where));
  const sent = result.current({ waterBodyId: 'k1' as never });
  return async (drawnAtAnswer: boolean) => {
    if (place !== null) place.drawn = drawnAtAnswer;
    await act(async () => {
      mocks.refuse?.();
      await sent.catch(() => {});
    });
  };
}

describe('the Legacy pages’ net', () => {
  it('a page that says nothing of its own: the net says the refusal, and the page still sees it', async () => {
    await (await refused(null))(true);
    expect(mocks.toasts).toEqual([
      expect.objectContaining({ title: 'Not saved', description: 'Not allowed' }),
    ]);
  });

  it('a page that says it in place: the net is quiet while that place is drawn', async () => {
    await (await refused({ drawn: true }))(true);
    expect(mocks.toasts).toEqual([]);
  });

  /**
   * The place asked when the answer comes, never when the write was sent: a component that stays
   * mounted but stops drawing its error slot (a permission flipping, a read failing, a pane hidden)
   * has no place — the net says it, once.
   */
  it('a place no longer drawn when the answer comes — mounted or not: the net says it, once', async () => {
    await (await refused({ drawn: true }))(false);
    expect(mocks.toasts).toHaveLength(1);
  });
});

/** Refuses the write out, and lets its answer settle. */
async function refuse(sent: Promise<unknown>) {
  await act(async () => {
    mocks.refuse?.();
    await sent.catch(() => {});
  });
}

describe('the place asking: a reason dialog’s (`askFrom`)', () => {
  const dialog = (state: { drawn: boolean }): Place => ({ here: () => state.drawn });

  it.each([
    [true, 0],
    [false, 1],
  ])(
    'a write its confirm started asks the dialog, over the page’s own place — dialog drawn %s: %i toast',
    async (drawnAtAnswer, toasts) => {
      const state = { drawn: true };
      // The page's own place is drawn throughout: only the dialog's decides.
      const { result } = renderHook(() =>
        useSaidMutation(api.waterBodies.restore, { here: () => true }),
      );
      const sent = askFrom(dialog(state), () => result.current({ waterBodyId: 'k1' as never }));
      state.drawn = drawnAtAnswer;
      await refuse(sent);
      expect(mocks.toasts).toHaveLength(toasts);
    },
  );

  it('a write sent after an await is no longer the dialog’s, unless the confirm kept its place (`keepAsking`)', async () => {
    const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore));
    const confirm = (keep: boolean) =>
      askFrom(dialog({ drawn: true }), async () => {
        const asked = keep ? keepAsking() : <T,>(start: () => T) => start();
        await Promise.resolve();
        return asked(() => result.current({ waterBodyId: 'k1' as never }));
      });

    // Kept: asked of the dialog, drawn — said there, and the net is quiet.
    const kept = confirm(true);
    await waitFor(() => expect(mocks.refuse).not.toBeNull());
    await refuse(kept);
    expect(mocks.toasts).toEqual([]);

    // Not kept: no place at all — the net says it (and the dialog would too: said twice).
    mocks.refuse = null;
    const lost = confirm(false);
    await waitFor(() => expect(mocks.refuse).not.toBeNull());
    await refuse(lost);
    expect(mocks.toasts).toHaveLength(1);
  });
});

describe('the page’s place (`PagePlace`)', () => {
  it.each([
    [true, 0],
    [false, 1],
  ])(
    'a write handed no place of its own asks its page’s — page drawn %s: %i toast',
    async (drawnAtAnswer, toasts) => {
      const page = { drawn: true };
      const wrapper = ({ children }: { children: ReactNode }) => (
        <PagePlace.Provider value={{ here: () => page.drawn }}>{children}</PagePlace.Provider>
      );
      const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore), { wrapper });
      const sent = result.current({ waterBodyId: 'k1' as never });
      page.drawn = drawnAtAnswer;
      await refuse(sent);
      expect(mocks.toasts).toHaveLength(toasts);
    },
  );
});

/** A reason dialog whose page says a refusal in its banner (its own place, drawn throughout). */
function OnPage({ refusalOnPage }: { refusalOnPage: boolean }) {
  const restore = useSaidMutation(api.waterBodies.restore, { here: () => true });
  return (
    <ReasonDialog
      trigger={<button type="button">Restore</button>}
      title="Restore this body?"
      confirmLabel="Confirm"
      requireReason={false}
      refusalOnPage={refusalOnPage}
      onConfirm={async () => {
        try {
          await restore({ waterBodyId: 'k1' as never });
        } catch {
          // The page's banner says it.
        }
      }}
    />
  );
}

describe('a reason dialog whose confirm says a refusal on the page', () => {
  it.each([
    [true, 0],
    [false, 1],
  ])(
    'its row gone before the answer — the page still drawn — refusalOnPage %s: %i toast',
    async (refusalOnPage, toasts) => {
      const view = render(<OnPage refusalOnPage={refusalOnPage} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      await user.click(await screen.findByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(mocks.refuse).not.toBeNull());
      // A colleague decided the row: its dialog goes; the page and its banner stay.
      view.rerender(<span />);
      await act(async () => {
        mocks.refuse?.();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(mocks.toasts).toHaveLength(toasts);
    },
  );
});

describe('a drawn place', () => {
  it('is drawn only in the document and outside anything hidden or inert', () => {
    const outer = document.body.appendChild(document.createElement('div'));
    const el = outer.appendChild(document.createElement('p'));
    expect(drawn(el)).toBe(true);
    outer.hidden = true;
    expect(drawn(el)).toBe(false);
    outer.hidden = false;
    outer.className = 'hidden';
    expect(drawn(el)).toBe(false);
    outer.className = '';
    outer.setAttribute('inert', '');
    expect(drawn(el)).toBe(false);
    outer.remove();
    expect(drawn(el)).toBe(false);
    expect(drawn(null)).toBe(false);
  });
});
