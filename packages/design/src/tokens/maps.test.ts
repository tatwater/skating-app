import { describe, expect, it } from 'vitest';
import { WCAG_AA_LARGE, WCAG_AA_NORMAL } from '../contrast';
import { allThemeMaps, resolveColors, type ThemeMap, themeMaps } from './maps';
import {
  composite,
  contrastOfRgb,
  contrastOklch,
  inGamut,
  rgbToOklch,
  toHex,
  toRgb,
} from './oklch';
import {
  CONTRAST_EXEMPT,
  GROUNDS,
  type Ground,
  INK_KEEPS_OFF,
  isDataKey,
  MARK_KEEPS_OFF,
  NON_TEXT_PAIRS,
  PLATE_PAIRS,
  TEXT_PAIRS,
} from './pairs';
import { COLOR_KEYS, type ColorKey, type ColorSpec, colorSpecs } from './semantic';
import { FONT_SIZE_KEYS, GAP_KEYS, radius, SIZE_KEYS, SURFACE_RADIUS_KEYS } from './sizes';

const mapName = (m: ThemeMap) => `${m.surface} ${m.mode}`;

/**
 * Contrast of an ink over a ground as it renders: a translucent ground is composited over the
 * field, then a translucent ink over that.
 */
function contrastOn(map: ThemeMap, ink: ColorKey, ground: ColorKey): number {
  const groundRgb = composite(map.colors[ground], map.colors.bg);
  return contrastOfRgb(composite(map.colors[ink], rgbToOklch(groundRgb)), groundRgb);
}

describe('the four maps', () => {
  it('cover surface × mode', () => {
    expect(allThemeMaps.map(mapName)).toEqual([
      'admin dark',
      'admin light',
      'skater dark',
      'skater light',
    ]);
  });

  it.each(allThemeMaps.map((m) => [mapName(m), m] as const))(
    '%s resolves every key to an in-gamut color',
    (_name, map) => {
      expect(Object.keys(map.colors)).toEqual(COLOR_KEYS);
      expect(Object.keys(map.fontSize)).toEqual([...FONT_SIZE_KEYS]);
      expect(Object.keys(map.size)).toEqual([...SIZE_KEYS]);
      expect(Object.keys(map.gap)).toEqual([...GAP_KEYS]);
      expect(Object.keys(map.radius)).toEqual([...SURFACE_RADIUS_KEYS]);
      for (const [key, c] of Object.entries(map.colors)) expect(inGamut(c), key).toBe(true);
    },
  );

  it('share colors between surfaces and density between modes', () => {
    expect(themeMaps.skater.dark.colors).toBe(themeMaps.admin.dark.colors);
    expect(themeMaps.skater.light.colors).toBe(themeMaps.admin.light.colors);
    expect(themeMaps.admin.light.fontSize).toBe(themeMaps.admin.dark.fontSize);
    expect(themeMaps.skater.dark.size).not.toBe(themeMaps.admin.dark.size);
  });

  it('give the skater surface the larger reading sizes', () => {
    for (const key of ['kick', 'assist', 'row', 'body'] as const) {
      expect(themeMaps.skater.dark.fontSize[key].value).toBeGreaterThan(
        themeMaps.admin.dark.fontSize[key].value,
      );
    }
    expect(themeMaps.skater.dark.size.btn.value).toBeGreaterThan(
      themeMaps.admin.dark.size.btn.value,
    );
  });

  it('give the console one display size and the skater app two', () => {
    const { admin, skater } = themeMaps;
    expect(admin.dark.fontSize['disp-lg']).toEqual(admin.dark.fontSize.disp);
    expect(skater.dark.fontSize['disp-lg'].value).toBeGreaterThan(skater.dark.fontSize.disp.value);
  });
});

