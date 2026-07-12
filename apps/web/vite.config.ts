import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * TanStack Start (Vite) config (D1/D27). Plugin order matters: Tailwind first, then the
 * Start plugin (which owns file-based routing + the server entry and generates
 * `src/routeTree.gen.ts`), then the React plugin. Deployed to Vercel (D27), which
 * auto-detects TanStack Start.
 */
export default defineConfig({
  server: { port: 3000 },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
