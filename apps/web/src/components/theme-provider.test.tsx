import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_COOKIE } from '../lib/theme';
import { ThemeProvider, useTheme } from './theme-provider';

/**
 * The provider's contract (D241): the cookie is the store, the DOM gets `data-mode` + `.dark`,
 * and the hook keeps the next-themes shape consumers were written against.
 */

function Probe() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  return (
    <div>
      <output data-testid="theme">{theme}</output>
      <output data-testid="resolved">{resolvedTheme ?? 'pending'}</output>
      <button type="button" onClick={() => setTheme('dark')}>
        go dark
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        go system
      </button>
    </div>
  );
}

const clearCookie = () => {
  document.cookie = `${THEME_COOKIE}=; max-age=0`;
};

afterEach(() => {
  clearCookie();
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
});

describe('ThemeProvider', () => {
  it('reads the stored preference from the cookie on first render', () => {
    document.cookie = `${THEME_COOKIE}=dark`;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('defaults to system with no cookie, resolving by the OS (light under the test stub)', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
  });

  it('setTheme writes the cookie and applies data-mode plus the legacy class', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'go dark' }).click());

    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
  });

  it('returning to system deletes the cookie and removes data-mode', () => {
    document.cookie = `${THEME_COOKIE}=dark`;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'go system' }).click());

    expect(document.cookie).not.toContain(`${THEME_COOKIE}=dark`);
    expect(document.documentElement.hasAttribute('data-mode')).toBe(false);
    // Resolved follows the OS again — light under the shared matchMedia stub.
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('renders the init script ahead of the app content', () => {
    const { container } = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const script = container.querySelector('script');
    expect(script).not.toBeNull();
    expect(script?.textContent ?? script?.innerHTML).toContain(THEME_COOKIE);
  });
});
