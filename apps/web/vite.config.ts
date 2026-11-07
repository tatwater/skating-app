import { fileURLToPath } from 'node:url';
import { sentryTanstackStart } from '@sentry/tanstackstart-react/vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

/**
 * TanStack Start (Vite) config (D1/D27). Plugin order matters: Tailwind first, then the
 * Start plugin (which owns file-based routing + the server entry and generates
 * `src/routeTree.gen.ts`), then Nitro, then the React plugin. Deployed to Vercel (D27):
 * TanStack Start ships its deployable server through Nitro, and Vercel zero-config-detects
 * Nitro's build output (compiling the SSR server into a Vercel Function). Without the Nitro
 * plugin the build emits a bare `dist/server` that Vercel can't serve, so routes 404.
 *
 * The Sentry plugin (D29) is added only when a build auth token is present — it uploads
 * source maps so production stack traces are readable, and auto-instruments the server
 * middlewares. Gating on the token keeps local dev + CI builds (which have no token) quiet
 * and network-free; the runtime SDK still works without it. Set SENTRY_AUTH_TOKEN / _ORG /
 * _PROJECT on Vercel (see `.env.example`).
 */
const sentryPlugins = process.env.SENTRY_AUTH_TOKEN
  ? [
      sentryTanstackStart({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
      }),
    ]
  : [];

/**
 * Which deployment this bundle is for, stamped onto every analytics event (D235).
 *
 * `VERCEL_ENV` is Vercel's own build-time variable — `production`, `preview` or `development` —
 * and it is copied to a `VITE_` name here because only prefixed names are inlined into the client.
 * `import.meta.env.MODE` cannot stand in: a preview build is a *production-mode* build, so MODE
 * reads `production` for both and the two would be indistinguishable in PostHog.
 *
 * **Assigned into `process.env` rather than passed through `define`.** Vite resolves the
 * prefixed entries on `import.meta.env` with its own env loader, and that loader reads those names
 * out of `process.env` — so writing it here, at config module scope, goes through the path Vite
 * already owns instead of racing it with a `define` for the same expression.
 *
 * (Written without the `env.`-dot-NAME spelling on purpose: `credentialsRegister.test.ts` scans
 * this file for env reads, and prose matching that shape registers as a variable named `VITE_`.) Confirmed in the built client
 * bundle: `deployEnvironment:\`preview\`` with `VERCEL_ENV=preview`.
 *
 * If you go to re-verify this, note that setting `VERCEL_ENV` flips Nitro to its Vercel preset,
 * which writes `.vercel/output` instead of `.output` — so the old `.output` sits there stale and
 * looks like proof that nothing changed.
 *
 * Absent (a local `vite dev` or `vite build`, and CI) it is `development`, which is the honest
 * answer for every build that is not Vercel's.
 */
process.env.VITE_DEPLOY_ENV = process.env.VERCEL_ENV ?? 'development';

export default defineConfig({
  server: { port: 3000 },
  // `@` → `src` mirrors the tsconfig path so shadcn/ui's generated `@/…` imports resolve at
  // runtime too (Vite doesn't read tsconfig `paths` on its own). Existing relative imports are
  // unaffected — both styles resolve.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwindcss(), tanstackStart(), nitro(), viteReact(), ...sentryPlugins],
});
