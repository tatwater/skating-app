import { describe, expect, it, vi } from 'vitest';
import { config } from './tamagui.config';

vi.mock('react-native', () => ({
  Platform: { select: (options: { android: string }) => options.android },
}));

describe('mobile Tamagui config', () => {
  it('initializes with the shared corner radii under valid token names', () => {
    expect(config.tokens.radius).toMatchObject({
      square: { val: 0 },
      xs: { val: 2 },
      full: { val: 9999 },
    });
    expect(config.tokens.radius).not.toHaveProperty('none');
  });

  it('resolves the input skin’s named font sizes to the v5 body scale', () => {
    expect(config.fontsParsed.body?.size).toMatchObject({
      xs: { val: 12 },
      sm: { val: 14 },
      base: { val: 15 },
      lg: { val: 16 },
    });
  });
});
