import { describe, expect, it } from 'vitest';
import config from '../../app.config';

/**
 * The manifest is where Google Play reads what the app may touch, so the photo rule (A10-8, D207)
 * is checked here rather than trusted: Android reads no photo library. A plugin added later that
 * declares one of these fails this, not a Play review.
 */
describe('the Android manifest', () => {
  it('blocks every photo-library read permission (Play media policy, D207)', () => {
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      ]),
    );
  });
});