describe('radii: only what you can press is rounded', () => {
  it('rounds skater controls 2 px and keeps console controls square, in both modes', () => {
    for (const mode of ['dark', 'light'] as const) {
      expect(themeMaps.skater[mode].radius.control).toEqual({ unit: 'px', value: 2 });
      expect(themeMaps.admin[mode].radius.control).toEqual({ unit: 'px', value: 0 });
    }
  });

  it('keeps containers square and rounds keyboard hints like chiclet keys, on both surfaces', () => {
    expect(radius.container).toEqual({ unit: 'px', value: 0 });
    expect(radius.key).toEqual({ unit: 'px', value: 3 });
    expect(radius.full.value).toBeGreaterThan(1000); // people's circles and dots
  });
});

describe('the favorite star', () => {
  it('is the designed gold in each mode, the same on both surfaces', () => {
    for (const surface of ['admin', 'skater'] as const) {
      expect(toHex(themeMaps[surface].dark.colors.star)).toBe('#f3b71a');
      expect(toHex(themeMaps[surface].light.colors.star)).toBe('#a26b00');
    }
  });

  it('is held as a non-text mark, never paired where it is kept off', () => {
    const starGrounds = NON_TEXT_PAIRS.filter(([mark]) => mark === 'star').map(([, g]) => g);
    expect(starGrounds.length).toBeGreaterThan(0);
    for (const [mark, off] of Object.entries(MARK_KEEPS_OFF)) {
      const on = NON_TEXT_PAIRS.filter(([m]) => m === mark).map(([, g]) => g);
      expect(
        off.filter((g) => on.includes(g)),
        mark,
      ).toEqual([]);
    }
  });
});

describe('every color key is accounted for by the contrast rule', () => {
  it('as an ink, a ground, a plate pair, a non-text mark, exempt, or data', () => {
    const covered = new Set<string>([
      ...Object.keys(TEXT_PAIRS),
      ...GROUNDS,
      ...PLATE_PAIRS.flat(),
      ...NON_TEXT_PAIRS.map(([mark]) => mark),
      ...Object.keys(CONTRAST_EXEMPT),
    ]);
    const loose = COLOR_KEYS.filter((k) => !covered.has(k) && !isDataKey(k));
    expect(loose, `uncategorized: ${loose.join(', ')}`).toEqual([]);
  });

  it('never both pairs and keeps an ink off the same ground', () => {
    for (const [ink, off] of Object.entries(INK_KEEPS_OFF)) {
      const on = TEXT_PAIRS[ink as ColorKey] ?? [];
      expect(
        off.filter((g) => on.includes(g)),
        ink,
      ).toEqual([]);
    }
  });
});

describe.each(allThemeMaps.map((m) => [mapName(m), m] as const))('%s contrast', (_name, map) => {
  const textCases = Object.entries(TEXT_PAIRS).flatMap(([ink, grounds]) =>
    (grounds as readonly Ground[]).map((ground) => [ink as ColorKey, ground] as const),
  );

  it.each(textCases)('%s passes AA on %s', (ink, ground) => {
    expect(contrastOn(map, ink, ground)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it.each(PLATE_PAIRS)('%s passes AA on %s', (ink, plate) => {
    expect(contrastOklch(map.colors[ink], map.colors[plate])).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL,
    );
  });

  it.each(NON_TEXT_PAIRS)('%s (a non-text mark) holds 3:1 on %s', (mark, ground) => {
    expect(contrastOn(map, mark, ground)).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
  });

  it('keeps the ink ladder in order: fg > fg1 > fg2 > fg3 against the field', () => {
    const c = (k: ColorKey) => contrastOklch(map.colors[k], map.colors.bg);
    expect(c('fg')).toBeGreaterThan(c('fg1'));
    expect(c('fg1')).toBeGreaterThan(c('fg2'));
    expect(c('fg2')).toBeGreaterThan(c('fg3'));
  });

  it('keeps the grounds in order and close: bg, panel, raise, line, line2 step away from the field', () => {
    const steps = (['bg', 'panel', 'raise', 'line', 'line2'] as const).map((k) =>
      contrastOklch(map.colors[k], map.colors.bg),
    );
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i] as number).toBeGreaterThan(steps[i - 1] as number);
    }
    // Grounds recede: a panel sits within a hair of the field.
    expect(steps[1] as number).toBeLessThan(1.2);
  });
});

