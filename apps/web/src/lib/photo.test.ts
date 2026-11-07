import { describe, expect, it } from 'vitest';
import { AVATAR_ACCEPT, isAvatarImage, isHeic } from './photo';

describe('isHeic', () => {
  it('detects HEIC/HEIF by MIME type', () => {
    expect(isHeic({ type: 'image/heic', name: 'IMG_0001' })).toBe(true);
    expect(isHeic({ type: 'image/heif', name: 'x' })).toBe(true);
  });

  it('detects by extension when the type is blank/generic', () => {
    expect(isHeic({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(isHeic({ type: 'application/octet-stream', name: 'photo.heif' })).toBe(true);
  });

  it('is false for JPEG/PNG', () => {
    expect(isHeic({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(false);
    expect(isHeic({ type: 'image/png', name: 'photo.png' })).toBe(false);
  });
});

describe('isAvatarImage', () => {
  it('takes JPEG, PNG, WebP and HEIC by type', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'IMAGE/HEIF']) {
      expect(isAvatarImage({ type, name: 'x' })).toBe(true);
    }
  });

  it('refuses other types, even with a photo-like name', () => {
    expect(isAvatarImage({ type: 'image/gif', name: 'x.gif' })).toBe(false);
    expect(isAvatarImage({ type: 'application/pdf', name: 'me.jpg' })).toBe(false);
    expect(isAvatarImage({ type: 'image/svg+xml', name: 'x.svg' })).toBe(false);
  });

  it('falls back to the extension when the type is blank or generic', () => {
    expect(isAvatarImage({ type: '', name: 'me.JPEG' })).toBe(true);
    expect(isAvatarImage({ type: 'application/octet-stream', name: 'me.webp' })).toBe(true);
    expect(isAvatarImage({ type: '', name: 'IMG_0001.heic' })).toBe(true);
    expect(isAvatarImage({ type: '', name: 'notes.txt' })).toBe(false);
  });

  it('offers every format it takes in the picker', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', '.heic']) {
      expect(AVATAR_ACCEPT.split(',')).toContain(t);
    }
  });
});
