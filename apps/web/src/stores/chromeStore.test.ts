import { beforeEach, describe, expect, it } from 'vitest';
import { useChromeStore } from './chromeStore';

const initial = useChromeStore.getState();

beforeEach(() => {
  useChromeStore.setState(
    { ...initial, overlay: null, phoneDrawerSnap: 'half', latestPhonePane: 'feed' },
    true,
  );
});

describe('useChromeStore', () => {
  it('holds one overlay at a time — opening another closes the first', () => {
    const s = useChromeStore.getState();
    s.setOverlay('search');
    expect(useChromeStore.getState().overlay).toBe('search');
    s.setOverlay('notifications');
    expect(useChromeStore.getState().overlay).toBe('notifications');
    s.setOverlay(null);
    expect(useChromeStore.getState().overlay).toBeNull();
  });

  it('toggleOverlay closes the open one and opens a closed one', () => {
    const s = useChromeStore.getState();
    s.toggleOverlay('avatar');
    expect(useChromeStore.getState().overlay).toBe('avatar');
    s.toggleOverlay('avatar');
    expect(useChromeStore.getState().overlay).toBeNull();
    s.toggleOverlay('avatar');
    useChromeStore.getState().toggleOverlay('search');
    expect(useChromeStore.getState().overlay).toBe('search');
  });

  it('tracks the phone drawer snap and the Latest pane', () => {
    useChromeStore.getState().setPhoneDrawerSnap('full');
    useChromeStore.getState().setLatestPhonePane('wanted');
    expect(useChromeStore.getState().phoneDrawerSnap).toBe('full');
    expect(useChromeStore.getState().latestPhonePane).toBe('wanted');
  });
});
