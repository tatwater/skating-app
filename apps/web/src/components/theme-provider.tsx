import { ThemeProvider as NextThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

/**
 * Two first-class themes (D34): high-contrast bright-outdoor (light) + evening (dark),
 * toggled via a `.dark` class on <html> (see `styles/app.css`). Defaults to the OS
 * preference (like mobile's `useColorScheme`) but the user can override with the toggle.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
