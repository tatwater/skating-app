import { isThemePreference, type ThemePreference } from '@skating/design';

import { ACCOUNT_WORDS } from '@/lib/account';
import { cn } from '@/lib/utils';

import { ToggleGroup, ToggleGroupItem } from './toggle-group';

/**
 * The theme picker (both surfaces): System · Light · Dark as the kit's joined segments, the chosen
 * one filled — the skater app's avatar menu (board 3.24's Theme row) and phone sheet (9.5), and the
 * console's own menu at the rail's foot. Props only: the caller hands it the stored preference and
 * a setter (`useThemeChoice`, which writes the cookie and records `theme_changed`), so there is one
 * picker and one remembered preference for both surfaces. The theme lives in an account menu, never
 * in a top bar.
 *
 * Inside a menu, ↓ reaches the menu's rows and Tab reaches the segments; ←→ move between them.
 */
export interface ThemePickerProps {
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
  className?: string;
}

/** The three choices, in the order they read, with their words. */
export const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemePicker({ value, onValueChange, className }: ThemePickerProps) {
  return (
    <ToggleGroup
      aria-label={ACCOUNT_WORDS.theme}
      data-slot="theme-menu"
      value={value}
      onValueChange={(next) => {
        if (isThemePreference(next)) onValueChange(next);
      }}
      className={cn('flex w-full', className)}
    >
      {THEME_CHOICES.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="flex-1">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
