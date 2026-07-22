/**
 * Convex auth providers (D26) — wires Clerk as the identity provider so
 * `ctx.auth.getUserIdentity()` validates Clerk-issued JWTs and exposes `subject`
 * (the Clerk user id we store as `profiles.clerkUserId`).
 *
 * `CLERK_JWT_ISSUER_DOMAIN` is the Clerk instance's Frontend API URL (e.g.
 * https://your-app.clerk.accounts.dev). Set it as a Convex deployment env var:
 *   npx convex env set CLERK_JWT_ISSUER_DOMAIN <url>
 * `applicationID: 'convex'` must match the Clerk JWT template named "convex".
 *
 * This file is deployment config, not a function module — it is excluded from
 * codegen's API and is exercised only against a live deployment (convex-test's
 * `withIdentity` bypasses JWT validation).
 */

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: 'convex',
    },
  ],
};
