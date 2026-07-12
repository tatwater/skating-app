import { sentryTanstackStart } from '@sentry/tanstackstart-react/vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * TanStack Start (Vite) config (D1/D27). Plugin order matters: Tailwind first, then the
 * Start plugin (which owns file-based routing + the server entry and generates
 * `src/routeTree.gen.ts`), then the React plugin. Deployed to Vercel (D27), which
 * auto-detects TanStack Start.
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
  : []

export default defineConfig({
  server: { port: 3000 },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), ...sentryPlugins],
})
