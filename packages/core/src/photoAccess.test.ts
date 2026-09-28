import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canReadLibrary,
  type LibraryPermission,
  libraryAccess,
  readsPhotoLibrary,
} from './photoAccess';

const perm = (p: Partial<LibraryPermission> = {}): LibraryPermission => ({
  status: 'undetermined',
  canAskAgain: true,
  ...p,
});

describe('libraryAccess', () => {
  it('never reads the library on Android, whatever an older build was granted', () => {
    const permission = fc.record({
      status: fc.constantFrom('granted', 'denied', 'undetermined') as fc.Arbitrary<
        LibraryPermission['status']
      >,
      canAskAgain: fc.boolean(),
      accessPrivileges: fc.constantFrom('all', 'limited', 'none', undefined) as fc.Arbitrary<
        LibraryPermission['accessPrivileges']
      >,
    });
    fc.assert(
      fc.property(permission, fc.constantFrom('android', 'web', 'windows'), (p, platform) => {
        expect(libraryAccess(platform, p)).toBe('none');
      }),
    );
  });

  it('reads the whole library on iOS when it was granted', () => {
    expect(libraryAccess('ios', perm({ status: 'granted', accessPrivileges: 'all' }))).toBe('all');
    expect(libraryAccess('ios', perm({ status: 'granted' }))).toBe('all');
  });

  it('reads what was shared when access is limited', () => {
    expect(libraryAccess('ios', perm({ status: 'granted', accessPrivileges: 'limited' }))).toBe(
      'limited',
    );
  });

  it('offers a button before the first ask, and after a decline that can be asked again', () => {
    expect(libraryAccess('ios', perm())).toBe('ask');
    expect(libraryAccess('ios', perm({ status: 'undetermined', canAskAgain: false }))).toBe('ask');
    expect(libraryAccess('ios', perm({ status: 'denied', canAskAgain: true }))).toBe('ask');
  });

  it('sends a final decline to Settings', () => {
    expect(libraryAccess('ios', perm({ status: 'denied', canAskAgain: false }))).toBe('settings');
  });
});

describe('canReadLibrary', () => {
  it('reads only with a grant in hand', () => {
    expect(canReadLibrary('all')).toBe(true);
    expect(canReadLibrary('limited')).toBe(true);
    expect(canReadLibrary('ask')).toBe(false);
    expect(canReadLibrary('settings')).toBe(false);
    expect(canReadLibrary('none')).toBe(false);
  });
});

describe('readsPhotoLibrary', () => {
  it('is iOS only (D207)', () => {
    expect(readsPhotoLibrary('ios')).toBe(true);
    expect(readsPhotoLibrary('android')).toBe(false);
  });
});
