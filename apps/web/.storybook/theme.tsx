import * as tokens from '@skating/design/tokens';
import tokensCss from '@skating/design/tokens.css?raw';
import type { Decorator } from '@storybook/react-vite';
import type { ReactNode } from 'react';

/**
 * The bench's two theme axes (D232): the toolbar picks one surface × mode for the whole preview,
 * and the opt-in four-up renders a story in all four maps at once.
 */

export type Surface = tokens.Surface;
export type Mode = tokens.Mode;

const SURFACE_LABEL: Record<Surface, string> = { admin: 'Admin', skater: 'Skater' };
const MODE_LABEL: Record<Mode, string> = { dark: 'Dark', light: 'Light' };

/** The toolbar's two controls. Values come from the token source, so a new surface shows up here. */
export const themeGlobalTypes = {
  surface: {
    description: 'Surface — density and type scale',
    toolbar: {
      title: 'Surface',
      icon: 'browser',
      items: tokens.SURFACES.map((value) => ({ value, title: SURFACE_LABEL[value] })),
      dynamicTitle: true,
    },
  },
  mode: {
    description: 'Mode — dark or light',
    toolbar: {
      title: 'Mode',
      icon: 'contrast',
      items: tokens.MODES.map((value) => ({ value, title: MODE_LABEL[value] })),
      dynamicTitle: true,
    },
  },
};

export const initialThemeGlobals = { surface: 'admin', mode: 'dark' } satisfies {
  surface: Surface;
  mode: Mode;
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/**
 * The generated `tokens.css` resolves its maps on `:root` only — right for the app, where one
 * theme rules the page. The four-up needs four maps side by side, so the bench injects a second
 * copy with `:root` rewritten to `[data-theme-scope]`. Every rule keeps its relative specificity
 * (and so its cascade), and every token that references another (`--box-shadow-focus` reads
 * `--bg`) is re-declared inside the scope, so it resolves against the scope's own map.
 */
export const SCOPE_ATTR = 'data-theme-scope';
export const scopedTokensCss = (css: string): string => css.replaceAll(':root', `[${SCOPE_ATTR}]`);

function ensureScopedTokens(): void {
  if (document.querySelector('style[data-kit-scoped-tokens]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-kit-scoped-tokens', '');
  style.textContent = scopedTokensCss(tokensCss);
  document.head.append(style);
}

/** Every surface × mode, in reading order: admin dark, admin light, skater dark, skater light. */
export const FOUR_THEMES = tokens.SURFACES.flatMap((surface) =>
  tokens.MODES.map((mode) => ({ surface, mode })),
);

/** One story in all four maps, in a labeled 2 × 2 grid (one column at phone width). */
export function FourUp({ children }: { children: () => ReactNode }) {
  ensureScopedTokens();
  return (
    <div className="grid grid-cols-1 gap-px bg-line md:grid-cols-2" data-four-up="">
      {FOUR_THEMES.map(({ surface, mode }) => (
        <section
          key={`${surface}-${mode}`}
          {...{ [SCOPE_ATTR]: '' }}
          data-surface={surface}
          data-mode={mode}
          aria-label={`${SURFACE_LABEL[surface]} ${MODE_LABEL[mode].toLowerCase()}`}
          className="flex min-w-0 flex-col gap-heading bg-bg p-gutter font-(family-name:--family-sans) text-fg"
        >
          <h2 className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
            {SURFACE_LABEL[surface]} · {MODE_LABEL[mode]}
          </h2>
          <div>{children()}</div>
        </section>
      ))}
    </div>
  );
}

/**
 * Sets the toolbar's theme on the preview root (where `tokens.css` resolves it) and, for a story
 * with `parameters: { fourUp: true }`, renders the four-up instead. The legacy `.dark` class
 * follows the mode too, so a pre-kit component in a story isn't stuck in the light theme.
 */
export const withTheme: Decorator = (Story, context) => {
  const surface = pick(context.globals.surface, tokens.SURFACES, initialThemeGlobals.surface);
  const mode = pick(context.globals.mode, tokens.MODES, initialThemeGlobals.mode);
  const root = document.documentElement;
  root.setAttribute('data-surface', surface);
  root.setAttribute('data-mode', mode);
  root.classList.toggle('dark', mode === 'dark');
  if (context.parameters.fourUp) return <FourUp>{() => <Story />}</FourUp>;
  return <Story />;
};
