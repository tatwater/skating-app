import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeThemes, nativeTokens } from '../../_generated/native';
import {
  camelCase,
  cssValue,
  emitCss,
  emitJson,
  emitNative,
  emitTailwind,
  generateAll,
  nativeValue,
  validateRegistry,
} from './emit';
import { themeMaps } from './maps';
import { registry, TAILWIND_DEFERRED, type TokenEntry, walkTokens } from './registry';
import { em, px, rem, UnitClassError } from './units';

const generatedDir = join(process.cwd(), '_generated');

/** Tailwind v4's own default theme variables and values, read from the installed package. */
function tailwindDefaults(): Map<string, string> {
  const pkg = createRequire(import.meta.url).resolve('tailwindcss/package.json');
  const css = readFileSync(join(dirname(pkg), 'theme.css'), 'utf8');
  const defaults = new Map<string, string>();
  for (const m of css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    defaults.set(m[1] as string, (m[2] as string).replace(/\s+/g, ' ').trim());
  }
  return defaults;
}

/** A copy of the registry with one entry swapped for a bad one. */
function withEntry(name: string, value: TokenEntry['value']): TokenEntry[] {
  return registry.map((e) => (e.name === name ? { ...e, value } : e));
}

describe('the generator', () => {
  it('is deterministic: the same source writes byte-identical output', () => {
    expect(generateAll()).toEqual(generateAll());
  });

  it.each(Object.keys(generateAll()))('the committed _generated/%s is current', (file) => {
    // If this fails, the token source changed without `pnpm --filter @skating/design generate`.
    expect(readFileSync(join(generatedDir, file), 'utf8')).toBe(generateAll()[file]);
  });

  it('carries no decision numbers or phase tokens in its output', () => {
    for (const [file, contents] of Object.entries(generateAll())) {
      expect(contents, file).not.toMatch(/\bD\d{1,3}\b|§|\b[AB]\d{2}\b/);
    }
  });
});

describe('the generator refuses a length in the wrong unit class', () => {
  it.each([
    [
      'font-size.row',
      { kind: 'length', length: px(13) },
      /font-size\.row is 13px, but fontSize must be rem/,
    ],
    ['size.btn', { kind: 'length', length: em(2) }, /size must be rem/],
    ['gap.gutter', { kind: 'length', length: px(20) }, /space must be rem/],
    ['radius.key', { kind: 'length', length: rem(2) }, /radius must be px/],
    ['border-width.hair', { kind: 'length', length: rem(0.0625) }, /border must be px/],
    ['letter-spacing.kick', { kind: 'length', length: px(2) }, /tracking must be em/],
    ['line-height.body', { kind: 'length', length: px(20) }, /leading must be ratio/],
    ['space.px', { kind: 'length', length: rem(0.0625) }, /nudge must be px/],
    ['breakpoint.phone', { kind: 'length', length: px(390) }, /breakpoint must be rem/],
  ] as const)('%s', (name, bad, message) => {
    const entries = withEntry(name, () => bad);
    expect(() => validateRegistry(entries)).toThrow(UnitClassError);
    expect(() => generateAll(entries)).toThrow(message);
    for (const emit of [emitCss, emitTailwind, emitNative, emitJson]) {
      expect(() => emit(entries)).toThrow(UnitClassError);
    }
  });

  it('a shadow in rem', () => {
    const entries = withEntry('shadow.plate', () => ({
      kind: 'shadow',
      layers: [{ x: px(0), y: rem(0.5), blur: px(24), spread: px(0), color: 'shade' }],
    }));
    expect(() => generateAll(entries)).toThrow(/shadows are px/);
  });

  it('a length in a group with no unit class', () => {
    const entries = withEntry('opacity.dim', () => ({ kind: 'length', length: px(1) }));
    expect(() => generateAll(entries)).toThrow(/in no unit class/);
  });

  it('and passes the real registry', () => {
    expect(() => validateRegistry()).not.toThrow();
  });
});

