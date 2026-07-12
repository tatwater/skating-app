import { clerkMiddleware } from '@clerk/tanstack-react-start/server'
import { createStart } from '@tanstack/react-start'

/**
 * Server request middleware (D26). `clerkMiddleware()` reads the Clerk session on every
 * request and makes auth state available server-side (and to `<ClerkProvider>`), reading
 * `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` from the environment.
 */
export const startInstance = createStart(() => {
  return {
    requestMiddleware: [clerkMiddleware()],
  }
})
