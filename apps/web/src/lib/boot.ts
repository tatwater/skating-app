import type { AuthRoute } from '@skating/core';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

/**
 * The boot cookie — "this browser session has already started the app, and here is the zone it
 * landed in".
 *
 * The splash (8.10) is the *cold start*: the logo on the region while Clerk loads and the profile
 * query comes back. It is right once, and wrong every time after — a full-screen hold that wipes
 * the app away reads as a restart, not as a page loading, and every document load pays it
 * (SSR renders the splash for every route, because the server knows neither Clerk's state nor the
 * profile). So the second load onward shows the *shape of the page* instead: `BootScreen`, the
 * shell with its skeletons, handing over to the real page and its own skeletons when the gate
 * opens.
 *
 * Knowing "already started" has to survive a document load and be readable **on both sides** — the
 * server has to render the same thing the client hydrates, or React tears the tree down and the
 * flash is back. That is a cookie, as the theme is (D241, `lib/theme.ts`): the server reads it off
 * the request, the client off `document.cookie`, and both reach the same answer before first paint.
 *
 * It stores the resolved zone rather than a bare flag, because the shape to draw depends on it: a
 * signed-out visitor's next load is the sign-in screen, not the skater shell, and drawing the
 * skater shell at them would be exactly the "flash the wrong surface" the gate exists to prevent.
 *
 * **A session cookie** — no `max-age`, so it dies with the browser session. "First load of the
 * app" then means once per browser session, which is what the splash is for; a skater who comes
 * back tomorrow gets the cold start again, because for them it *is* one.
 */

export const BOOT_COOKIE = 'gli-boot';

/** A settled zone: every `AuthRoute` but `loading`, which is the absence of an answer. */
export type BootZone = Exclude<AuthRoute, 'loading'>;

const BOOT_ZONES: ReadonlySet<string> = new Set<BootZone>(['auth', 'onboarding', 'reack', 'app']);

export function isBootZone(value: string | undefined): value is BootZone {
  return value !== undefined && BOOT_ZONES.has(value);
}

/**
 * Reads the zone out of a `document.cookie`-shaped string. Tolerant of surrounding cookies and
 * whitespace; a missing or mangled cookie is `null` — "no previous boot", which is the cold start.
 */
export function readBootZoneFromCookie(cookies: string): BootZone | null {
  const value = cookies.match(new RegExp(`(?:^|;\\s*)${BOOT_COOKIE}=([^;]*)`))?.[1];
  return isBootZone(value) ? value : null;
}

/** The `document.cookie` assignment string for a zone. */
export function bootCookieString(zone: BootZone): string {
  return `${BOOT_COOKIE}=${zone}; path=/; samesite=lax`;
}

/**
 * The request's cookie, during SSR. The `.server()` half — and its server-only import — is what
 * the Start plugin strips from the client bundle; that is what `createIsomorphicFn` is for.
 */
const readRequestBootZone: () => BootZone | null = createIsomorphicFn()
  .server((): BootZone | null => {
    const value = getCookie(BOOT_COOKIE);
    return isBootZone(value) ? value : null;
  })
  .client((): BootZone | null => null);

/**
 * The zone this browser session last settled in, read wherever we are: off `document.cookie` in a
 * browser, off the request when rendering on the server. Both sides see one value for one
 * document, which is what keeps the first client render identical to the server's.
 *
 * The `document` check comes **first**, and not only as a convenience: untransformed — under
 * Vitest, which doesn't load the app's Vite plugins — `createIsomorphicFn` hands back the server
 * half, and asking a request for its cookies outside a request throws. A browser never needs to
 * ask, so it never gets there.
 */
export function readBootZone(): BootZone | null {
  if (typeof document !== 'undefined') return readBootZoneFromCookie(document.cookie);
  return readRequestBootZone();
}
