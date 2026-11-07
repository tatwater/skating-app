import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

const m = vi.hoisted(() => ({
  user: null as unknown,
  online: true,
  process: vi.fn(),
}));
vi.mock('convex/react', () => convexReact);
vi.mock('@clerk/tanstack-react-start', () => ({ useUser: () => ({ user: m.user }) }));
vi.mock('@/lib/useConnection', () => ({ useBrowserOnline: () => m.online }));
vi.mock('../../photoPipeline', () => ({ processAvatar: m.process }));

import { useProfilePhoto } from './useProfilePhoto';

const PICKED = new File(['raw'], 'IMG_0001.png', { type: 'image/png' });
const SHRUNK = new File(['small'], 'IMG_0001.jpg', { type: 'image/jpeg' });

function clerkUser(over: Record<string, unknown> = {}) {
  return {
    hasImage: true,
    imageUrl: 'https://img.clerk.com/kate.jpg',
    setProfileImage: vi.fn().mockResolvedValue({ id: 'img_1' }),
    ...over,
  };
}
const user = () => m.user as ReturnType<typeof clerkUser>;
const sync = () => fakes.mutations.get('profiles:syncFromClerk');

beforeEach(() => {
  resetFakes();
  m.process.mockReset();
  m.process.mockResolvedValue(SHRUNK);
  m.online = true;
  m.user = clerkUser();
});

describe('useProfilePhoto', () => {
  it('reads the photo from Clerk’s user, and none when Clerk has only its default', () => {
    const { result, rerender } = renderHook(() => useProfilePhoto());
    expect(result.current.imageUrl).toBe('https://img.clerk.com/kate.jpg');
    m.user = clerkUser({ hasImage: false, imageUrl: 'https://img.clerk.com/default.png' });
    rerender();
    expect(result.current.imageUrl).toBeUndefined();
    m.user = null;
    rerender();
    expect(result.current.imageUrl).toBeUndefined();
  });

  it('shrinks the pick, hands Clerk the shrunk file, then nudges the mirror', async () => {
    const { result } = renderHook(() => useProfilePhoto());
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.onChange(PICKED);
    });
    expect(result.current.busy).toBe('uploading');
    await act(async () => done);
    expect(m.process).toHaveBeenCalledWith(PICKED);
    expect(user().setProfileImage).toHaveBeenCalledWith({ file: SHRUNK });
    expect(sync()).toHaveBeenCalledWith({});
    expect(result.current.busy).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('a mirror nudge that fails changes nothing on screen', async () => {
    fakes.mutations.set('profiles:syncFromClerk', vi.fn().mockRejectedValue(new Error('offline')));
    const { result } = renderHook(() => useProfilePhoto());
    await act(async () => result.current.onChange(PICKED));
    expect(result.current.error).toBeNull();
  });

  it('refuses a file that isn’t a photo before shrinking anything', async () => {
    const { result } = renderHook(() => useProfilePhoto());
    await act(async () =>
      result.current.onChange(new File(['%PDF'], 'me.pdf', { type: 'application/pdf' })),
    );
    expect(m.process).not.toHaveBeenCalled();
    expect(user().setProfileImage).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/isn’t a photo/);
  });

  it('a photo that can’t be read says so, and Clerk is never called', async () => {
    m.process.mockRejectedValue(new Error('The file given is not an image'));
    const { result } = renderHook(() => useProfilePhoto());
    await act(async () => result.current.onChange(PICKED));
    expect(user().setProfileImage).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/couldn’t be read/);
    expect(result.current.busy).toBeNull();
  });

  it('Clerk refusing shows its message, or ours when it has none', async () => {
    m.user = clerkUser({ setProfileImage: vi.fn().mockRejectedValue(new Error('Too large')) });
    const { result, rerender } = renderHook(() => useProfilePhoto());
    await act(async () => result.current.onChange(PICKED));
    expect(result.current.error).toBe('Too large');
    expect(sync()).not.toHaveBeenCalled();
    m.user = clerkUser({ setProfileImage: vi.fn().mockRejectedValue({}) });
    rerender();
    await act(async () => result.current.onChange(PICKED));
    expect(result.current.error).toMatch(/wasn’t saved/);
  });

  it('removes the photo and nudges the mirror', async () => {
    const { result } = renderHook(() => useProfilePhoto());
    let gone = false;
    await act(async () => {
      gone = await result.current.onRemove();
    });
    expect(gone).toBe(true);
    expect(user().setProfileImage).toHaveBeenCalledWith({ file: null });
    expect(sync()).toHaveBeenCalledWith({});
    expect(result.current.busy).toBeNull();
  });

  it('a refused removal keeps the confirm open with the reason', async () => {
    m.user = clerkUser({ setProfileImage: vi.fn().mockRejectedValue(new Error('')) });
    const { result } = renderHook(() => useProfilePhoto());
    let gone = true;
    await act(async () => {
      gone = await result.current.onRemove();
    });
    expect(gone).toBe(false);
    expect(result.current.error).toMatch(/wasn’t removed/);
  });

  it('offline: says so, and calls nothing (Clerk would resolve without doing it)', async () => {
    m.online = false;
    const { result } = renderHook(() => useProfilePhoto());
    expect(result.current.offline).toBe(true);
    await act(async () => result.current.onChange(PICKED));
    let gone = true;
    await act(async () => {
      gone = await result.current.onRemove();
    });
    expect(gone).toBe(false);
    expect(m.process).not.toHaveBeenCalled();
    expect(user().setProfileImage).not.toHaveBeenCalled();
  });

  it('does nothing without a Clerk user', async () => {
    m.user = null;
    const { result } = renderHook(() => useProfilePhoto());
    await act(async () => result.current.onChange(PICKED));
    expect(await result.current.onRemove()).toBe(false);
    expect(m.process).not.toHaveBeenCalled();
  });

  it('ignores a second pick while one is going up', async () => {
    let finish: (f: File) => void = () => {};
    m.process.mockReturnValue(new Promise<File>((r) => (finish = r)));
    const { result } = renderHook(() => useProfilePhoto());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.onChange(PICKED);
    });
    await act(async () => result.current.onChange(PICKED));
    expect(await result.current.onRemove()).toBe(false);
    expect(m.process).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(SHRUNK);
      await first;
    });
    expect(user().setProfileImage).toHaveBeenCalledTimes(1);
  });
});
