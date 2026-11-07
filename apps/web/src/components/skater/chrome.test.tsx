import { act, fireEvent, render, renderHook } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import {
  activeTopLevel,
  blockingModalOpen,
  isPlainLeftClick,
  navLinkProps,
  useChromeKeys,
  useChromeOverlay,
  withNewReport,
} from './chrome';

afterEach(() => {
  useChromeStore.setState({ overlay: null });
  document.body.innerHTML = '';
});

describe('useChromeOverlay', () => {
  it('opens one overlay at a time, and a late close never closes another', () => {
    const bell = renderHook(() => useChromeOverlay('notifications'));
    const avatar = renderHook(() => useChromeOverlay('avatar'));
    act(() => bell.result.current.onOpenChange(true));
    expect(bell.result.current.open).toBe(true);
    act(() => avatar.result.current.onOpenChange(true));
    expect(avatar.result.current.open).toBe(true);
    expect(bell.result.current.open).toBe(false);
    // The bell's plate reports its outside-press after the menu claimed the store.
    act(() => bell.result.current.onOpenChange(false));
    expect(useChromeStore.getState().overlay).toBe('avatar');
    act(() => avatar.result.current.onOpenChange(false));
    expect(useChromeStore.getState().overlay).toBeNull();
  });
});

describe('useChromeKeys', () => {
  const press = (
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget = document.body,
  ) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it('Esc closes the open overlay and stops there; with none open it passes through', () => {
    const onSearch = vi.fn();
    renderHook(() => useChromeKeys(onSearch));
    const below = vi.fn();
    document.addEventListener('keydown', below);
    act(() => useChromeStore.getState().setOverlay('notifications'));
    const first = press('Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(useChromeStore.getState().overlay).toBeNull();
    expect(below).not.toHaveBeenCalled();
    const second = press('Escape');
    expect(second.defaultPrevented).toBe(false);
    expect(below).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', below);
  });

  it('/ opens search from the page, but not while typing, with a modifier, or under a modal', () => {
    const onSearch = vi.fn();
    renderHook(() => useChromeKeys(onSearch));
    expect(press('/').defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledOnce();

    press('/', { metaKey: true });
    press('/', { ctrlKey: true });
    press('/', { altKey: true });
    press('a');
    const typed = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    typed.preventDefault();
    document.body.dispatchEvent(typed);
    expect(onSearch).toHaveBeenCalledOnce();

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    press('/', {}, input);
    expect(onSearch).toHaveBeenCalledOnce();
    input.blur();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    press('/');
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it('stops listening on unmount', () => {
    const onSearch = vi.fn();
    const { unmount } = renderHook(() => useChromeKeys(onSearch));
    unmount();
    press('/');
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe('blockingModalOpen', () => {
  it('counts dialogs, alert dialogs and sheets, but not the bell’s plate', () => {
    const root = document.createElement('div');
    expect(blockingModalOpen(root)).toBe(false);
    root.innerHTML = '<div role="dialog" data-slot="popover-content"></div>';
    expect(blockingModalOpen(root)).toBe(false);
    root.innerHTML = '<div role="alertdialog"></div>';
    expect(blockingModalOpen(root)).toBe(true);
    root.innerHTML = '<div data-slot="sheet-content"></div>';
    expect(blockingModalOpen(root)).toBe(true);
  });
});

describe('links', () => {
  it('routes a plain left press and leaves every other press to the browser', () => {
    const onNavigate = vi.fn();
    const { getByText } = render(
      <>
        <a {...navLinkProps('/latest', onNavigate)}>plain</a>
        <a {...navLinkProps('/x', onNavigate)} target="_blank">
          tab
        </a>
        <a {...navLinkProps('/y', onNavigate)} target="_self">
          self
        </a>
      </>,
    );
    fireEvent.click(getByText('plain'));
    expect(onNavigate).toHaveBeenLastCalledWith('/latest');
    fireEvent.click(getByText('plain'), { metaKey: true });
    fireEvent.click(getByText('plain'), { ctrlKey: true });
    fireEvent.click(getByText('plain'), { shiftKey: true });
    fireEvent.click(getByText('plain'), { altKey: true });
    fireEvent.click(getByText('plain'), { button: 1 });
    fireEvent.click(getByText('tab'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText('self'));
    expect(onNavigate).toHaveBeenLastCalledWith('/y');
  });

  it('treats a press something else already handled as not plain', () => {
    const el = document.createElement('a');
    const event = {
      defaultPrevented: true,
      button: 0,
      currentTarget: el,
    } as unknown as ReactMouseEvent<HTMLElement>;
    expect(isPlainLeftClick(event)).toBe(false);
  });
});

describe('activeTopLevel', () => {
  it('lights Explore for the map and its panels, Latest for the feed, nothing elsewhere', () => {
    expect(activeTopLevel('/')).toBe('explore');
    expect(activeTopLevel('/water/abc')).toBe('explore');
    expect(activeTopLevel('/bounty/abc/')).toBe('explore');
    expect(activeTopLevel('/latest')).toBe('latest');
    expect(activeTopLevel('/feed')).toBe('latest');
    expect(activeTopLevel('/settings/account')).toBeNull();
    expect(activeTopLevel('/u/kd')).toBeNull();
  });
});

describe('withNewReport', () => {
  it('adds ?post=new and keeps the page’s own params', () => {
    expect(withNewReport('/water/w1', '?tab=weather')).toBe('/water/w1?tab=weather&post=new');
    expect(withNewReport('/', '')).toBe('/?post=new');
    expect(withNewReport('/', '?postBody=old')).toBe('/?post=new');
    expect(withNewReport('/', '', 'w1')).toBe('/?post=new&postBody=w1');
  });
});
