import { describe, expect, it } from 'vitest';
import { OFFLINE_PMTILES_FILENAME, resolveBasemapSource } from './offlineBasemap';

const REMOTE = 'https://cdn.example.com/northeast.pmtiles';
const LOCAL = `file:///data/user/0/app/Documents/${OFFLINE_PMTILES_FILENAME}`;

describe('resolveBasemapSource', () => {
  it('uses the remote URL until the local archive is ready', () => {
    expect(resolveBasemapSource({ remoteUrl: REMOTE, localUri: LOCAL, localReady: false })).toBe(
      REMOTE,
    );
  });

  it('prefers the on-device archive once it is downloaded (renders with no signal)', () => {
    expect(resolveBasemapSource({ remoteUrl: REMOTE, localUri: LOCAL, localReady: true })).toBe(
      LOCAL,
    );
  });

  it('falls back to the remote URL when ready is claimed but no local uri exists', () => {
    expect(resolveBasemapSource({ remoteUrl: REMOTE, localUri: null, localReady: true })).toBe(
      REMOTE,
    );
  });
});