describe('the light maps are derived, not designed', () => {
  const dark = themeMaps.admin.dark.colors;
  const light = themeMaps.admin.light.colors;
  const darkAgainstField = (k: ColorKey) => contrastOklch(dark[k], dark.bg);
  const lightAgainstField = (k: ColorKey) => contrastOklch(light[k], light.bg);

  it('inverts the field: dark sits on void, light on w', () => {
    expect(toRgb(light.bg).r).toBeGreaterThan(0.9);
    expect(toRgb(dark.bg).r).toBeLessThan(0.05);
  });

  it('keeps each ground and ink at its dark contrast from the field, within a rounding hair', () => {
    for (const [key, spec] of Object.entries(colorSpecs) as [ColorKey, ColorSpec][]) {
      if (spec.role !== 'ground' && spec.role !== 'ink') continue;
      expect(lightAgainstField(key) / darkAgainstField(key), key).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(lightAgainstField(key) / darkAgainstField(key), key).toBeLessThan(1.01);
    }
  });

  it('keeps each accent hue and passes it at AA on its floor ground, no darker than needed', () => {
    for (const key of ['acc', 'warn', 'bad'] as const) {
      expect(light[key].h, key).toBe(dark[key].h);
      const onFloor = contrastOn(themeMaps.admin.light, key, 'lift-12');
      expect(onFloor, key).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      expect(onFloor, key).toBeLessThan(WCAG_AA_NORMAL * 1.02);
    }
  });

  it('keeps a matched overlay at its dark contrast from the field', () => {
    for (const [key, spec] of Object.entries(colorSpecs) as [ColorKey, ColorSpec][]) {
      if (spec.role !== 'overlay' || spec.light !== 'match') continue;
      if (spec.base && 'key' in spec.base) continue; // accent overlays follow a re-lit accent
      expect(lightAgainstField(key), key).toBeGreaterThanOrEqual(darkAgainstField(key) - 1e-9);
      expect(lightAgainstField(key) / darkAgainstField(key), key).toBeLessThan(1.01);
    }
  });

  it('keeps an overlay alpha as-is when told to', () => {
    expect(light.scrim.alpha).toBe(dark.scrim.alpha);
    expect(light.plate.alpha).toBe(dark.plate.alpha);
  });

  it('leaves the data scales alone, except bathymetry, which has its own light ramp', () => {
    expect(light['temp-cold-1']).toEqual(dark['temp-cold-1']);
    expect(light['depth-0']).not.toEqual(dark['depth-0']);
  });
});

describe('resolveColors refuses a broken spec', () => {
  it('on an unknown reference', () => {
    expect(() =>
      resolveColors('dark', {
        bg: { role: 'base', dark: 'void', light: 'w' },
        x: { role: 'alias', of: 'nope' },
      }),
    ).toThrow(/Unknown color key: nope/);
  });

  it('on a cycle', () => {
    expect(() =>
      resolveColors('dark', {
        bg: { role: 'base', dark: 'void', light: 'w' },
        a: { role: 'alias', of: 'b' },
        b: { role: 'alias', of: 'a' },
      }),
    ).toThrow(/Circular/);
  });

  it('without a field', () => {
    expect(() => resolveColors('light', { a: { role: 'ink', dark: 'w' } })).toThrow(/No base/);
  });

  it('on a light overlay keyed onto an unknown key or onto another overlay', () => {
    const bg = { role: 'base', dark: 'void', light: 'w' } as const;
    expect(() =>
      resolveColors('light', {
        bg,
        o: { role: 'overlay', base: { key: 'nope' }, alpha: 0.1, light: 'match' },
      }),
    ).toThrow(/Unknown color key/);
    expect(() =>
      resolveColors('light', {
        bg,
        a: { role: 'overlay', base: { dark: 'white', light: 'black' }, alpha: 0.1, light: 'keep' },
        o: { role: 'overlay', base: { key: 'a' }, alpha: 0.1, light: 'match' },
      }),
    ).toThrow(/itself an overlay/);
  });
});
