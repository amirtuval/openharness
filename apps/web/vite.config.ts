import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// This file is typechecked by the app's own `tsconfig.json` — the browser program, with no
// `@types/node` — so the one Node global used here is declared rather than imported.
declare const process: { env: Record<string, string | undefined> }

const DEFAULT_PROXY_TARGET = 'http://localhost:3000'

/**
 * The dev server proxies `/v1` to the openharness server, so `yarn dev` can talk to a local
 * server on the same origin: no CORS, and no server URL in the settings.
 *
 * Point it somewhere else with the environment variable:
 *
 * ```bash
 * OPENHARNESS_PROXY_TARGET=http://localhost:8787 yarn dev
 * ```
 *
 * The proxy exists in `yarn dev` only. A production build is a static site: serve it from the
 * same origin as the API.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.OPENHARNESS_PROXY_TARGET ?? DEFAULT_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
})
