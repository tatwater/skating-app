import { act, renderHook, waitFor } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('convex/react', () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    let fn = fakes.mutations.get(name);
    if (!fn) {
      fn = vi.fn();
      fakes.mutations.set(name, fn);
    }
    return fn;
  },
}));
vi.mock('./photoPipeline', () => ({
  processPhoto: async (file: File) => ({ full: file, thumb: file }),
  uploadToStorage: async (_url: string, file: File) => `blob-${file.name}`,
}));

import { usePhotoDrafts } from './usePhotoDrafts';

let rows = 0;
beforeEach(() => {
  rows = 0;
  fakes.mutations.clear();
  fakes.mutations.set('photos:generateUploadUrl', vi.fn().mockResolvedValue('https://upload'));
  fakes.mutations.set(
    'photos:create',
    vi.fn().mockImplementation(async () => `photo${++rows}`),
  );
  fakes.mutations.set('photos:remove', vi.fn().mockResolvedValue(null));
  fakes.mutations.set('photos:removeBlob', vi.fn().mockResolvedValue(null));
  // jsdom has no object URLs; the file runs isolated, so setting them outright is enough.
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
});

const files = (...names: string[]) => names.map((n) => new File([n], n, { type: 'image/jpeg' }));

describe('usePhotoDrafts.release', () => {
  it('hands attached photos over without deleting them, and leaves the rest reclaimable', async () => {
    const { result, unmount } = renderHook(() => usePhotoDrafts());
    await act(() => result.current.addFiles(files('a.jpg', 'b.jpg')));
    expect(result.current.photos).toHaveLength(2);
    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.uploadAll();
    });
    expect(ids).toEqual(['photo1', 'photo2']);

    // photo1 attached; photo2's attach never landed.
    act(() => result.current.release(['photo1' as never]));
    await waitFor(() => expect(result.current.photos).toHaveLength(1));
    expect(fakes.mutations.get('photos:remove')).not.toHaveBeenCalled();
    expect(fakes.mutations.get('photos:removeBlob')).not.toHaveBeenCalled();

    // Abandoning the form reclaims only the photo nothing holds.
    unmount();
    expect(fakes.mutations.get('photos:remove')).toHaveBeenCalledTimes(1);
    expect(fakes.mutations.get('photos:remove')).toHaveBeenCalledWith({ photoId: 'photo2' });
  });

  it('ignores ids no draft holds, and drafts not yet uploaded', async () => {
    const { result } = renderHook(() => usePhotoDrafts());
    await act(() => result.current.addFiles(files('a.jpg')));
    act(() => result.current.release(['photo9' as never]));
    expect(result.current.photos).toHaveLength(1);
  });

  it('removing a draft (unlike releasing it) still reclaims its upload', async () => {
    const { result } = renderHook(() => usePhotoDrafts());
    await act(() => result.current.addFiles(files('a.jpg')));
    await act(async () => {
      await result.current.uploadAll();
    });
    const draft = result.current.photos[0]?.id ?? '';
    act(() => result.current.removePhoto(draft));
    expect(result.current.photos).toHaveLength(0);
    expect(fakes.mutations.get('photos:remove')).toHaveBeenCalledWith({ photoId: 'photo1' });
  });
});
