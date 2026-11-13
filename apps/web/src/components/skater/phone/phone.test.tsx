import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { convexReact, fakes, resetFakes, router } from '../testMocks';

const phone = vi.hoisted(() => ({ matches: false, listeners: new Set<() => void>() }));
const signOut = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sheet = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => router);
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => fakes.auth }));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => signOut }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => sheet.value,
  useSheetAttempt: () => null,
  readStoredSheet: () => null,
}));
vi.mock('../../theme-provider', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn(), resolvedTheme: 'dark' }),
}));

import { PHONE_QUERY, useIsPhone } from '@/lib/usePhoneLayout';
import { GlobalSearch } from '../GlobalSearch';
import { LatestFrame } from '../latest/LatestFrame';
import { LatestPhoneBar } from './LatestPhoneBar';
import { PhoneChrome } from './PhoneChrome';
import { closesLake, PhoneLakeDrawer, snapName } from './PhoneLakeDrawer';
import { PhoneMenuSheet } from './PhoneMenuSheet';
import { PhoneSearchView } from './PhoneSearchView';

/** A `matchMedia` whose phone query answers `phone.matches`, and can say it changed. */
function stubMedia() {
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY && phone.matches,
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => phone.listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => phone.listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const original = window.matchMedia;
beforeEach(() => {
  resetFakes();
  phone.matches = false;
  phone.listeners.clear();
  sheet.value = null;
  stubMedia();
  useChromeStore.setState({ overlay: null, phoneDrawerSnap: 'half', latestPhonePane: 'feed' });
  fakes.queries.set('profiles:current', {
    _id: 'p1',
    displayName: 'Kate Donovan',
    username: 'kdonovan',
    role: 'moderator',
  });
});
afterEach(() => {
  window.matchMedia = original;
});

const esc = () => fireEvent.keyDown(window, { key: 'Escape' });

describe('useIsPhone', () => {
  it('answers the phone query and follows it as the window changes', () => {
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
    phone.matches = true;
    act(() => {
      for (const fn of phone.listeners) fn();
    });
    expect(result.current).toBe(true);
  });
});

describe('PhoneChrome', () => {
  it('opens New report over this page from the tab bar, and records the door', () => {
    fakes.location = { pathname: '/latest', searchStr: '?report=r1' };
    render(<PhoneChrome live={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'New report' }));
    expect(fakes.capture).toHaveBeenCalledWith('report_sheet_opened', { entry: 'phone_tab' });
    expect(fakes.push).toHaveBeenCalledWith(
      '/latest?report=r1&post=new',
      expect.objectContaining({}),
    );
    expect(screen.getByRole('link', { name: 'Latest' })).toHaveAttribute('aria-current', 'page');
  });

  it('routes a plain press on a tab in the app; a modified one is the browser’s', () => {
    render(<PhoneChrome live={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Latest' }));
    expect(fakes.push).toHaveBeenCalledWith('/latest');
    fakes.push.mockClear();
    fireEvent.click(screen.getByRole('link', { name: 'Explore' }), { metaKey: true });
    expect(fakes.push).not.toHaveBeenCalled();
  });

  it('mounts the overlays only while live', () => {
    const { rerender } = render(<PhoneChrome live={false} />);
    expect(screen.queryByRole('button', { name: 'Your account' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Notifications/ })).toBeNull();
    rerender(<PhoneChrome live />);
    expect(screen.getByRole('button', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Notifications/ })).toBeInTheDocument();
  });

  it('closes an open overlay when the page changes, live only', () => {
    const { rerender } = render(<PhoneChrome live />);
    act(() => useChromeStore.getState().setOverlay('avatar'));
    fakes.location = { pathname: '/latest', searchStr: '' };
    rerender(<PhoneChrome live />);
    expect(useChromeStore.getState().overlay).toBeNull();

    rerender(<PhoneChrome live={false} />);
    act(() => useChromeStore.getState().setOverlay('search'));
    fakes.location = { pathname: '/', searchStr: '' };
    rerender(<PhoneChrome live={false} />);
    expect(useChromeStore.getState().overlay).toBe('search');
  });
});

describe('GlobalSearch on a phone', () => {
  it('opens from the bar’s field as surface `phone`, full screen, Back closing it', () => {
    render(<GlobalSearch layout="phone" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search lakes, bays, and skaters' }));
    expect(fakes.capture).toHaveBeenCalledWith('search_opened', { surface: 'phone' });
    expect(useChromeStore.getState().overlay).toBe('search');
    const field = screen.getByRole('combobox', { name: 'Search lakes, bays, and skaters' });
    fireEvent.change(field, { target: { value: 'ma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(field).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useChromeStore.getState().overlay).toBeNull();
  });
});

describe('PhoneMenuSheet', () => {
  const open = () => act(() => useChromeStore.getState().setOverlay('avatar'));

  it('shows who you are, Moderation in a new tab, and goes where a row says', () => {
    open();
    render(<PhoneMenuSheet />);
    expect(screen.getByText('@kdonovan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Moderation/ })).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('link', { name: 'Your profile' }));
    expect(useChromeStore.getState().overlay).toBeNull();
    expect(fakes.push).toHaveBeenCalledWith('/u/kdonovan');
  });

  it('signs out through the draft guard (nothing to lose: straight out)', async () => {
    open();
    render(<PhoneMenuSheet />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    expect(useChromeStore.getState().overlay).toBeNull();
    expect(signOut).toHaveBeenCalled();
  });

  it('with a draft to lose, asks first, and "Open the draft" reopens it over this page', async () => {
    sheet.value = {
      draftId: 'd',
      idempotencyKey: 'k',
      title: '',
      body: 'Black ice off the point',
      reports: [{ bodyName: 'Mascoma Lake' }],
      mode: { kind: 'create' },
      door: 'body',
      openedAtMs: Date.now(),
      dirty: true,
    };
    fakes.location = { pathname: '/latest', searchStr: '?report=r1' };
    open();
    render(<PhoneMenuSheet />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the draft' }));
    expect(fakes.push).toHaveBeenCalledWith(expect.stringMatching(/^\/latest\?report=r1&post=/));
  });

  it('a member gets no Moderation row; the theme is the three-way picker', () => {
    fakes.queries.set('profiles:current', { _id: 'p1', displayName: '', username: '' });
    open();
    render(<PhoneMenuSheet />);
    expect(screen.queryByRole('link', { name: /Moderation/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    // The sheet's own Esc closes it through the chrome store.
    fireEvent.keyDown(screen.getByRole('button', { name: 'System' }), { key: 'Escape' });
    expect(useChromeStore.getState().overlay).toBeNull();
  });
});

describe('PhoneSearchView', () => {
  const ROW = (key: string, name: string, kind: 'water_body' | 'skater') => ({
    key,
    kind,
    name,
    sub: kind === 'skater' ? '@mochs' : 'Reservoir · NH',
    meta: '3 reports today',
    href: kind === 'skater' ? '/u/mochs' : '/water/b1',
    pick: { kind, id: key },
  });
  const GROUPS = [
    { id: 'lakes' as const, label: 'Lakes', items: [ROW('b1', 'Mascoma Lake', 'water_body')] },
    { id: 'skaters' as const, label: 'Skaters', items: [ROW('mochs', 'Matt Ochs', 'skater')] },
  ];

  it('draws the groups under the field, opens a pressed row, and Esc asks to close', () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <PhoneSearchView
        open
        onOpenChange={onOpenChange}
        query="ma"
        onQueryChange={onQueryChange}
        groups={GROUPS}
        loading
        onPick={onPick}
      />,
    );
    expect(screen.getByText('Lakes')).toBeInTheDocument();
    const rows = document.querySelectorAll<HTMLElement>('[data-slot="global-search-row"]');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: 'mochs' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mas' } });
    expect(onQueryChange).toHaveBeenCalledWith('mas');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says so when nothing matches', () => {
    render(
      <PhoneSearchView
        open
        onOpenChange={() => {}}
        query="zz"
        onQueryChange={() => {}}
        groups={[]}
        noResultsFor="zz"
        onPick={() => {}}
      />,
    );
    expect(screen.getByText(/No lakes, bays, or skaters match/)).toBeInTheDocument();
  });
});

describe('PhoneLakeDrawer', () => {
  const lake = (escapes = true) => (
    <PhoneLakeDrawer label="Mascoma Lake" escapes={escapes}>
      <p>the sidebar</p>
    </PhoneLakeDrawer>
  );

  it('passes the sidebar straight through at md and up', () => {
    render(lake());
    expect(screen.getByText('the sidebar')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="phone-lake-drawer"]')).toBeNull();
  });

  it('on a phone, opens at half; the toggle takes it to full and back', () => {
    phone.matches = true;
    useChromeStore.setState({ phoneDrawerSnap: 'full' });
    render(lake());
    expect(screen.getByText('the sidebar')).toBeInTheDocument();
    expect(useChromeStore.getState().phoneDrawerSnap).toBe('half');
    fireEvent.click(screen.getByRole('button', { name: 'Show more of Mascoma Lake' }));
    expect(useChromeStore.getState().phoneDrawerSnap).toBe('full');
    fireEvent.click(screen.getByRole('button', { name: 'Show less of Mascoma Lake' }));
    expect(useChromeStore.getState().phoneDrawerSnap).toBe('half');
  });

  it('Esc steps the ladder: full → half → closed (back to Explore)', () => {
    phone.matches = true;
    render(lake());
    act(() => useChromeStore.getState().setPhoneDrawerSnap('full'));
    esc();
    expect(useChromeStore.getState().phoneDrawerSnap).toBe('half');
    expect(fakes.push).not.toHaveBeenCalled();
    esc();
    expect(fakes.push).toHaveBeenCalledWith('/');
  });

  it('stands aside while something inside owns Esc, or Esc was already taken', () => {
    phone.matches = true;
    const { rerender } = render(lake(false));
    esc();
    expect(fakes.push).not.toHaveBeenCalled();
    rerender(lake());
    const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(fakes.push).not.toHaveBeenCalled();
  });

  it('Close closes the lake', () => {
    phone.matches = true;
    render(lake());
    fireEvent.click(screen.getByRole('button', { name: 'Close Mascoma Lake' }));
    expect(fakes.push).toHaveBeenCalledWith('/');
  });

  it('closes the lake on a swipe, never on Esc, a press on the map, or focus leaving', () => {
    expect(closesLake(false, 'swipe')).toBe(true);
    expect(closesLake(false, 'escape-key')).toBe(false);
    expect(closesLake(false, 'outside-press')).toBe(false);
    expect(closesLake(false, 'focus-out')).toBe(false);
    expect(closesLake(true, 'swipe')).toBe(false);
  });

  it('names a snap point by the store’s words', () => {
    expect(snapName(1)).toBe('full');
    expect(snapName(0.5)).toBe('half');
    expect(snapName(null)).toBe('half');
  });
});

describe('Latest on a phone', () => {
  it('switches panes, and Esc brings the reports back', () => {
    phone.matches = true;
    const { unmount } = render(<LatestPhoneBar filterCount={2} />);
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveTextContent('Filters2 on');
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(useChromeStore.getState().latestPhonePane).toBe('filters');
    esc();
    expect(useChromeStore.getState().latestPhonePane).toBe('feed');
    fireEvent.click(screen.getByRole('button', { name: 'Wanted' }));
    unmount();
    // Leaving Latest leaves the reports chosen for next time.
    expect(useChromeStore.getState().latestPhonePane).toBe('feed');
  });

  it('no count when no filter is on', () => {
    render(<LatestPhoneBar filterCount={0} />);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('the frame shows the chosen column below md, and the feed while a report is open', () => {
    const frame = (report?: string) => (
      <LatestFrame
        filters={<p>filters</p>}
        feed={<p>feed</p>}
        aside={<p>aside</p>}
        report={report ? <p>{report}</p> : undefined}
      />
    );
    const column = (name: string) => screen.getByLabelText(name).className;
    const { rerender } = render(frame());
    expect(column('Filters')).toContain('max-md:hidden');
    expect(column('Latest')).not.toContain('max-md:hidden');
    act(() => useChromeStore.getState().setLatestPhonePane('filters'));
    expect(column('Filters')).not.toContain('max-md:hidden');
    expect(column('Latest')).toContain('max-md:hidden');
    act(() => useChromeStore.getState().setLatestPhonePane('wanted'));
    expect(column('Recommended and wanted')).toContain('max-md:flex');
    rerender(frame('the report'));
    expect(column('Latest')).not.toContain('max-md:hidden');
    expect(document.querySelector('[data-slot="latest-phone-bar"]')).toBeNull();
  });
});
