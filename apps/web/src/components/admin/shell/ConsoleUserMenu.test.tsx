/**
 * The viewer's menu, wired: the theme through the app's one provider and cookie, and Sign out the
 * skater menu's way (the draft guard, then Clerk) — including with an admin write still on its way.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  signOut: vi.fn(),
  /** The report sheet this browser holds; `null` is none. */
  sheet: null as unknown,
}));

vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: mocks.capture }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => mocks.signOut }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => mocks.sheet,
  useSheetAttempt: () => null,
  readStoredSheet: () => null,
}));

const { ThemeProvider } = await import('@/components/theme-provider');
const { createToastManager, Toaster } = await import('@/components/kit/toast');
const { said } = await import('../said');
const { ConsoleUserMenu, draftHref } = await import('./ConsoleUserMenu');
const { menuViewerOf } = await import('./ConsoleLayout');
const { THEME_COOKIE } = await import('@/lib/theme');
const { answerUnsavedAsks, NO_OTHER_TABS, setUnsavedChannelForTests } = await import(
  '@/lib/unsavedElsewhere'
);
const { tabsHub } = await import('@/test/tabsHub');

const VIEWER = { state: 'ready', id: 'p_robin', name: 'Robin Ashford' } as const;

beforeAll(() => {
  Element.prototype.animate ??= (() => ({ cancel() {}, startTime: 0 })) as never;
});

function clearTheme() {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the provider writes document.cookie
  document.cookie = `${THEME_COOKIE}=; path=/; max-age=0`;
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
}

beforeEach(() => {
  mocks.capture.mockReset();
  mocks.signOut.mockReset().mockResolvedValue(undefined);
  mocks.sheet = null;
  clearTheme();
  // No other tab, and a wait short enough that a Sign out settles inside its own test.
  setUnsavedChannelForTests(NO_OTHER_TABS, 0);
});
afterEach(() => {
  setUnsavedChannelForTests(undefined);
  clearTheme();
  vi.restoreAllMocks();
});

function Wired() {
  return (
    <ThemeProvider>
      <ConsoleUserMenu viewer={VIEWER} canOpenOwnPage />
    </ThemeProvider>
  );
}

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: /^Your account/ }));
  return screen.findByRole('menu');
}

const segment = (m: HTMLElement, name: string) => {
  const picker = m.querySelector<HTMLElement>('[data-slot="theme-picker"]');
  if (picker === null) throw new Error('no theme picker');
  return within(picker).getByRole('button', { name });
};

