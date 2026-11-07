import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { fakes, resetFakes, router } from './testMocks';

vi.mock('@tanstack/react-router', () => router);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('./GlobalSearch', () => ({ GlobalSearch: () => <div>search</div> }));
vi.mock('./NotificationsMenu', () => ({ NotificationsMenu: () => <div>bell</div> }));
vi.mock('./AvatarMenu', () => ({ AvatarMenu: () => <div>avatar</div> }));

import { SkaterTopBar } from './SkaterTopBar';

beforeEach(() => {
  resetFakes();
  useChromeStore.setState({ overlay: null });
});
afterEach(() => useChromeStore.setState({ overlay: null }));

describe('SkaterTopBar', () => {
  it('lights the page’s link and routes a plain press', () => {
    fakes.location = { pathname: '/water/w1', searchStr: '?tab=weather' };
    render(<SkaterTopBar />);
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Latest' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('link', { name: 'Latest' }));
    expect(fakes.push).toHaveBeenCalledWith('/latest');
  });

  it('opens New report over the current page and records the door', () => {
    fakes.location = { pathname: '/water/w1', searchStr: '?tab=weather' };
    render(<SkaterTopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'New report' }));
    expect(fakes.capture).toHaveBeenCalledWith('report_sheet_opened', { entry: 'top_bar' });
    expect(fakes.push).toHaveBeenCalledWith('/water/w1?tab=weather&post=new', {
      reportSheetEntryRecorded: true,
    });
  });

  it('closes the open overlay on a new page, not on the first render', () => {
    act(() => useChromeStore.getState().setOverlay('avatar'));
    const { rerender } = render(<SkaterTopBar />);
    expect(useChromeStore.getState().overlay).toBe('avatar');
    fakes.location = { pathname: '/latest', searchStr: '' };
    rerender(<SkaterTopBar />);
    expect(useChromeStore.getState().overlay).toBeNull();
  });
});
