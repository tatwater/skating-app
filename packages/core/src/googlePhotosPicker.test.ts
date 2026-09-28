import { describe, expect, it } from 'vitest';
import {
  autoclosePickerUri,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  googleDurationMs,
  googlePhotosAuthorizeUrl,
  grantsPickerScope,
  isGoogleMediaUrl,
  PICKER_POLL_FALLBACK_MS,
  readPickedPhotos,
  readPickerSession,
  sizedBaseUrl,
} from './googlePhotosPicker';

const NOW = Date.parse('2026-09-28T12:00:00Z');

describe('googlePhotosAuthorizeUrl', () => {
  it('asks for the one scope, online, with the state', () => {
    const url = new URL(
      googlePhotosAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://x.convex.site/google-photos/callback',
        state: 's1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_PHOTOS_PICKER_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://x.convex.site/google-photos/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('grantsPickerScope', () => {
  it('reads a space-separated grant', () => {
    expect(grantsPickerScope(`openid ${GOOGLE_PHOTOS_PICKER_SCOPE}`)).toBe(true);
    expect(grantsPickerScope('openid email')).toBe(false);
    expect(grantsPickerScope(undefined)).toBe(false);
  });
});

describe('googleDurationMs', () => {
  it('reads seconds, fractional too', () => {
    expect(googleDurationMs('5s', 1)).toBe(5000);
    expect(googleDurationMs('3.5s', 1)).toBe(3500);
    expect(googleDurationMs(' 1800s ', 1)).toBe(1_800_000);
  });

  it('falls back on anything else, never polling at zero', () => {
    expect(googleDurationMs('0s', 7)).toBe(7);
    expect(googleDurationMs('5m', 7)).toBe(7);
    expect(googleDurationMs(5, 7)).toBe(7);
    expect(googleDurationMs(undefined, 7)).toBe(7);
  });
});

describe('readPickerSession', () => {
  it('reads a created session', () => {
    expect(
      readPickerSession(
        {
          id: 'sess',
          pickerUri: 'https://photos.google.com/picker/abc',
          pollingConfig: { pollInterval: '4s', timeoutIn: '1800s' },
          expireTime: '2026-09-28T12:30:00Z',
        },
        NOW,
      ),
    ).toEqual({
      id: 'sess',
      pickerUri: 'https://photos.google.com/picker/abc',
      pollIntervalMs: 4000,
      expiresAtMs: Date.parse('2026-09-28T12:30:00Z'),
      mediaItemsSet: false,
    });
  });

  it('falls back to the timeout without an expiry, and to the default poll', () => {
    const s = readPickerSession(
      {
        id: 'sess',
        pickerUri: 'https://photos.google.com/picker/abc',
        pollingConfig: { timeoutIn: '600s' },
        mediaItemsSet: true,
      },
      NOW,
    );
    expect(s?.expiresAtMs).toBe(NOW + 600_000);
    expect(s?.pollIntervalMs).toBe(PICKER_POLL_FALLBACK_MS);
    expect(s?.mediaItemsSet).toBe(true);
    expect(readPickerSession({ id: 'sess', pickerUri: 'https://p/x' }, NOW)?.expiresAtMs).toBe(
      NOW + 30 * 60_000,
    );
  });

  it('refuses what is not a session, or a picker that is not https', () => {
    expect(readPickerSession(null, NOW)).toBeNull();
    expect(readPickerSession({ id: 'x' }, NOW)).toBeNull();
    expect(readPickerSession({ id: 'x', pickerUri: 'http://photos.google.com/p' }, NOW)).toBeNull();
    expect(readPickerSession({ id: 'x', pickerUri: 'javascript:alert(1)' }, NOW)).toBeNull();
  });
});

describe('autoclosePickerUri', () => {
  it('appends the suffix once', () => {
    expect(autoclosePickerUri('https://photos.google.com/picker/abc')).toBe(
      'https://photos.google.com/picker/abc/autoclose',
    );
    expect(autoclosePickerUri('https://photos.google.com/picker/abc/')).toBe(
      'https://photos.google.com/picker/abc/autoclose',
    );
  });
});

describe('readPickedPhotos', () => {
  const photo = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'PHOTO',
    createTime: '2026-01-10T19:10:00Z',
    mediaFile: {
      baseUrl: `https://lh3.googleusercontent.com/${id}`,
      mimeType: 'image/jpeg',
      filename: `${id}.jpg`,
    },
    ...extra,
  });

  it('reads photos with their capture time', () => {
    const { photos, nextPageToken } = readPickedPhotos({
      mediaItems: [photo('a')],
      nextPageToken: 'next',
    });
    expect(photos).toEqual([
      {
        id: 'a',
        takenAtMs: Date.parse('2026-01-10T19:10:00Z'),
        baseUrl: 'https://lh3.googleusercontent.com/a',
        mimeType: 'image/jpeg',
        filename: 'a.jpg',
      },
    ]);
    expect(nextPageToken).toBe('next');
  });

  it('keeps photos only, and only from a Google media host', () => {
    const { photos } = readPickedPhotos({
      mediaItems: [
        photo('video', { type: 'VIDEO' }),
        photo('elsewhere', {
          mediaFile: { baseUrl: 'https://evil.example/x', mimeType: 'image/jpeg' },
        }),
        photo('plain', {
          mediaFile: { baseUrl: 'http://lh3.googleusercontent.com/x', mimeType: 'image/jpeg' },
        }),
        { type: 'PHOTO' },
        null,
        photo('ok'),
      ],
    });
    expect(photos.map((p) => p.id)).toEqual(['ok']);
  });

  it('defaults what Google leaves out, and drops an unreadable time', () => {
    const { photos } = readPickedPhotos({
      mediaItems: [
        {
          id: 'bare',
          type: 'PHOTO',
          createTime: 'yesterday',
          mediaFile: { baseUrl: 'https://lh3.googleusercontent.com/bare' },
        },
      ],
    });
    expect(photos).toEqual([
      {
        id: 'bare',
        baseUrl: 'https://lh3.googleusercontent.com/bare',
        mimeType: 'image/jpeg',
        filename: 'bare.jpg',
      },
    ]);
  });

  it('reads nothing from nothing', () => {
    expect(readPickedPhotos(undefined)).toEqual({ photos: [] });
    expect(readPickedPhotos({ mediaItems: 'no' })).toEqual({ photos: [] });
  });
});

describe('isGoogleMediaUrl / sizedBaseUrl', () => {
  it('trusts only https on a googleusercontent host', () => {
    expect(isGoogleMediaUrl('https://lh3.googleusercontent.com/x')).toBe(true);
    expect(isGoogleMediaUrl('https://googleusercontent.com.evil.example/x')).toBe(false);
    expect(isGoogleMediaUrl('not a url')).toBe(false);
  });

  it('asks Google for the full edge', () => {
    expect(sizedBaseUrl('https://lh3.googleusercontent.com/x', 2048)).toBe(
      'https://lh3.googleusercontent.com/x=w2048-h2048',
    );
  });
});