describe('the registry', () => {
  it('names every token once, with one CSS variable each', () => {
    const names = registry.map((e) => e.name);
    const vars = registry.map((e) => e.cssVar);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('walks every token in all four maps (the shape a Paper push iterates)', () => {
    const walked = [...walkTokens()];
    expect(walked).toHaveLength(registry.length * 4);
    expect(new Set(walked.map((w) => `${w.map.surface}/${w.map.mode}`)).size).toBe(4);
  });

  it('says truthfully which axis each token varies on', () => {
    const differs = (
      e: TokenEntry,
      a: keyof typeof themeMaps,
      am: 'dark' | 'light',
      b: keyof typeof themeMaps,
      bm: 'dark' | 'light',
    ) => cssValue(e.value(themeMaps[a][am])) !== cssValue(e.value(themeMaps[b][bm]));
    for (const e of registry) {
      const bySurface = differs(e, 'admin', 'dark', 'skater', 'dark');
      const byMode = differs(e, 'admin', 'dark', 'admin', 'light');
      if (e.varies === 'none') expect(bySurface || byMode, e.name).toBe(false);
      if (e.varies === 'surface') expect(byMode, e.name).toBe(false);
      if (e.varies === 'mode') expect(bySurface, e.name).toBe(false);
    }
    // Colors vary on both axes, and at least one shows it on each.
    const colors = registry.filter((e) => e.group === 'color');
    expect(colors.every((e) => e.varies === 'both')).toBe(true);
    expect(colors.some((e) => differs(e, 'admin', 'dark', 'skater', 'dark'))).toBe(true);
    expect(colors.some((e) => differs(e, 'skater', 'light', 'admin', 'light'))).toBe(true);
  });
});

describe('CSS output', () => {
  const css = emitCss();

  it('writes colors in oklch() and lengths in their unit class', () => {
    expect(css).toContain('--fg3: oklch(0.6066 0 0);');
    expect(css).toContain('--acc-wash: oklch(0.8012 0.1334 215.49 / 0.1);');
    expect(css).toContain('--type-row: 0.8125rem;');
    expect(css).toContain('--track-kick: 0.22em;');
    expect(css).toContain('--lead-body: 1.45;');
    expect(css).toContain('--stroke-hair: 1px;');
    expect(css).toContain(
      '--box-shadow-focus: 0px 0px 0px 3px var(--bg), 0px 0px 0px 4px var(--fg);',
    );
    expect(css).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it('has a block for each of the four maps, plus the defaults', () => {
    for (const surface of ['admin', 'skater']) {
      for (const mode of ['dark', 'light']) {
        expect(css).toContain(`:root[data-surface="${surface}"][data-mode="${mode}"] {`);
      }
    }
    expect(css).toContain(':root {');
    expect(css).toContain('@media (prefers-color-scheme: dark) {');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {');
    expect(css).toContain('--duration-base: 0ms;');
  });

  it('gives a surface stated without a mode its own palette, in either OS scheme', () => {
    const fg3 = (map: (typeof themeMaps)['admin']['dark']) =>
      cssValue({ kind: 'color', color: map.colors.fg3 });
    const blockOf = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(blockOf(':root[data-surface="admin"]')).toContain(
      `--fg3: ${fg3(themeMaps.admin.light)};`,
    );
    expect(blockOf(':root[data-surface="admin"]:not([data-mode])')).toContain(
      `--fg3: ${fg3(themeMaps.admin.dark)};`,
    );
    expect(blockOf(':root:not([data-mode])')).toContain(`--fg3: ${fg3(themeMaps.skater.dark)};`);
  });

  it('sets color-scheme only where a mode is stated', () => {
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}'));
    expect(rootBlock).not.toContain('color-scheme');
    expect(css).toContain('color-scheme: dark;');
  });

  it('formats every kind of value', () => {
    expect(cssValue({ kind: 'fontFamily', families: ['Martian Mono', 'monospace'] })).toBe(
      '"Martian Mono", monospace',
    );
    expect(cssValue({ kind: 'duration', ms: 120 })).toBe('120ms');
    expect(cssValue({ kind: 'easing', bezier: [0.2, 0, 0, 1] })).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(cssValue({ kind: 'number', number: 0.28 })).toBe('0.28');
  });
});

describe('Tailwind wiring', () => {
  const tw = emitTailwind();
  const defaults = tailwindDefaults();

  it('reads the varying tokens through var(), so utilities follow the root', () => {
    expect(tw).toContain('@theme inline {');
    expect(tw).toContain('--color-fg3: var(--fg3);');
    expect(tw).toContain('--text-row: var(--type-row);');
    expect(tw).toContain('--spacing-btn: var(--size-btn);');
    expect(tw).toContain('--spacing-gutter: var(--gap-gutter);');
    expect(tw).toContain('--shadow-focus: var(--box-shadow-focus);');
  });

  it('writes breakpoints as rem literals, which media queries need', () => {
    expect(tw).toContain('--breakpoint-phone: 24.375rem;');
    expect(tw).not.toContain('--breakpoint-phone: var(');
  });

  it('never redefines a Tailwind default to a different value', () => {
    const map = themeMaps.admin.dark;
    for (const e of registry) {
      if (!e.tailwindVar || !defaults.has(e.tailwindVar)) continue;
      expect(cssValue(e.value(map)), e.tailwindVar).toBe(defaults.get(e.tailwindVar));
    }
  });

  it('defers exactly the names that would have', () => {
    const map = themeMaps.admin.dark;
    const wouldCollide = registry
      .map(
        (e) =>
          [
            e,
            `--${{ 'line-height': 'leading', 'font-family': 'font' }[e.group] ?? ''}-${e.key}`,
          ] as const,
      )
      .filter(
        ([e, name]) =>
          !e.tailwindVar && defaults.has(name) && cssValue(e.value(map)) !== defaults.get(name),
      )
      .map(([, name]) => name);
    expect(new Set(wouldCollide)).toEqual(TAILWIND_DEFERRED);
  });

  it('keeps raw variables clear of every Tailwind theme name', () => {
    const tailwindNames = new Set([
      ...defaults.keys(),
      ...registry.flatMap((e) => e.tailwindVar ?? []),
    ]);
    expect(registry.filter((e) => tailwindNames.has(e.cssVar)).map((e) => e.cssVar)).toEqual([]);
  });
});

describe('React Native output', () => {
  it('emits colors as hex or rgba(), never oklch()', () => {
    const native = emitNative();
    expect(native).not.toContain('oklch(');
    for (const surface of Object.values(nativeThemes)) {
      for (const theme of Object.values(surface)) {
        for (const value of Object.values(theme.color)) {
          expect(value).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
        }
      }
    }
  });

  it('emits sizes as dp numbers and keeps tracking and leading as multipliers', () => {
    expect(nativeThemes.admin.dark.fontSize.row).toBe(13);
    expect(nativeThemes.skater.dark.fontSize.body).toBe(15);
    expect(nativeThemes.skater.light.size.btn).toBe(36);
    expect(nativeThemes.admin.dark.color.fg3).toBe('#828282');
    expect(nativeTokens.letterSpacing.kick).toBe(0.22);
    expect(nativeTokens.lineHeight.body).toBe(1.45);
    expect(nativeTokens.borderWidth.hair).toBe(1);
    expect(nativeTokens.space['4']).toBe(16);
  });

  it('gives each mode its own shadows, colored for React Native', () => {
    expect(nativeThemes.admin.dark.shadow.focus).toBe(
      '0px 0px 0px 3px #050505, 0px 0px 0px 4px #f7f7f7',
    );
    expect(nativeThemes.admin.dark.shadow.ring).toBe('inset 0px 0px 0px 1px #383838');
  });

  it('passes shared values through', () => {
    const map = themeMaps.admin.dark;
    expect(nativeValue({ kind: 'duration', ms: 200 }, map)).toBe(200);
    expect(nativeValue({ kind: 'easing', bezier: [0, 0, 0.2, 1] }, map)).toEqual([0, 0, 0.2, 1]);
    expect(camelCase('border-width')).toBe('borderWidth');
  });
});

describe('JSON output', () => {
  it('lists every token and its value in every map, with a hex form for colors', () => {
    const json = JSON.parse(emitJson()) as {
      tokens: { name: string }[];
      maps: Record<string, Record<string, { css: string; native?: string }>>;
    };
    expect(json.tokens).toHaveLength(registry.length);
    expect(Object.keys(json.maps)).toEqual([
      'admin/dark',
      'admin/light',
      'skater/dark',
      'skater/light',
    ]);
    expect(json.maps['admin/dark']?.['color.fg3']).toEqual({
      css: 'oklch(0.6066 0 0)',
      native: '#828282',
    });
    expect(json.maps['skater/dark']?.['font-size.body']).toEqual({ css: '0.9375rem' });
  });
});
