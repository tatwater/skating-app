import { nativeThemes } from '@skating/design/native';
import { describe, expect, it } from 'vitest';

import { adminToken, type BodyMapMode } from './bodyMapPalette';
import { mapInkMode, mapInkStyle } from './mapInks';

const MODES: readonly BodyMapMode[] = ['dark', 'light'];

describe('the map’s ink mode', () => {
  it('is the dark map’s over the summer aerial, in either theme', () => {
    for (const mode of MODES) expect(mapInkMode(mode, true)).toBe('dark');
  });

  it('is the page’s own with the aerial off', () => {
    for (const mode of MODES) expect(mapInkMode(mode, false)).toBe(mode);
  });
});

describe('the inks the browser draws on the map', () => {
  it('re-declare every dark-map color token over the summer aerial, the alias of the earth too', () => {
    const style = mapInkStyle(true) as Record<string, string>;
    for (const [name, value] of Object.entries(nativeThemes.admin.dark.color)) {
      expect(style[`--${name}`]).toBe(value);
    }
    expect(style['--fg2']).toBe(adminToken('dark', 'fg2'));
    expect(style['--map-ground']).toBe(adminToken('dark', 'map-earth'));
    expect(style.colorScheme).toBe('dark');
  });

  it('take nothing of their own with the aerial off: the page’s tokens stand', () => {
    expect(mapInkStyle(false)).toBeUndefined();
  });

  it('follow the same rule as the canvas: a scope wherever the ink mode leaves the page’s', () => {
    for (const mode of MODES)
      for (const on of [true, false]) {
        const scoped = mapInkStyle(on) !== undefined;
        // Scoped exactly when on; and never left unscoped where the canvas went dark.
        expect(scoped).toBe(on);
        if (mapInkMode(mode, on) !== mode) expect(scoped).toBe(true);
      }
  });
});
