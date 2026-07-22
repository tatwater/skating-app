import { clerkMiddleware } from '@clerk/tanstack-react-start/server';
import {
  sentryGlobalFunctionMiddleware,
  sentryGlobalRequestMiddleware,
} from '@sentry/tanstackstart-react';
import { createStart } from '@tanstack/react-start';

/**
 * Server request middleware (D26/D29). `clerkMiddleware()` reads the Clerk session on every
 * request and makes auth state available server-side (and to `<ClerkProvider>`), reading
 * `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` from the environment.
 *
 * Sentry's global middlewares run *first* so every request (and server function) is isolated
 * into its own Sentry scope and traced end to end — they no-op safely until a DSN is
 * provisioned (see `instrument.server.ts`).
 */
export const startInstance = createStart(() => {
  return {
    requestMiddleware: [sentryGlobalRequestMiddleware, clerkMiddleware()],
    functionMiddleware: [sentryGlobalFunctionMiddleware],
  };
});
