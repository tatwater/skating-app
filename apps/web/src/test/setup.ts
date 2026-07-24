import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no `matchMedia`; `next-themes` (and anything that reads a media query) calls it on mount.
// Stub a stable "no dark preference" matcher so themed components — the admin charts especially —
// render under test instead of throwing.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// We run Vitest without global injection (tests import describe/it/expect explicitly), so
// Testing Library's automatic afterEach cleanup doesn't self-register — do it here, or rendered
// trees leak across tests and duplicate-match queries.
afterEach(cleanup);
