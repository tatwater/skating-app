import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleHalfStroke, faMoon, faSun } from '@fortawesome/sharp-light-svg-icons';
import { isThemePreference, nextThemePreference, type ThemePreference } from '@skating/design';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';

/** What each preference shows and announces. Icon = the state you're *in*, not the next one. */
const PREFERENCE_UI: Record<ThemePreference, { icon: typeof faSun; label: string }> = {
  system: { icon: faCircleHalfStroke, label: 'following your system theme' },
  light: { icon: faSun, label: 'light theme' },
  dark: { icon: faMoon, label: 'dark theme' },
};

/**
 * Theme control (D34 amendment). `next-themes` can't know the stored preference on the server, so
 * everything this button *renders* — the icon and the label that names the state — waits for mount
 * and shows `'system'` until then. That is the whole hydration contract here: `next-themes` reads
 * localStorage inside a state initializer, so the client's very first render already knows the
 * stored preference while the server's render did not. Deriving the `aria-label` from it unguarded
 * would be a hydration mismatch on an attribute — the same defect the icon placeholder exists to
 * avoid, just quieter.
 *
 * The *click* reads the stored preference directly, unguarded: a press landing in the frame before
 * the mount effect flushes must still advance from where the user actually is.
 *
 * This cycles **system → light → dark → system** rather than flipping between light and dark. The
 * two-state version could never get back to `'system'`: that's where everyone starts, but the first
 * click ever made wrote an explicit choice to localStorage and nothing in the UI could undo it — so
 * "follow my OS" was a setting you could only lose. Mobile's You-page picker shows the same three
 * options laid out flat, which a settings page has room for and a navbar doesn't.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // `theme` (the stored preference), not `resolvedTheme` (what's rendered) — this button now has a
  // third state that `resolvedTheme` collapses away, since `'system'` reports as light or dark.
  const stored: ThemePreference = isThemePreference(theme) ? theme : 'system';
  const shown: ThemePreference = mounted ? stored : 'system';
  const next = nextThemePreference(shown);

  return (
    <Button
      variant="ghost"
      size="icon"
      // Names the current state and the outcome of clicking: an icon-only control that cycles is
      // otherwise unguessable, and to a screen reader "Toggle color theme" was a button whose
      // effect you had to press it to learn.
      aria-label={`Theme: ${PREFERENCE_UI[shown].label}. Switch to ${PREFERENCE_UI[next].label}.`}
      title={`Theme: ${PREFERENCE_UI[shown].label}`}
      onClick={() => setTheme(nextThemePreference(stored))}
    >
      {mounted ? (
        <FontAwesomeIcon icon={PREFERENCE_UI[shown].icon} className="h-4 w-4" />
      ) : (
        <span className="h-4 w-4" />
      )}
    </Button>
  );
}