describe('the theme', () => {
  it('is the app’s one preference: the page’s mode, the cookie, and theme_changed', async () => {
    render(<Wired />);
    const m = await openMenu();
    expect(segment(m, 'System')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(segment(m, 'Dark'));
    const root = document.documentElement;
    await waitFor(() => expect(root).toHaveAttribute('data-mode', 'dark'));
    expect(root).toHaveClass('dark');
    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    expect(mocks.capture).toHaveBeenCalledWith('theme_changed', { mode: 'dark' });

    await userEvent.click(segment(m, 'Light'));
    await waitFor(() => expect(root).toHaveAttribute('data-mode', 'light'));
    expect(root).not.toHaveClass('dark');

    // System is the cookie gone and the attribute removed — never a third stored value.
    await userEvent.click(segment(m, 'System'));
    await waitFor(() => expect(root).not.toHaveAttribute('data-mode'));
    expect(document.cookie).not.toContain(`${THEME_COOKIE}=`);
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });

  it('records nothing for the choice already made', async () => {
    render(<Wired />);
    await userEvent.click(segment(await openMenu(), 'System'));
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe('Sign out', () => {
  it('signs straight out through Clerk when nothing would be lost', async () => {
    render(<Wired />);
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('with a report another tab holds unsent (an edit lives only in its tab)', () => {
    const OTHER_TAB =
      'A report open in another tab of this browser has changes that aren’t posted yet. Signing out discards them.';

    it('asks first; Cancel leaves both tabs as they were; the confirm signs out', async () => {
      const hub = tabsHub();
      setUnsavedChannelForTests(hub.make, 0);
      const holds = vi.fn(() => true);
      const stop = answerUnsavedAsks(holds, 'the-other-tab');
      render(<Wired />);
      await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(OTHER_TAB)).toBeInTheDocument();
      // Nothing to open from here: the work is in the other tab.
      expect(within(dialog).queryByRole('button', { name: 'Open the draft' })).toBeNull();
      expect(mocks.signOut).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(mocks.signOut).not.toHaveBeenCalled();
      // The other tab was only asked: its listener is still there, nothing else happened to it.
      expect(holds).toHaveBeenCalledTimes(1);
      expect(hub.open.size).toBe(1);

      await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
      const again = await screen.findByRole('dialog');
      await userEvent.click(within(again).getByRole('button', { name: 'Sign out' }));
      expect(mocks.signOut).toHaveBeenCalledOnce();
      stop();
    });

    it('warns, never stays silent, when this browser can’t ask its tabs', async () => {
      setUnsavedChannelForTests(() => null, 0);
      render(<Wired />);
      await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'This browser can’t check its other tabs, so a report you’re writing in one of them may be discarded.',
        ),
      ).toBeInTheDocument();
      expect(mocks.signOut).not.toHaveBeenCalled();
    });

    it('goes straight out once the other tab has closed', async () => {
      const hub = tabsHub();
      setUnsavedChannelForTests(hub.make, 0);
      answerUnsavedAsks(() => true, 'the-other-tab')();
      render(<Wired />);
      await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
      await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('asks first over a report still unsent, and opens it in the app in a new tab', async () => {
    mocks.sheet = {
      draftId: 'd',
      idempotencyKey: 'k',
      title: '',
      body: 'Pressure ridge off the point',
      reports: [{ bodyName: 'Mascoma Lake' }],
      mode: { kind: 'create' },
      door: 'body',
      openedAtMs: Date.now(),
      dirty: true,
    };
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Wired />);
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(await screen.findByText('Sign out and discard your draft?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open the draft' }));
    expect(opened).toHaveBeenCalledWith('/?post=new', '_blank', 'noopener');
    await waitFor(() => expect(screen.queryByText('Sign out and discard your draft?')).toBeNull());
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('still signs out from the question when told to', async () => {
    mocks.sheet = {
      draftId: 'd',
      idempotencyKey: 'k',
      title: '',
      body: 'x',
      reports: [{ bodyName: 'Mascoma Lake' }],
      mode: { kind: 'edit', reportId: 'r1' },
      door: 'body',
      openedAtMs: Date.now(),
      dirty: true,
    };
    render(<Wired />);
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it('says so when Clerk doesn’t answer — still signed in — and leaves Sign out to press again', async () => {
    mocks.signOut.mockRejectedValueOnce(new Error('offline'));
    render(
      <>
        <Wired />
        <Toaster />
      </>,
    );
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
    // Drawn, and announced (the live region repeats it).
    expect((await screen.findAllByText('Not signed out')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('You’re still signed in. Check your connection and try again.').length,
    ).toBeGreaterThan(0);
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['refused', 'reject'],
    ['landed', 'resolve'],
  ] as const)(
    'with a write still on its way (%s): nothing throws or sticks, and only a refusal is a toast, in the root dock',
    async (_label, how) => {
      const manager = createToastManager();
      const add = vi.spyOn(manager, 'add');
      let settle: { resolve: (v: null) => void; reject: (e: unknown) => void } | undefined;
      const write = new Promise<null>((resolve, reject) => {
        settle = { resolve, reject };
      });
      // A console write out at the moment the viewer signs out, through the one write helper.
      const answer = said(
        () => write,
        (why) => ({ title: 'Not saved · Mascoma Lake', description: why }),
        { manager },
      );
      const { unmount } = render(<Wired />);
      await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Sign out' }));
      await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
      // Signed out, the gate takes the console away; the answer comes after.
      unmount();
      if (how === 'reject') settle?.reject(new ConvexError({ message: 'Not signed in.' }));
      else settle?.resolve(null);
      const said_ = await answer;
      if (how === 'reject') {
        expect(said_).toEqual({ landed: false });
        expect(add).toHaveBeenCalledOnce();
        expect(add.mock.calls[0]?.[0]).toMatchObject({
          title: 'Not saved · Mascoma Lake',
          description: 'Not signed in.',
          timeout: 0,
        });
      } else {
        expect(said_).toEqual({ landed: true, value: null });
        expect(add).not.toHaveBeenCalled();
      }
    },
  );
});

describe('the helpers', () => {
  it('reads the viewer from the gate’s own profile read', () => {
    expect(menuViewerOf(undefined)).toEqual({ state: 'loading' });
    expect(menuViewerOf(null)).toEqual({ state: 'failed' });
    expect(menuViewerOf({ _id: 'p1', displayName: 'Robin Ashford' })).toEqual({
      state: 'ready',
      id: 'p1',
      name: 'Robin Ashford',
    });
    expect(
      menuViewerOf({ _id: 'p1', displayName: 'Robin Ashford', profileImageUrl: 'https://x/r.png' }),
    ).toMatchObject({ src: 'https://x/r.png' });
  });

  it('opens a draft on its own door', () => {
    expect(draftHref({ post: 'new' })).toBe('/?post=new');
    expect(draftHref({ post: 'r1' })).toBe('/?post=r1');
  });
});
