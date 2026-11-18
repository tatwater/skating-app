import { JPEG_EXIF_HEAD_BYTES, readJpegExif } from '@skating/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSharedPhotos } from './sharedPhotoFiles';

const { readBytes, close } = vi.hoisted(() => ({
  readBytes: vi.fn<(length: number) => Promise<Uint8Array>>(),
  close: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  File: class {
    open() {
      return { size: JPEG_EXIF_HEAD_BYTES * 2, readBytes, close };
    }
  },
}));

vi.mock('react-native', () => ({ Image: {} }));
vi.mock('@skating/core', async (load) => ({
  ...(await load<typeof import('@skating/core')>()),
  readJpegExif: vi.fn(),
}));

const jpeg = {
  fileName: 'photo.jpg',
  path: '/shared/photo.jpg',
  mimeType: 'image/jpeg',
  size: JPEG_EXIF_HEAD_BYTES * 2,
  width: 640,
  height: 480,
  duration: null,
};

describe('readSharedPhotos', () => {
  beforeEach(() => vi.resetAllMocks());

  it('waits for the bounded file read before closing and keeps the capture time', async () => {
    const bytes = Uint8Array.of(0xff, 0xd8);
    let finishRead!: (bytes: Uint8Array) => void;
    readBytes.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const exif = { DateTimeOriginal: '2026:01:15 12:00:00', OffsetTimeOriginal: '+00:00' };
    vi.mocked(readJpegExif).mockReturnValue(exif);

    const pending = readSharedPhotos([jpeg]);
    expect(readBytes).toHaveBeenCalledWith(JPEG_EXIF_HEAD_BYTES);
    expect(close).not.toHaveBeenCalled();
    finishRead(bytes);

    const takenAtMs = Date.UTC(2026, 0, 15, 12);
    expect(await pending).toEqual([
      {
        uri: 'file:///shared/photo.jpg',
        width: 640,
        height: 480,
        exif,
        takenAtMs,
        creationTime: takenAtMs,
      },
    ]);
    expect(readJpegExif).toHaveBeenCalledWith(bytes);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the handle after a rejected read and keeps the undated photo', async () => {
    readBytes.mockRejectedValue(new Error('Cannot read metadata'));

    expect(await readSharedPhotos([jpeg])).toEqual([
      { uri: 'file:///shared/photo.jpg', width: 640, height: 480, exif: null },
    ]);
    expect(readJpegExif).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
