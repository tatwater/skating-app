import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no `matchMedia`; the theme provider (and anything that reads a media query) calls it on mount.
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

// jsdom has no `ResizeObserver`; Recharts' `ResponsiveContainer` constructs one on mount. A no-op stub
// lets the admin charts mount under test — they render at a 0×0 measured size, which is fine because
// the DOM tests assert scaffolding (legend, table, empty states), not pixel geometry.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// We run Vitest without global injection (tests import describe/it/expect explicitly), so
// Testing Library's automatic afterEach cleanup doesn't self-register — do it here, or rendered
// trees leak across tests and duplicate-match queries.
afterEach(cleanup);

// `findBy*` and `waitFor` give up after 1 s by default. On CI the runner is load-starved (turbo runs
// every package at once), and a debounce plus a render has outrun that budget while being fast in
// isolation — the same race `testTimeout` in `vitest.config.ts` answers. A longer budget only lets
// a wait that would pass arrive; a wait that never passes still fails, inside the 20 s test cap.
configure({ asyncUtilTimeout: 5_000 });
