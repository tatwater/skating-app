/**
 * Clerk `appearance` bound to our themes (D34 amendment).
 *
 * Clerk's prebuilt `<SignIn>`/`<SignUp>` shipped with no appearance config at all, which meant they
 * rendered in Clerk's default light styling on both themes — a white card floating on the `#0b1016`
 * backdrop that the page around it correctly flipped to.
 *
 * **Why variables and not `@clerk/themes`' `baseTheme: dark`.** The obvious fix is that package, but
 * it depends on `@clerk/shared@^3` while this app pins `^4` locally precisely so the Vite build
 * stops resolving the hoisted v3 (the workspace runs two Clerk major versions side by side for
 * mobile's sake). Adding it would walk that conflict straight back in. Driving the documented
 * `appearance.variables` instead needs no new dependency — and it's the better result anyway, since
 * Clerk derives its scales from *our* palette rather than approximating it with a generic dark theme.
 *
 * Clerk derives hover/active/disabled shades from these seeds, so only the seeds are set here; every
 * value is a `@skating/design` token, which is what keeps the card's contrast inside the WCAG AA
 * bar that `themes.test.ts` already holds the palette to.
 */

import { type Theme as DesignTheme, neutral, type ThemeName, themes } from '@skating/design';

/** `--radius` in `app.css` is `0.5rem`; Clerk takes a CSS length, so this is the one literal. */
const BORDER_RADIUS = '0.5rem';

/**
 * The scrim behind a Clerk modal — the same near-black in both themes, and the one variable here
 * that deliberately does *not* flip.
 *
 * Clerk defaults this to `colorNeutral` at 73%, and `colorNeutral` has to be a *light* shade on a
 * dark card (see below). Left derived, the dark theme's backdrop would have come out a white sheet
 * laid over the app. A backdrop's job is to darken what's behind it, which is the same job in both
 * themes. `neutral[950]` is a token of both palettes (`light.foreground` / `dark.background`), so
 * this stays inside the "never a literal" bar the tests hold.
 */
const MODAL_BACKDROP = neutral[950];

/**
 * Map one resolved theme onto Clerk's variables.
 *
 * Both the current names (`colorForeground`, `colorMuted`, `colorInput`, …) and the legacy aliases
 * (`colorText`, `colorTextSecondary`, `colorInputText`, `colorInputBackground`) are set. They're the
 * same values, and Clerk has been migrating between the two sets across minor versions — writing
 * both means a bump can't silently drop half the card back to default styling.
 */
function variablesFor(theme: DesignTheme) {
  return {
    colorPrimary: theme.primary,
    colorPrimaryForeground: theme.primaryForeground,
    colorTextOnPrimaryBackground: theme.primaryForeground,

    colorBackground: theme.surface,
    colorForeground: theme.foreground,
    colorText: theme.foreground,
    colorMutedForeground: theme.foregroundMuted,
    colorTextSecondary: theme.foregroundMuted,
    colorMuted: theme.surfaceMuted,

    // Inputs sit on the card, so they take the recessed fill rather than the card's own.
    colorInput: theme.surfaceMuted,
    colorInputBackground: theme.surfaceMuted,
    colorInputForeground: theme.foreground,
    colorInputText: theme.foreground,

    colorBorder: theme.border,
    colorRing: theme.ring,
    colorShimmer: theme.surfaceMuted,

    /**
     * The seed Clerk mixes every *alpha* shade from — hovered rows, hovered dropdown options,
     * dividers, disabled text. It is the one variable that must be a light shade on the dark card
     * and a dark shade on the light one, and its default is a flat `'black'`: unset, every hover
     * state on the dark card was black-on-near-black, i.e. no hover state at all.
     */
    colorNeutral: theme.foreground,
    colorModalBackdrop: MODAL_BACKDROP,

    colorDanger: theme.danger,
    colorSuccess: theme.success,
    colorWarning: theme.warning,

    borderRadius: BORDER_RADIUS,
  };
}

/**
 * Pre-built per theme rather than per render: the object is a prop on a Clerk component, and a fresh
 * identity every render would have it re-computing its derived scales for no reason.
 */
export const CLERK_APPEARANCE: Record<ThemeName, { variables: ReturnType<typeof variablesFor> }> = {
  light: { variables: variablesFor(themes.light) },
  dark: { variables: variablesFor(themes.dark) },
};
