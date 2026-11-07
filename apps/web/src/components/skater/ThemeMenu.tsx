import { isThemePreference, type ThemePreference } from '@skating/design';

import { cn } from '@/lib/utils';

import { ToggleGroup, ToggleGroupItem } from '../kit/toggle-group';

/**
 * The theme picker (board 3.24's Theme row; the phone menu sheet's three-way picker, 9.5): System ·
 * Light · Dark as the kit's joined segments, the chosen one filled. Props only — the avatar menu
 * hands it `useTheme()`'s preference and a setter that writes the cookie (D241) and records
 * `theme_changed`. The theme lives here and in the avatar menu, never in the top bar.
 */
export interface ThemeMenuProps {
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
  className?: string;
}

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeMenu({ value, onValueChange, className }: ThemeMenuProps) {
  return (
    <ToggleGroup
      aria-label="Theme"
      data-slot="theme-menu"
      value={value}
      onValueChange={(next) => {
        if (isThemePreference(next)) onValueChange(next);
      }}
      className={cn('flex w-full', className)}
    >
      {OPTIONS.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="flex-1">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
