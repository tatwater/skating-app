import { THEME_NAMES, themes } from '@skating/design';
import { describe, expect, it } from 'vitest';
import { CLERK_APPEARANCE } from './clerkAppearance';

/**
 * Clerk's card is the one surface in the app whose palette is passed as a *prop* rather than read
 * from CSS, so nothing else notices when it drifts: it just quietly renders Clerk's defaults again.
 * These tests are the alarm, in the spirit of `styles/app.test.ts`.
 */
describe('CLERK_APPEARANCE', () => {
  it('covers every theme', () => {
    for (const name of THEME_NAMES) expect(CLERK_APPEARANCE[name]).toBeDefined();
  });

  it('sources every color from the design tokens, never a literal', () => {
    // The actual regression this guards: someone hand-picks a hex that looks right in one theme.
    for (const name of THEME_NAMES) {
      const allowed = new Set<string>(Object.values(themes[name]));
      const colors = Object.entries(CLERK_APPEARANCE[name].variables).filter(([key]) =>
        key.startsWith('color'),
      );
      expect(colors.length).toBeGreaterThan(0);
      for (const [key, value] of colors) {
        expect(allowed, `${name}.${key} = ${value} is not a @skating/design token`).toContain(
          value,
        );
      }
    }
  });

  it('actually differs between light and dark', () => {
    // A mapping that resolved to the same palette twice would typecheck, pass the test above, and
    // still leave the card looking identical in both themes — the bug being fixed here.
    expect(CLERK_APPEARANCE.light.variables.colorBackground).not.toBe(
      CLERK_APPEARANCE.dark.variables.colorBackground,
    );
    expect(CLERK_APPEARANCE.light.variables.colorForeground).not.toBe(
      CLERK_APPEARANCE.dark.variables.colorForeground,
    );
  });

  it('keeps the legacy aliases in step with their current names', () => {
    // Clerk has been migrating between the two naming sets; they must never disagree, or which one
    // a given Clerk version reads decides how the card looks.
    for (const name of THEME_NAMES) {
      const v = CLERK_APPEARANCE[name].variables;
      expect(v.colorText).toBe(v.colorForeground);
      expect(v.colorTextSecondary).toBe(v.colorMutedForeground);
      expect(v.colorInputText).toBe(v.colorInputForeground);
      expect(v.colorInputBackground).toBe(v.colorInput);
      expect(v.colorTextOnPrimaryBackground).toBe(v.colorPrimaryForeground);
    }
  });

  it('seeds Clerk alpha shades with a shade that inverts with the theme', () => {
    // `colorNeutral` is where Clerk mixes every hover/divider/disabled shade from, and its default
    // is a flat `'black'`. A dark card needs a *light* seed or its hover states are black on
    // near-black — invisible, and invisible in a way nothing else in the app would reveal.
    expect(CLERK_APPEARANCE.light.variables.colorNeutral).toBe(themes.light.foreground);
    expect(CLERK_APPEARANCE.dark.variables.colorNeutral).toBe(themes.dark.foreground);
    expect(CLERK_APPEARANCE.light.variables.colorNeutral).not.toBe(
      CLERK_APPEARANCE.dark.variables.colorNeutral,
    );
  });

  it('keeps the modal backdrop dark in both themes', () => {
    // The one variable that must NOT flip: Clerk derives the backdrop from `colorNeutral` at 73%,
    // so leaving it alone would have put a white sheet over the app in dark mode.
    expect(CLERK_APPEARANCE.dark.variables.colorModalBackdrop).toBe(
      CLERK_APPEARANCE.light.variables.colorModalBackdrop,
    );
    expect(CLERK_APPEARANCE.light.variables.colorModalBackdrop).toBe(themes.light.foreground);
  });

  it('puts readable text on the card and on the primary button', () => {
    // Cheap sanity check that the two most important pairings aren't inverted — the palette's real
    // contrast bar is enforced in `@skating/design`'s themes.test.ts.
    for (const name of THEME_NAMES) {
      const v = CLERK_APPEARANCE[name].variables;
      expect(v.colorForeground).toBe(themes[name].foreground);
      expect(v.colorBackground).toBe(themes[name].surface);
      expect(v.colorPrimaryForeground).toBe(themes[name].primaryForeground);
    }
  });
});
