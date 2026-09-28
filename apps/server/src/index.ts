import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { PACKAGE_NAME as BRAIN_PACKAGE_NAME } from '@openharness/brain'
import { PACKAGE_NAME as HANDS_PACKAGE_NAME } from '@openharness/hands'
import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'
import { PACKAGE_NAME as SESSION_PACKAGE_NAME } from '@openharness/session'
import { app } from './app'

export const PACKAGE_NAME = '@openharness/server'
export { app }

/**
 * Placeholder wiring: it proves that every allowed `@openharness/*` edge of this package
 * resolves through built output. It goes away in the v1 chat epic, together with the
 * placeholder exports of the packages listed here.
 */
export const WIRED_PACKAGES = [
  PROTOCOL_PACKAGE_NAME,
  SESSION_PACKAGE_NAME,
  BRAIN_PACKAGE_NAME,
  HANDS_PACKAGE_NAME,
] as const

const DEFAULT_PORT = 3000

/** Starts the HTTP server. Used by `node dist/index.js` and by e2e tests (later). */
export function startServer(port: number = Number(process.env['PORT'] ?? DEFAULT_PORT)) {
  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`${PACKAGE_NAME} listening on http://localhost:${info.port}`)
    console.log(`wired placeholders: ${WIRED_PACKAGES.join(', ')}`)
  })
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  startServer()
}
